import AppKit
import WebKit

/// Creates, positions, hides and frees one BrowserView per tab id, above the webview. Every tab of a fleet shares
/// one persistent data store, so one Google sign-in serves every character.
final class BrowserManager: NSObject, WKUIDelegate, WKNavigationDelegate {
    let overlay: OverlayViews<BrowserView>
    let store: WKWebsiteDataStore
    var onState: (BrowserState) -> Void = { _ in }
    var onOpened: (_ from: String, _ tab: String, _ url: String) -> Void = { _, _, _ in }
    var onClosed: (_ tab: String) -> Void = { _ in }
    // where each download in flight is being written
    var downloads: [WKDownload: URL] = [:]

    init(container: NSView, webView: NSView, storeFile: String) {
        overlay = OverlayViews(container: container, webView: webView)
        store = Self.dataStore(file: storeFile)
        super.init()
    }

    // the store's UUID is kept beside the fleet's state, so the same cookies come back after a relaunch.
    // WebKit raises on the all-zero UUID, so a file holding one mints a store instead. A store whose id could not
    // be written stays the fleet's own for this launch; the shared default store would sign every fleet in as one
    private static func dataStore(file: String) -> WKWebsiteDataStore {
        if let text = try? String(contentsOfFile: file, encoding: .utf8),
           let id = UUID(uuidString: text.trimmingCharacters(in: .whitespacesAndNewlines)),
           id.uuidString != "00000000-0000-0000-0000-000000000000" {
            return WKWebsiteDataStore(forIdentifier: id)
        }
        let id = UUID()
        do { try id.uuidString.write(toFile: file, atomically: true, encoding: .utf8) }
        catch { NSLog("browser: cannot write %@: %@", file, "\(error)") }
        return WKWebsiteDataStore(forIdentifier: id)
    }

    // WebKit's own user agent lacks the Safari suffix, which Google reads as an embedded view
    private static let safariSuffix: String = {
        let plist = "/Applications/Safari.app/Contents/Info.plist"
        let version = (NSDictionary(contentsOfFile: plist)?["CFBundleShortVersionString"] as? String) ?? "26.0"
        return "Version/\(version) Safari/605.1.15"
    }()

    private func configuration() -> WKWebViewConfiguration {
        let c = WKWebViewConfiguration()
        c.websiteDataStore = store
        c.applicationNameForUserAgent = Self.safariSuffix
        c.preferences.isElementFullscreenEnabled = true
        return c
    }

    private func make(tab: String, configuration: WKWebViewConfiguration) -> BrowserView {
        close(tab: tab)
        let v = BrowserView(tab: tab, configuration: configuration)
        v.uiDelegate = self
        v.navigationDelegate = self
        v.pageZoom = overlay.zoom
        v.onState = { [weak self] s in self?.onState(s) }
        overlay.add(v, as: tab)
        return v
    }

    func setZoom(_ factor: Double) {
        overlay.setZoom(factor)
        for v in overlay.views.values { v.pageZoom = factor }
    }

    func setCutout(rects: [WebRect], passive: [WebRect]) {
        overlay.setCutout(rects: rects, passive: passive)
    }

    func show(tab: String, rect: WebRect, url: String?, focus: Bool) {
        let v: BrowserView
        if let existing = overlay[tab] {
            v = existing
        } else {
            // a url WebKit cannot parse still gets its view, so the address bar can put another in its place
            guard let url else { return }
            v = make(tab: tab, configuration: configuration())
            if let target = URL(string: url) { v.load(URLRequest(url: target)) }
        }
        overlay.place(v, rect)
        v.isHidden = false
        if focus { v.takeKeys() }
    }

    func move(tab: String, rect: WebRect) {
        overlay.move(tab, rect: rect)
    }

    func focus(tab: String) {
        guard let v = overlay[tab], !v.isHidden else { return }
        v.takeKeys()
    }

    func hide(tab: String) {
        overlay.hide(tab)
    }

    func close(tab: String) {
        overlay.close(tab)
    }

