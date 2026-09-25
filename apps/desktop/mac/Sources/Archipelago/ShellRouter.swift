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
    // the handover helper the page follows; absent in a build with no archi beside it
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
    // where the page's answer goes while a quit waits on it, and what quits anyway if it never comes
    private var quitAnswer: ((Bool) -> Void)?
    private var quitTimeout: DispatchWorkItem?

    init(runtime: GhosttyRuntime, bridge: Bridge, container: NSView, webView: DropWebView, quitItem: NSMenuItem) {
        self.runtime = runtime
        self.bridge = bridge
        self.container = container
        self.webView = webView
        self.quitItem = quitItem
        surfaces = SurfaceManager(runtime: runtime, container: container, webView: webView)
        browsers = BrowserManager(container: container, webView: webView, storeFile: ArchiHome.path + "/browser-store")

        bridge.webView = webView
        webView.onDrag = { [weak self] m in self?.bridge.send(m) }

        surfaces.onExited = { [weak self] id in self?.bridge.send(.termExited(id: id)) }
        surfaces.onFailed = { [weak self] id, reason in self?.bridge.send(.termFailed(id: id, reason: reason)) }
        surfaces.onFocused = { [weak self] id in self?.bridge.send(.termFocused(id: id)) }
        surfaces.onOpenURL = { [weak self] id, url in self?.bridge.send(.termOpenUrl(id: id, url: url)) }

        browsers.onState = { [weak self] s in self?.bridge.send(.browserState(s)) }
        browsers.onOpened = { [weak self] from, tab, url in self?.bridge.send(.browserOpened(from: from, tab: tab, url: url)) }
        browsers.onClosed = { [weak self] tab in self?.bridge.send(.browserClosed(tab: tab)) }

        let helper = ControllerProcess.locate().map {
            ControllerProcess(executable: $0, arguments: ControllerProcess.connectArguments(profile: ArchiHome.profile))
        }
        remote = RemoteConnection(helper: helper, local: { ArchiHome.connection() })
        remote.onConnection = { [weak self] connection in
            guard self?.listening == true else { return }
            self?.bridge.send(.connection(connection))
        }
        remote.onState = { [weak self] state in
            self?.webView.window?.title = RemoteConnection.windowTitle(base: ArchiHome.displayName, owner: state.owner)
            guard self?.listening == true else { return }
            self?.bridge.send(.connectionState(state: state.state, owner: state.owner, kind: state.kind, message: state.message))
        }
        remote.onSurfaces = { [weak self] in self?.surfaces.rebuild() }
        surfaces.route = { [weak self] in self?.remote.route ?? .local }
        remote.start()

        handover = ControllerProcess.locate().map {
            HandoverSession(executable: $0, profile: ArchiHome.profile, eventsFile: ArchiHome.path + "/controller/events.ndjson")
        }
        handover?.onLine = { [weak self] line in self?.bridge.send(.handoverEvent(line.json)) }
        handover?.onReplay = { [weak self] lines in self?.bridge.send(.handoverReplay(lines.map(\.json))) }
        handover?.onExit = { [weak self] code, error in self?.bridge.send(.handoverExit(code: code, error: error)) }
        // the move is done: where the fleet runs now is asked afresh, rather than on the old helper's next tick
        handover?.onMoved = { [weak self] in
            guard let helper = ControllerProcess.locate() else { return }
            self?.remote.reconnect(with: ControllerProcess(executable: helper, arguments: ControllerProcess.connectArguments(profile: ArchiHome.profile)))
        }

        notifier.onPermission = { [weak self] state in self?.bridge.send(.notifyPermission(state)) }
        notifier.onOpen = { [weak self] key in self?.open(key) }
        notifier.onAction = { [weak self] key, action, promptId in self?.sendNotify(.notifyAction(key: key, action: action, promptId: promptId)) }

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
        // the page a quit was waiting on is gone, and nothing of it is left to save
        finishQuit(true)
    }

    /// Quits, unless a quit already waits on the page: AppKit takes a second terminate as a yes to the first.
    func quit() {
        if quitAnswer == nil { NSApp.terminate(nil) }
    }

    /// Asks the page to save its docs and name the files a quit would drop; false when no page is there to ask.
    func askToQuit(_ answer: @escaping (Bool) -> Void) -> Bool {
        guard listening, quitAnswer == nil else { return false }
        quitAnswer = answer
        // longer than the page gives its saves, so only a page that is stuck or gone runs it out
        let timeout = DispatchWorkItem { [weak self] in self?.finishQuit(true) }
        quitTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: timeout)
        bridge.send(.quitAsk)
        return true
    }

    private func finishQuit(_ ok: Bool) {
        guard let answer = quitAnswer else { return }
        quitAnswer = nil
        quitTimeout?.cancel()
        quitTimeout = nil
        answer(ok)
    }

    private func answerQuit(unsaved: [String]) {
        guard quitAnswer != nil else { return }
        quitTimeout?.cancel()
        guard !unsaved.isEmpty else { return finishQuit(true) }
        let alert = NSAlert()
        alert.messageText = "Quit with unsaved changes?"
        let names = unsaved.count > 4 ? unsaved.prefix(3).joined(separator: ", ") + " and \(unsaved.count - 3) more" : ListFormatter.localizedString(byJoining: unsaved)
        alert.informativeText = "\(names) \(unsaved.count == 1 ? "has" : "have") changes that were not saved. Quitting drops them."
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate()
        finishQuit(alert.runModal() == .alertFirstButtonReturn)
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
            bridge.send(.shellInfo(home: ArchiHome.path, log: ArchiHome.logTail(), op: OnePassword.path != nil,
                                   ghosttyKeys: GhosttyKeybinds.userChords(), handoverEnabled: ArchiHome.handoverEnabled(),
                                   gateway: ArchiHome.gatewayName()))
            bridge.send(.connection(remote.connection))
            if let state = remote.state {
                bridge.send(.connectionState(state: state.state, owner: state.owner, kind: state.kind, message: state.message))
            }
            sendAppActive()
            notifier.refreshPermission()
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
        case .quitAnswer(let unsaved):
            answerQuit(unsaved: unsaved)
        case .openUrl(let url):
            ExternalURL.open(url)
        case .openFolder(let path):
            guard isHere(path) else { return }
            ExternalURL.openFolder(path)
        case .reveal(let path):
            guard isHere(path) else { return }
            ExternalURL.reveal(path)
        case .copy(let text):
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        case .openConfig(let which):
            guard let path = which == "ghostty" ? GhosttyRuntime.configPath() : ArchiHome.configPath() else {
                NSLog("archi: no %@ config to open", which)
                return
            }
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
            guard let argv = HandoverCommand.start(to: to, choices: choices, gateway: ArchiHome.gatewayName(), profile: ArchiHome.profile) else {
                return bridge.send(.handoverExit(code: 1, error: "\(to) is not this Mac or this fleet's gateway, or these are not choices archi handover takes"))
            }
            followHandover { try $0.launch(argv) }
        case .handoverResume:
            followHandover { try $0.launch(HandoverCommand.resume(profile: ArchiHome.profile)) }
        case .handoverAbort:
            followHandover { try $0.launch(HandoverCommand.abort(profile: ArchiHome.profile)) }
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
        }
    }

    /// The page names an operation and its arguments; the argv, and the binary, are the shell's own.
    private func startHost(op: HostOp, args: HostArgs) {
        guard hostRun == nil else { return }
        let archi = ControllerProcess.locate()
        let fleet = ArchiHome.fleetProfile(of: ArchiHome.path, in: NSHomeDirectory())
        guard let executable = archi, let argv = HostCommand.arguments(op: op, args: args, fleet: fleet) else {
            let detail = archi == nil ? "this build has no archi beside it to set a machine up with"
                : op == .enable && fleet == nil ? "\(ArchiHome.path) is not a profile's home, so archi host enable cannot name it"
                : "these are not arguments archi host \(op.rawValue) takes"
            bridge.send(.hostStep(op: op.rawValue, step: HostProcess.Step(step: "archi", status: "fail", detail: detail, action: nil)))
            bridge.send(.hostDone(op: op.rawValue, code: 1))
            return
        }
        let child = HostProcess(executable: executable, arguments: argv, report: op.printsReport)
        hostRun = child
        child.onStep = { [weak self] step in self?.bridge.send(.hostStep(op: op.rawValue, step: step)) }
        child.onExit = { [weak self] code in
            self?.hostRun = nil
            self?.bridge.send(.hostDone(op: op.rawValue, code: code))
        }
        do { try child.start() } catch {
            hostRun = nil
            bridge.send(.hostStep(op: op.rawValue, step: HostProcess.Step(step: "archi", status: "fail", detail: "\(error)", action: nil)))
            bridge.send(.hostDone(op: op.rawValue, code: 1))
        }
    }

    private func followHandover(_ run: (HandoverSession) throws -> Void) {
        guard let handover else {
            return bridge.send(.handoverExit(code: 1, error: "this build has no archi beside it to hand the fleet over with"))
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
