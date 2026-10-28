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
    // one host operation at a time: the page watches this one until it ends or is cancelled
    private var hostRun: HostProcess?
    // `svall host list` for the Machines pane, and whether it was asked for again while it ran
    private var listing: LineChild?
    private var listAgain = false
    private let awake = KeepAwake()
    private var sentConfigErrors = false
    // whether a page panel holds a rect of the surfaces
    private var holding = false
    private var presses: Any?
    // whether the page has sent .connection since it last loaded
    private var listening = false
    private var pendingNotify: [FromShell] = []
    // since when the app has sat in the background or minimised, until its page is offered a fresh start
    private var awaySince: Date?
    private let quitItem: NSMenuItem
    private let menu: AppMenu
    private lazy var quitFlow = QuitFlow(send: { [weak self] in self?.bridge.send($0) }, isListening: { [weak self] in self?.listening ?? false },
                                         hideWindow: { [weak self] in self?.webView.window?.orderOut(nil) })

    init(runtime: GhosttyRuntime, bridge: Bridge, container: NSView, webView: DropWebView, quitItem: NSMenuItem, menu: AppMenu) {
        self.runtime = runtime
        self.bridge = bridge
        self.container = container
        self.webView = webView
        self.quitItem = quitItem
        self.menu = menu
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

        notifier.onPermission = { [weak self] state in self?.bridge.send(.notifyPermission(state)) }
        notifier.onOpen = { [weak self] key in self?.open(key) }
        notifier.onAction = { [weak self] key, action, promptId in self?.sendNotify(.notifyAction(key: key, action: action, promptId: promptId)) }
        Updates.shared.onWaiting = { [weak self] version in self?.bridge.send(.updateAvailable(version)) }
        Updates.shared.onQuit = { [weak self] in self?.quit(quietly: true) }

        bridge.onMessage = { [weak self] msg in self?.handle(msg) }
        menu.send = { [weak self] in self?.bridge.send($0) }
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
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.offerFreshPage() }
    }

    private func sendAppActive() {
        let active = NSApp.isActive && !(webView.window?.isMiniaturized ?? false)
        awaySince = active ? nil : awaySince ?? Date()
        bridge.send(.appActive(active))
    }

    // a web process past 1.2 GB, short of the 1.5 GB where WebKit flushes its caches every 30 s and stalls the page, gets
    // one offer of a fresh page per spell of five minutes away; the page turns it down while it holds unsaved work
    private func offerFreshPage() {
        guard let away = awaySince, away.timeIntervalSinceNow < -300, let footprint = webView.webContentFootprint, footprint > 1_200_000_000 else { return }
        awaySince = nil
        bridge.send(.memoryHigh)
    }

    /// Lets go of what belonged to the page that is leaving.
    func reset() {
        surfaces.closeAll()
        browsers.closeAll()
        holding = false
        surfaces.setCutout(rects: [], passive: [])
        browsers.setCutout(rects: [], passive: [])
        keys.registered = []
        keys.capturing = false
        setQuit(KeyMonitor.defaultQuit)
        menu.reset()
        notifier.clearAll()
        awake.release()
        listening = false
        quitFlow.pageGone()
    }

    /// Quits, unless a quit already waits.
    func quit(quietly: Bool = false) {
        quitFlow.quit(quietly: quietly)
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
        surfaces.closeAll()
        browsers.closeAll()
        browsers.dropDownloads()
        notifier.clearAll()
        awake.release()
    }

    private func open(_ key: String) {
        NSApp.activate()
        if let window = webView.window {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
        }
        sendNotify(.notifyOpen(key: key))
    }

    // a banner click or answer that arrives before the page listens (a relaunch, a reload) waits, or it would vanish
    private func sendNotify(_ message: FromShell) {
        if listening { bridge.send(message) } else { pendingNotify.append(message) }
    }

    private func handle(_ msg: ToShell) {
        switch msg {
        case .connection:
            // the daemon runs while the window is open: started with it, and again if it stops on its own
            if !quitFlow.stopping { FleetDaemon.start() }
            sendShellInfo()
            bridge.send(.connection(SvallHome.connection()))
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
        case .termShow(let id, let rect, let attach, let machine, let opacity):
            surfaces.show(id: id, rect: rect, attach: attach, machine: machine, opacity: opacity)
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
        case .menuState(let chords, let state):
            menu.show(chords: chords, state: state)
        case .menuFleets(let fleets, let note):
            menu.show(fleets: fleets, note: note)
        case .quitAnswer(let unsaved, let working, let placed):
            quitFlow.answered(unsaved: unsaved, working: working, placed: placed)
        case .quitStopped(let ok):
            quitFlow.stopped(ok: ok)
        case .openUrl(let url):
            ExternalURL.open(url)
        case .openFolder(let path):
            ExternalURL.openFolder(path)
        case .reveal(let path):
            ExternalURL.reveal(path)
        case .openFile(let path):
            ExternalURL.openFile(path)
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
        case .hostList:
            listMachines()
        case .shellCutout(let rects, let passive):
            holding = !rects.isEmpty || !passive.isEmpty
            surfaces.setCutout(rects: rects, passive: passive)
            browsers.setCutout(rects: rects, passive: passive)
        case .notifyPost(let key, let title, let body, let sound, let actions, let promptId):
            notifier.post(key: key, title: title, body: body, sound: sound, actions: actions, promptId: promptId)
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
            webView.window?.title = SvallHome.displayName
            awake.apply()
        case .awake(let reason):
            awake.hold(reason)
        }
    }

    private func openFleet(_ home: String, quit: Bool) {
        // the picker gives way to the fleet it opened without asking
        let done = { [weak self] in if quit { self?.quit(quietly: true) } }
        if let app = SvallHome.runningApp(of: home) {
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
        let svall = BundledSvall.locate()
        guard let executable = svall, let argv = HostCommand.arguments(op: op, args: args) else {
            let detail = svall == nil ? "this build has no svall beside it to set a machine up with"
                : "these are not arguments svall host \(op.rawValue) takes"
            bridge.send(.hostStep(op: op.rawValue, step: HostProcess.Step(step: "svall", status: "fail", detail: detail, action: nil)))
            bridge.send(.hostDone(op: op.rawValue, code: 1))
            return
        }
        let child = HostProcess(executable: executable, arguments: argv)
        hostRun = child
        child.onStep = { [weak self] step in self?.bridge.send(.hostStep(op: op.rawValue, step: step)) }
        child.onExit = { [weak self] code in
            self?.hostRun = nil
            self?.bridge.send(.hostDone(op: op.rawValue, code: code))
            self?.listMachines()
        }
        do { try child.start() } catch {
            hostRun = nil
            bridge.send(.hostStep(op: op.rawValue, step: HostProcess.Step(step: "svall", status: "fail", detail: "\(error)", action: nil)))
            bridge.send(.hostDone(op: op.rawValue, code: 1))
        }
    }

    private func listMachines() {
        if listing != nil { listAgain = true; return }
        guard let executable = BundledSvall.locate() else {
            return bridge.send(.hostMachines(machines: [], error: "this build has no svall beside it to list machines with"))
        }
        let child = LineChild(executable: executable, arguments: ["host", "list", "--json"])
        var text = ""
        child.onLine = { text += $0 + "\n" }
        child.onExit = { [weak self] code, stderr in
            guard let self else { return }
            listing = nil
            let rows = code == 0 ? (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [[String: Any]] : nil
            bridge.send(.hostMachines(machines: rows ?? [], error: rows == nil ? stderr.last ?? "svall host list exited with code \(code)" : nil))
            if listAgain { listAgain = false; listMachines() }
        }
        listing = child
        do { try child.start() } catch {
            listing = nil
            bridge.send(.hostMachines(machines: [], error: "\(error)"))
        }
    }

    private func sendShellInfo() {
        bridge.send(.shellInfo(home: SvallHome.path, log: SvallHome.logTail(), op: OnePassword.path != nil,
                               ghosttyKeys: GhosttyKeybinds.userChords(), profile: SvallHome.profile))
    }

    private func pressed(_ event: NSEvent) {
        guard holding, event.window === container.window else { return }
        let hit = container.hitTest(container.convert(event.locationInWindow, from: nil))
        if hit == nil || !hit!.isDescendant(of: webView) { bridge.send(.pressedAway) }
    }
}

private extension WKWebView {
    /// The physical footprint of the page's web process, found through WebKit's private accessor for its pid.
    var webContentFootprint: UInt64? {
        let key = "_webProcessIdentifier"
        guard responds(to: Selector((key))), let pid = value(forKey: key) as? pid_t, pid > 0 else { return nil }
        var info = rusage_info_v4()
        let ok = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) } }
        return ok == 0 ? info.ri_phys_footprint : nil
    }
}
