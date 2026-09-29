import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: DropWebView!
    private var router: ShellRouter?
    private var assets: WebAssets?
    private var pageCrashedAt: Date?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard SvallHome.claim() else { NSApp.terminate(nil); return }
        let runtime: GhosttyRuntime
        do { runtime = try GhosttyRuntime() } catch {
            let alert = NSAlert()
            alert.messageText = "The terminal could not start"
            alert.informativeText = "Ghostty failed to set up (\(error)), so Svall cannot open."
            NSApp.activate()
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        for e in runtime.configErrors { NSLog("ghostty config: %@", e) }

        let quitItem = buildMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.delegate = self
        window.title = SvallHome.displayName
        // the titlebar carries the page's own panel colour instead of the system chrome
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(srgbRed: 0x1E / 255, green: 0x2A / 255, blue: 0x38 / 255, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.center()
        window.setFrameAutosaveName(SvallHome.frameAutosaveName)
        let content = window.contentView!

        let config = WKWebViewConfiguration()
        let bridge = Bridge()
        config.userContentController.add(bridge, name: Bridge.handlerName)
        // every fleet's window shares one localStorage, so the page keys its settings by the fleet's home
        if let home = try? JSONEncoder().encode((SvallHome.path as NSString).standardizingPath), let json = String(data: home, encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: "window.__svallHome = \(json);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // a launch that named no fleet offers the others
        if SvallHome.bare {
            config.userContentController.addUserScript(WKUserScript(source: "window.__svallBare = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        if let dir = Bundle.main.resourceURL?.appendingPathComponent("web"), FileManager.default.fileExists(atPath: dir.path) {
            let assets = WebAssets(root: dir)
            self.assets = assets
            config.setURLSchemeHandler(assets, forURLScheme: WebAssets.scheme)
        }
#if DEBUG
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
#endif
        webView = DropWebView(frame: content.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        content.addSubview(webView)

        router = ShellRouter(runtime: runtime, bridge: bridge, container: content, webView: webView, quitItem: quitItem)

        var missingBundle = false
        if let url = Self.devURL {
            webView.load(URLRequest(url: url))
        } else if assets != nil {
            webView.load(URLRequest(url: WebAssets.start))
        } else {
            NSLog("no web bundle in %@ and no SVALL_DEV_URL", Bundle.main.resourceURL?.path ?? "")
            missingBundle = true
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate()

        // the alert comes after the window so a cold launch does not leave it behind another app
        if missingBundle {
            let alert = NSAlert()
            alert.messageText = "The web bundle is missing"
            alert.informativeText = "This build has no web/ folder in its Resources. Run pnpm desktop:install to add it."
            alert.runModal()
        }
    }

#if DEBUG
    private static let devURL = ProcessInfo.processInfo.environment["SVALL_DEV_URL"].flatMap { URL(string: $0) }
#else
    private static let devURL: URL? = nil
#endif

    // the page holds the daemon token and opens terminals, so it may only be the app's bundle or the dev server
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let own = url?.scheme == WebAssets.scheme && url?.host == WebAssets.start.host
        let dev = Self.devURL.map { url?.scheme == $0.scheme && url?.host == $0.host && url?.port == $0.port } ?? false
        if !own && !dev { NSLog("blocked navigation to %@", ExternalURL.redacted(url)) }
        decisionHandler(own || dev ? .allow : .cancel)
    }

    // the webview reloads on a dev-server restart; surfaces belong to the old page
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        router?.reset()
    }

    // a page whose process died, to memory pressure, a crash or a WebKit update, is loaded again
    // rather than leaving the terminals floating over a blank window; one that dies again soon after asks first
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("the page's web process ended")
        router?.reset()
        if let last = pageCrashedAt, Date().timeIntervalSince(last) < 30 {
            let alert = NSAlert()
            alert.messageText = "The page keeps crashing"
            alert.informativeText = "Its web process stopped again within 30 seconds of the last reload."
            alert.addButton(withTitle: "Reload")
            alert.addButton(withTitle: "Quit")
            NSApp.activate()
            if alert.runModal() != .alertFirstButtonReturn { return NSApp.terminate(nil) }
        }
        pageCrashedAt = Date()
        webView.reload()
    }

    // Edit menu key equivalents are what make copy/paste work in the webview's text fields.
    // Quit carries the chord the page quits with, which the router keeps current.
    private func buildMenu() -> NSMenuItem {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Svall", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Svall", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let quit = appMenu.addItem(withTitle: "Quit Svall", action: #selector(quit(_:)), keyEquivalent: "")
        quit.target = self
        appItem.submenu = appMenu

        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let file = NSMenu(title: "File")
        let openFleet = file.addItem(withTitle: "Open Fleet…", action: #selector(openFleets(_:)), keyEquivalent: "o")
        openFleet.keyEquivalentModifierMask = [.command, .shift]
        openFleet.target = self
        fileItem.submenu = file

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        // no ⌘M: the page toggles map and board with it
        let windowItem = NSMenuItem(); main.addItem(windowItem)
        let windows = NSMenu(title: "Window")
        windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "")
        windows.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windows.addItem(.separator())
        windows.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windows
        NSApp.windowsMenu = windows

        NSApp.mainMenu = main
        return quit
    }

    @objc private func openFleets(_ sender: Any?) {
        router?.showFleets()
    }

    @objc private func quit(_ sender: Any?) {
        if let router { router.quit() } else { NSApp.terminate(nil) }
    }

    // the one window is the app: closing it quits, through the same question as ⌘Q, so Cancel keeps it open
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        quit(sender)
        return false
    }

    // the page saves what it can and names what a quit would drop; a page that is not up is not waited on
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let router, router.askToQuit({ NSApp.reply(toApplicationShouldTerminate: $0) }) else { return .terminateNow }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        router?.closeAll()
        SvallHome.release()
    }
}
