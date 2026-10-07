import AppKit
import WebKit

/// Carries the page's messages to the terminals, the browser tabs and the chords, and their events back to the page.
final class ShellRouter {
    private let runtime: GhosttyRuntime
    private let bridge: Bridge
    private unowned let container: NSView
    private unowned let webView: DropWebView
    private let surfaces: SurfaceManager
    private let browsers: BrowserManager
    private let keys = KeyMonitor()
    private let notifier = Notifier()
    private var remote: RemoteConnection!
    // one host operation at a time: the page watches this one until it ends or is cancelled
    private var hostRun: HostProcess?
    // the handover helper the page follows; absent in a build with no svall beside it
    private var handover: HandoverSession?
    private var sentConfigErrors = false
    // whether a page panel holds a rect of the surfaces
    private var holding = false
    private var presses: Any?
    // whether the page has sent .connection since it last loaded, and what a banner click or answer sent before that;
    // before it has, a token would be sent into nothing
    private var listening = false
    private var pendingNotify: [FromShell] = []
    // the menu's Quit, which shows the chord the page quits with
    private let quitItem: NSMenuItem
    private lazy var quitFlow = QuitFlow(send: { [weak self] in self?.bridge.send($0) }, isListening: { [weak self] in self?.listening ?? false },
                                         hideWindow: { [weak self] in self?.webView.window?.orderOut(nil) },
                                         elsewhere: { [weak self] in
                                             guard let route = self?.remote.route, case .remote = route else { return false }
                                             return true
                                         },
                                         handoverOpen: { [weak self] in self?.handover?.isFollowing == true || SvallHome.handoverOpen() })

    init(runtime: GhosttyRuntime, bridge: Bridge, container: NSView, webView: DropWebView, quitItem: NSMenuItem) {
        self.runtime = runtime
        self.bridge = bridge
        self.container = container
        self.webView = webView
        self.quitItem = quitItem
        surfaces = SurfaceManager(runtime: runtime, container: container, webView: webView)
        browsers = BrowserManager(container: container, webView: webView, storeFile: SvallHome.path + "/browser-store")

        bridge.webView = webView
        webView.onDrag = { [weak self] m in self?.bridge.send(m) }

        surfaces.onExited = { [weak self] id in self?.bridge.send(.termExited(id: id)) }
        surfaces.onFailed = { [weak self] id, reason in self?.bridge.send(.termFailed(id: id, reason: reason)) }
        surfaces.onFocused = { [weak self] id in self?.bridge.send(.termFocused(id: id)) }
        // the page asks where the link opens, beside the pointer that followed it
        surfaces.onOpenURL = { [weak self] id, url in
            guard let self else { return }
            let (x, y) = self.webView.webPoint(self.webView.window?.mouseLocationOutsideOfEventStream ?? .zero)
            self.bridge.send(.termOpenUrl(id: id, url: url, x: x, y: y))
        }

        browsers.onState = { [weak self] s in self?.bridge.send(.browserState(s)) }
        browsers.onOpened = { [weak self] from, tab, url in self?.bridge.send(.browserOpened(from: from, tab: tab, url: url)) }
        browsers.onClosed = { [weak self] tab in self?.bridge.send(.browserClosed(tab: tab)) }

        let helper = ControllerProcess.locate().map {
            ControllerProcess(executable: $0, arguments: ControllerProcess.connectArguments(profile: SvallHome.profile))
        }
        remote = RemoteConnection(helper: helper, local: { SvallHome.connection() }, localOnly: { !SvallHome.namesGateway() })
        remote.onConnection = { [weak self] connection in
            guard self?.listening == true else { return }
            self?.bridge.send(.connection(connection))
        }
        remote.onState = { [weak self] state in
            self?.webView.window?.title = RemoteConnection.windowTitle(base: SvallHome.displayName, owner: state.owner)
            guard self?.listening == true else { return }
            self?.bridge.send(.connectionState(state: state.state, owner: state.owner, kind: state.kind, message: state.message))
        }
        remote.onSurfaces = { [weak self] in self?.surfaces.rebuild() }
        surfaces.route = { [weak self] in self?.remote.route ?? .local }
        remote.start()

        handover = ControllerProcess.locate().map {
            HandoverSession(executable: $0, profile: SvallHome.profile, eventsFile: SvallHome.path + "/controller/events.ndjson")
        }
        handover?.onLine = { [weak self] line in self?.bridge.send(.handoverEvent(line.json)) }
        handover?.onReplay = { [weak self] lines in self?.bridge.send(.handoverReplay(lines.map(\.json))) }
        handover?.onExit = { [weak self] code, error in self?.bridge.send(.handoverExit(code: code, error: error)) }
        // the move is done: where the fleet runs now is asked afresh, rather than on the old helper's next tick
        handover?.onMoved = { [weak self] in
            guard let helper = ControllerProcess.locate() else { return }
            self?.remote.reconnect(with: ControllerProcess(executable: helper, arguments: ControllerProcess.connectArguments(profile: SvallHome.profile)))
        }

        notifier.onPermission = { [weak self] state in self?.bridge.send(.notifyPermission(state)) }
        notifier.onOpen = { [weak self] key in self?.open(key) }
        notifier.onAction = { [weak self] key, action, promptId in self?.sendNotify(.notifyAction(key: key, action: action, promptId: promptId)) }
        Updates.shared.onWaiting = { [weak self] version in self?.bridge.send(.updateAvailable(version)) }

        bridge.onMessage = { [weak self] msg in self?.handle(msg) }
        keys.onChord = { [weak self] chord in
            guard let self else { return }
            // quitting is the shell's own, so it works on a wedged page, except while a settings row waits for that very chord
            if chord == self.keys.quit, !self.keys.capturing { self.quit(); return }
            self.bridge.send(.key(chord: chord))
        }
        keys.install(in: container.window)
        setQuit(KeyMonitor.defaultQuit)
        // a press that lands on a surface never reaches the page, so a panel drawn over one is told of it here
        presses = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            self?.pressed(event)
            return event
        }