    func load(tab: String, url: String) {
        guard let v = overlay[tab], let target = URL(string: url) else { return }
        v.dismissDialogs()
        v.load(URLRequest(url: target))
    }

    func go(tab: String, action: String) {
        guard let v = overlay[tab] else { return }
        v.dismissDialogs()
        switch action {
        case "back": v.goBack()
        case "forward": v.goForward()
        case "reload": v.reload()
        default: break
        }
    }

    func closeAll() {
        overlay.closeAll()
    }

    // MARK: navigation

    // a tab's main frame follows the web and its own blobs, and the blank page a popup starts on; a mailto is
    // offered to the user's mail app and anything else, javascript: among it, is refused. a subframe is the page's own
    // business, srcdoc and data urls among it
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if navigationAction.targetFrame?.isMainFrame != true { return decisionHandler(.allow) }
        let url = navigationAction.request.url
        let scheme = url?.scheme?.lowercased() ?? ""
        // a link marked download is saved rather than shown; a frame's opens in the frame
        if navigationAction.shouldPerformDownload, ["http", "https", "blob", "data"].contains(scheme) { return decisionHandler(.download) }
        if ["http", "https", "blob"].contains(scheme) || url?.absoluteString == "about:blank" {
            return decisionHandler(.allow)
        }
        if scheme == "mailto", let url {
            mail(url, from: webView)
        } else {
            NSLog("browser: refused %@", ExternalURL.redacted(url))
        }
        decisionHandler(.cancel)
    }

    // WebKit reports a script's click on a link as the user's, so every mail link is asked about over its tab, one at a time
    private func mail(_ url: URL, from webView: WKWebView) {
        guard let v = webView as? BrowserView, !v.asking else { return }
        let to = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? ""
        v.ask(to.isEmpty ? "Open a new email in your mail app?" : "Open a new email to \(to) in your mail app?",
              origin: v.url?.host ?? "", cancellable: true) { ok, _ in if ok { ExternalURL.open(url.absoluteString) } }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(webView, error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(webView, error)
    }

    // a tab whose page died is loaded again, unless it died again soon after, when it says so instead of looping
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard let v = webView as? BrowserView else { return }
        v.dismissDialogs()
        if let last = v.crashedAt, Date().timeIntervalSince(last) < 30 {
            v.error = "The page keeps crashing"
            return
        }
        v.crashedAt = Date()
        v.reload()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        (webView as? BrowserView)?.error = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        (webView as? BrowserView)?.error = nil
    }

    // a load dropped for the next one, or for a scheme handed elsewhere, is not something to report;
    // WebKit 102 is a frame load interrupted: our own policy cancel, or a response the view cannot display
    private func failed(_ webView: WKWebView, _ error: Error) {
        let failure = error as NSError
        guard !(failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled),
              !(failure.domain == "WebKitErrorDomain" && failure.code == 102) else { return }
        (webView as? BrowserView)?.error = error.localizedDescription
    }

    // MARK: popups

    // window.open and target=_blank get a real view built on the given configuration, which is what keeps
    // window.opener alive for sign-in flows; the page adopts it as a tab of the same character. a mailto
    // opened in a new window is asked about over its tab, with no tab left behind
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme?.lowercased() == "mailto" {
            mail(url, from: webView)
            return nil
        }
        guard let from = (webView as? BrowserView)?.tab else { return nil }
        let tab = "t_" + String(UUID().uuidString.lowercased().filter { $0 != "-" }.prefix(8))
        let v = make(tab: tab, configuration: configuration)
        v.isHidden = true
        onOpened(from, tab, navigationAction.request.url?.absoluteString ?? "about:blank")
        return v
    }

    // window.close() ends a sign-in popup; the page hears about it so the tab goes with the view.
    // only a view that is still held reports, so a tab the page itself closed never answers back
    func webViewDidClose(_ webView: WKWebView) {
        guard let tab = (webView as? BrowserView)?.tab, overlay[tab] != nil else { return }
        close(tab: tab)
        onClosed(tab)
    }
}
