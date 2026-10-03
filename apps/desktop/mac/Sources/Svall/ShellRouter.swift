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
    private var sentConfigErrors = false
    // whether a page panel holds a rect of the surfaces
    private var holding = false
    private var presses: Any?
    // whether the page has sent .connection since it last loaded, and what a banner click or answer sent before that
    private var listening = false
    private var pendingNotify: [FromShell] = []
    // the menu's Quit, which shows the chord the page quits with
    private let quitItem: NSMenuItem
    private lazy var quitFlow = QuitFlow(send: { [weak self] in self?.bridge.send($0) }, isListening: { [weak self] in self?.listening ?? false },
                                         hideWindow: { [weak self] in self?.webView.window?.orderOut(nil) })

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
            bridge.send(.shellInfo(home: SvallHome.path, log: SvallHome.logTail(), op: OnePassword.path != nil, ghosttyKeys: GhosttyKeybinds.userChords()))
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
            ExternalURL.openFolder(path)
        case .reveal(let path):
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
            guard let path = which == "ghostty" ? GhosttyRuntime.configPath() : SvallHome.configPath() else { return }
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
            webView.window?.title = SvallHome.displayName
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

    // a press the page can see is answered by the page's own listener, which knows the panel's own tab from
    // the rest of it; only a press the surfaces above the page swallow is reported here
    private func pressed(_ event: NSEvent) {
        guard holding, event.window === container.window else { return }
        let hit = container.hitTest(container.convert(event.locationInWindow, from: nil))
        if hit == nil || !hit!.isDescendant(of: webView) { bridge.send(.pressedAway) }
    }
}
