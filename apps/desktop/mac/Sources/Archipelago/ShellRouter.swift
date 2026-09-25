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
    // the rect a page panel has taken out of the surfaces, in page pixels
    private var cutout: WebRect?
    private var presses: Any?
    // whether the page has sent .connection since it last loaded, and what a banner click or answer sent before that
    private var listening = false
    private var pendingNotify: [FromShell] = []

    init(runtime: GhosttyRuntime, bridge: Bridge, container: NSView, webView: DropWebView) {
        self.runtime = runtime
        self.bridge = bridge
        self.container = container
        self.webView = webView
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

        notifier.onPermission = { [weak self] state in self?.bridge.send(.notifyPermission(state)) }
        notifier.onOpen = { [weak self] key in self?.open(key) }
        notifier.onAction = { [weak self] key, action, promptId in self?.sendNotify(.notifyAction(key: key, action: action, promptId: promptId)) }

        bridge.onMessage = { [weak self] msg in self?.handle(msg) }
        keys.onChord = { [weak self] chord in
            // the hatch out of a wedged page, except while a settings row is waiting for that very chord
            if chord == "cmd+shift+q", self?.keys.capturing != true { NSApp.terminate(nil); return }
            self?.bridge.send(.key(chord: chord))
        }
        keys.install()
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
        cutout = nil
        surfaces.setCutout(nil)
        browsers.setCutout(nil)
        keys.registered = []
        keys.capturing = false
        // the page that posted the banners is gone, and the one loading has no record of them
        notifier.clearAll()
        listening = false
        pendingNotify = []
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
            bridge.send(.shellInfo(home: ArchiHome.path, log: ArchiHome.logTail(), op: OnePassword.path != nil, ghosttyKeys: GhosttyKeybinds.userChords()))
            bridge.send(.connection(ArchiHome.connection()))
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
        case .openUrl(let url):
            ExternalURL.open(url)
        case .openFolder(let path):
            ExternalURL.openFolder(path)
        case .reveal(let path):
            ExternalURL.reveal(path)
        case .copy(let text):
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        case .openConfig(let which):
            guard let path = which == "ghostty" ? GhosttyRuntime.configPath() : ArchiHome.configPath() else { return }
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
        case .shellCutout(let rect):
            cutout = rect
            surfaces.setCutout(rect)
            browsers.setCutout(rect)
        case .notifyPost(let key, let title, let subtitle, let body, let sound, let actions, let promptId):
            notifier.post(key: key, title: title, subtitle: subtitle, body: body, sound: sound, actions: actions, promptId: promptId)
        case .notifyRemove(let key):
            notifier.remove(key: key)
        case .notifyEnable:
            notifier.enable()
        case .notifySettings:
            notifier.openSettings()
        case .quit:
            NSApp.terminate(nil)
        }
    }

    // a press the page can see is answered by the page's own listener, which knows the panel's own tab from
    // the rest of it; only a press the surfaces above the page swallow is reported here
    private func pressed(_ event: NSEvent) {
        guard cutout != nil, event.window === container.window else { return }
        let hit = container.hitTest(container.convert(event.locationInWindow, from: nil))
        if hit == nil || !hit!.isDescendant(of: webView) { bridge.send(.pressedAway) }
    }
}
