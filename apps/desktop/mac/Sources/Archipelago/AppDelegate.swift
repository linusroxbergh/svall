import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: DropWebView!
    private var router: ShellRouter?
    private var assets: WebAssets?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard ArchiHome.claim() else { NSApp.terminate(nil); return }
        let runtime: GhosttyRuntime
        do { runtime = try GhosttyRuntime() } catch { fatalError("\(error)") }
        for e in runtime.configErrors { NSLog("ghostty config: %@", e) }

        buildMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = ArchiHome.displayName
        // the titlebar carries the page's own panel colour instead of the system chrome
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(srgbRed: 0x1E / 255, green: 0x2A / 255, blue: 0x38 / 255, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.center()
        window.setFrameAutosaveName(ArchiHome.frameAutosaveName)
        let content = window.contentView!

        let config = WKWebViewConfiguration()
        let bridge = Bridge()
        config.userContentController.add(bridge, name: Bridge.handlerName)
        // every fleet's window shares one localStorage, so the page keys its settings by the fleet's home
        if let home = try? JSONEncoder().encode((ArchiHome.path as NSString).standardizingPath), let json = String(data: home, encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: "window.__archiHome = \(json);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
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

        router = ShellRouter(runtime: runtime, bridge: bridge, container: content, webView: webView)

        var missingBundle = false
        if let url = Self.devURL {
            webView.load(URLRequest(url: url))
        } else if assets != nil {
            webView.load(URLRequest(url: WebAssets.start))
        } else {
            NSLog("no web bundle in %@ and no ARCHI_DEV_URL", Bundle.main.resourceURL?.path ?? "")
            missingBundle = true
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate()

        // the alert comes after the window so a cold launch does not leave it behind another app
        if missingBundle {
            let alert = NSAlert()
            alert.messageText = "The web bundle is missing"
            alert.informativeText = "This build has no web/ folder in its Resources. Run pnpm desktop:build to add it."
            alert.runModal()
        }
    }

#if DEBUG
    private static let devURL = ProcessInfo.processInfo.environment["ARCHI_DEV_URL"].flatMap { URL(string: $0) }
#else
    private static let devURL: URL? = nil
#endif

    // the page holds the daemon token and opens terminals, so it may only be the app's bundle or the dev server
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let own = url?.scheme == WebAssets.scheme && url?.host == WebAssets.start.host
        let dev = Self.devURL.map { url?.scheme == $0.scheme && url?.host == $0.host && url?.port == $0.port } ?? false
        if !own && !dev { NSLog("blocked navigation to %@", url?.absoluteString ?? "nil") }
        decisionHandler(own || dev ? .allow : .cancel)
    }

    // the webview reloads on a dev-server restart; surfaces belong to the old page
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        router?.reset()
    }

    // Edit menu key equivalents are what make copy/paste work in the webview's text fields.
    private func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        let quit = NSMenuItem(title: "Quit Archipelago", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.keyEquivalentModifierMask = [.command, .shift]
        appMenu.addItem(quit)
        appItem.submenu = appMenu

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
        NSApp.mainMenu = main
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        router?.closeAll()
        ArchiHome.release()
    }
}