        let center = NotificationCenter.default
        // a change made in System Settings shows as soon as the app is in front again
        center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.sendAppActive()
            self?.notifier.refreshPermission()
        }
        center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.sendAppActive() }
        center.addObserver(forName: NSWindow.didMiniaturizeNotification, object: webView.window, queue: .main) { [weak self] _ in self?.sendAppActive() }
        center.addObserver(forName: NSWindow.didDeminiaturizeNotification, object: webView.window, queue: .main) { [weak self] _ in self?.sendAppActive() }
        // a minimised, hidden or covered window's terminals stop drawing, as Ghostty's own do
        center.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: webView.window, queue: .main) { [weak self] note in
            guard let window = note.object as? NSWindow else { return }
            self?.surfaces.setWindowVisible(window.occlusionState.contains(.visible))
        }
    }

    // the app counts as in front only while its window isn't sitting minimised in the Dock
    private func sendAppActive() {
        bridge.send(.appActive(NSApp.isActive && !(webView.window?.isMiniaturized ?? false)))
    }

    /// Lets go of what belonged to the page that is leaving.
    func reset() {
        surfaces.closeAll()
        browsers.closeAll()
        // the panel that asked for the hole is gone with the page, and a new one asks again
        holding = false
        surfaces.setCutout(rects: [], passive: [])
        browsers.setCutout(rects: [], passive: [])
        keys.registered = []
        keys.capturing = false
        setQuit(KeyMonitor.defaultQuit)
        // the page that posted the banners is gone, and the one loading has no record of them
        notifier.clearAll()
        listening = false
        pendingNotify = []
        quitFlow.pageGone()
    }

    /// Quits, unless a quit already waits on the page: AppKit takes a second terminate as a yes to the first.
    func quit() {
        if !quitFlow.pending { NSApp.terminate(nil) }
    }

    func askToQuit(confirm: Bool, _ answer: @escaping (Bool) -> Void) -> NSApplication.TerminateReply {
        quitFlow.ask(confirm: confirm, answer: answer)
    }

    // the page names the chord it quits with, for the menu and for the monitor that takes it on a stuck page
    private func setQuit(_ chord: String?) {
        keys.quit = chord
        let (key, mods) = KeyMonitor.keyEquivalent(for: chord)
        quitItem.keyEquivalent = key
        quitItem.keyEquivalentModifierMask = mods
    }

    func closeAll() {
        hostRun?.cancel()
        // the helper goes on without the app: only the attach following it ends
        handover?.stop()
        remote.stop()
        surfaces.closeAll()
        browsers.closeAll()
        browsers.dropDownloads()
        notifier.clearAll()
    }

    // a banner's click brings this fleet's window up, restored if it sat in the Dock
    private func open(_ key: String) {
        NSApp.activate()
        if let window = webView.window {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
        }
        sendNotify(.notifyOpen(key: key))
    }

    // holds a banner click or answer until the page has said it is listening, since one that arrives before
    // that (a relaunch, a reload) would otherwise vanish into an unloaded page
    private func sendNotify(_ message: FromShell) {
        if listening { bridge.send(message) } else { pendingNotify.append(message) }
    }

    private func handle(_ msg: ToShell) {
        switch msg {
        case .connection:
            // the daemon runs while the window is open: started with it, and again if it stops on its own
            if !quitFlow.stopping { FleetDaemon.start() }
            sendShellInfo()
            bridge.send(.connection(remote.connection))
            if let state = remote.state {
                bridge.send(.connectionState(state: state.state, owner: state.owner, kind: state.kind, message: state.message))
            }
            sendAppActive()
            notifier.refreshPermission()
            bridge.send(.updateAvailable(Updates.shared.waiting))
            if !sentConfigErrors, !runtime.configErrors.isEmpty {
                sentConfigErrors = true
                bridge.send(.ghosttyConfigErrors(runtime.configErrors))
            }
            listening = true
            let queued = pendingNotify
            pendingNotify = []
            for message in queued { bridge.send(message) }
        case .termShow(let id, let rect, let attach, let opacity):
            surfaces.show(id: id, rect: rect, attach: attach, opacity: opacity)
        case .termMove(let id, let rect):
            surfaces.move(id: id, rect: rect)
        case .termHide(let id):
            surfaces.hide(id: id)
        case .termClose(let id):
            surfaces.close(id: id)
        case .termFocus(let id):
            surfaces.focus(id: id)
        case .keysRegister(let chords):
            keys.registered = Set(chords)
        case .keysCapture(let on):
            keys.capturing = on
        case .keysQuit(let chord):
            setQuit(chord)
        case .quitAnswer(let unsaved, let working):
            quitFlow.answered(unsaved: unsaved, working: working)
        case .quitStopped(let ok):
            quitFlow.stopped(ok: ok)
        case .openUrl(let url):
            ExternalURL.open(url)
        case .openFolder(let path):
            guard isHere(path) else { return }
            ExternalURL.openFolder(path)
        case .reveal(let path):
            guard isHere(path) else { return }
            ExternalURL.reveal(path)
        case .setupPlan:
            AppRuntime.run(["setup", "--plan", "--login-shell"]) { [weak self] ok, text in self?.bridge.send(.setupResult(step: "plan", ok: ok, json: text)) }
        case .folderPick(let start):
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.canCreateDirectories = true
            panel.prompt = "Choose"
            // a suggested folder setup has yet to make opens on the folder it would go in
            var dir = URL(fileURLWithPath: (start as NSString).expandingTildeInPath)
            if !FileManager.default.fileExists(atPath: dir.path) { dir = dir.deletingLastPathComponent() }
            panel.directoryURL = dir
            panel.begin { [weak self] response in
                guard response == .OK, let url = panel.url else { return }
                self?.bridge.send(.folderPicked(path: (url.path as NSString).abbreviatingWithTildeInPath))
            }
        case .setupRun(let agents, let found, let projects):
            AppRuntime.run(["setup", "--json", "--login-shell", "--agents", agents.joined(separator: ","), "--found", found.joined(separator: ","), "--projects", projects]) { [weak self] ok, text in
                // the home setup made did not exist when launch claimed it and named its browser store
                if ok {
                    _ = SvallHome.claim()
                    let file = SvallHome.path + "/browser-store"
                    if let id = self?.browsers.store.identifier, !FileManager.default.fileExists(atPath: file) {
                        try? id.uuidString.write(toFile: file, atomically: true, encoding: .utf8)
                    }
                }
                self?.bridge.send(.setupResult(step: "run", ok: ok, json: text))
            }
        case .copy(let text):
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        case .openConfig(let which):
            guard let path = which == "ghostty" ? GhosttyRuntime.configPath() : SvallHome.configPath() else {
                NSLog("svall: no %@ config to open", which)
                return
            }
            if let notice = remote.notice(forConfig: which, at: path) { return bridge.send(.notice(text: notice)) }
            ExternalURL.openText(path)
        case .zoom(let factor, let fontDelta):
            // the page lays itself out again at the new size and restates every terminal's rect from there
            webView.pageZoom = factor
            surfaces.setZoom(factor, fontDelta: fontDelta)
            browsers.setZoom(factor)
        case .browserShow(let tab, let rect, let url, let focus):
            browsers.show(tab: tab, rect: rect, url: url, focus: focus ?? true)
        case .browserMove(let tab, let rect):
            browsers.move(tab: tab, rect: rect)
        case .browserHide(let tab):
            browsers.hide(tab: tab)
        case .browserClose(let tab):
            browsers.close(tab: tab)
        case .browserLoad(let tab, let url):
            browsers.load(tab: tab, url: url)
        case .browserGo(let tab, let action):
            browsers.go(tab: tab, action: action)
        case .browserImportCookies:
            browsers.importChromeCookies()
        case .browserFill(let tab):
            browsers.fillLogin(tab: tab)
        case .browserFocus(let tab):
            browsers.focus(tab: tab)
        case .hostStart(let op, let args):
            startHost(op: op, args: args)
        case .hostCancel:
            hostRun?.cancel()
        case .handoverStart(let to, let choices):
            guard let argv = HandoverCommand.start(to: to, choices: choices, gateway: SvallHome.gatewayName(), profile: SvallHome.profile) else {
                return bridge.send(.handoverExit(code: 1, error: "\(to) is not this Mac or this fleet's gateway, or these are not choices svall handover takes"))
            }
            followHandover { try $0.launch(argv) }
        case .handoverResume:
            followHandover { try $0.launch(HandoverCommand.resume(profile: SvallHome.profile)) }
        case .handoverAbort:
            followHandover { try $0.launch(HandoverCommand.abort(profile: SvallHome.profile)) }
        case .handoverAttach:
            followHandover { try $0.observe() }
        case .handoverForget:
            followHandover { try $0.forget() }
        case .handoverChoose(let choices):
            handover?.send(.choose(choices))
        case .handoverCancel:
            handover?.send(.cancel)
        case .shellCutout(let rects, let passive):
            holding = !rects.isEmpty || !passive.isEmpty
            surfaces.setCutout(rects: rects, passive: passive)
            browsers.setCutout(rects: rects, passive: passive)
        case .notifyPost(let key, let title, let subtitle, let body, let sound, let actions, let promptId):
            notifier.post(key: key, title: title, subtitle: subtitle, body: body, sound: sound, actions: actions, promptId: promptId)
        case .notifyRemove(let key):
            notifier.remove(key: key)
        case .notifyEnable:
            notifier.enable()
        case .notifySettings:
            notifier.openSettings()
        case .updateInstall:
            Updates.shared.install()
        case .openFleet(let home, let quit):
            openFleet(home, quit: quit ?? false)
        case .retitle:
            webView.window?.title = RemoteConnection.windowTitle(base: SvallHome.displayName, owner: remote.state?.owner ?? "local")
        }
    }

    /// The menu's Open Fleet…, which the page answers with its picker.
    func showFleets() {
        bridge.send(.fleets)
    }

    // a fleet whose window is open is brought up; any other opens in a new instance of this app
    private func openFleet(_ home: String, quit: Bool) {
        // the picker gives way to the fleet it opened without asking
        let done = { [weak self] in if quit, self?.quitFlow.pending != true { NSApp.terminateQuietly() } }
        if let pid = SvallHome.appPid(of: home), let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == Bundle.main.bundleIdentifier {
            app.activate()
            return done()
        }
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        config.environment = ["SVALL_HOME": home]
        if quit, Updates.shared.running { config.environment[Updates.handoff] = "1" }
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { [weak self] _, error in
            DispatchQueue.main.async {
                if let error { self?.bridge.send(.openFleetFailed(home: home, reason: error.localizedDescription)) } else { done() }
            }
        }
    }

    /// The page names an operation and its arguments; the argv, and the binary, are the shell's own.
    private func startHost(op: HostOp, args: HostArgs) {
        guard hostRun == nil else { return }
        let svall = ControllerProcess.locate()
        let fleet = SvallHome.fleetProfile(of: SvallHome.path, in: NSHomeDirectory())
        guard let executable = svall, let argv = HostCommand.arguments(op: op, args: args, fleet: fleet) else {
            let detail = svall == nil ? "this build has no svall beside it to set a machine up with"
                : op == .enable && fleet == nil ? "\(SvallHome.path) is not a profile's home, so svall host enable cannot name it"
                : "these are not arguments svall host \(op.rawValue) takes"
            bridge.send(.hostStep(op: op.rawValue, step: HostProcess.Step(step: "svall", status: "fail", detail: detail, action: nil)))
            bridge.send(.hostDone(op: op.rawValue, code: 1))
            return
        }
        let child = HostProcess(executable: executable, arguments: argv, report: op.printsReport)
        hostRun = child
        child.onStep = { [weak self] step in self?.bridge.send(.hostStep(op: op.rawValue, step: step)) }
        child.onExit = { [weak self] code in
            self?.hostRun = nil
            self?.bridge.send(.hostDone(op: op.rawValue, code: code))
            if op.rewritesFleetConfig { self?.sendShellInfo() }
        }
        do { try child.start() } catch {
            hostRun = nil
            bridge.send(.hostStep(op: op.rawValue, step: HostProcess.Step(step: "svall", status: "fail", detail: "\(error)", action: nil)))
            bridge.send(.hostDone(op: op.rawValue, code: 1))
        }
    }

    // read afresh each time: the gateway and handover.enabled change when svall host rewrites fleet.json
    private func sendShellInfo() {
        bridge.send(.shellInfo(home: SvallHome.path, log: SvallHome.logTail(), op: OnePassword.path != nil,
                               ghosttyKeys: GhosttyKeybinds.userChords(), handoverEnabled: SvallHome.handoverEnabled(),
                               gateway: SvallHome.gatewayName()))
    }

    private func followHandover(_ run: (HandoverSession) throws -> Void) {
        guard let handover else {
            return bridge.send(.handoverExit(code: 1, error: "this build has no svall beside it to hand the fleet over with"))
        }
        do { try run(handover) } catch { bridge.send(.handoverExit(code: 1, error: "\(error)")) }
    }

    private func isHere(_ path: String) -> Bool {
        guard let notice = remote.notice(forOpening: path) else { return true }
        bridge.send(.notice(text: notice))
        return false
    }

    // a press the page can see is answered by the page's own listener, which knows the panel's own tab from
    // the rest of it; only a press the surfaces above the page swallow is reported here
    private func pressed(_ event: NSEvent) {
        guard holding, event.window === container.window else { return }
        let hit = container.hitTest(container.convert(event.locationInWindow, from: nil))
        if hit == nil || !hit!.isDescendant(of: webView) { bridge.send(.pressedAway) }
    }
}
