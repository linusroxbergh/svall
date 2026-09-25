import AppKit
import WebKit

/// The panels a page raises with alert, confirm, prompt and a file input.
extension BrowserManager {
    // a dialog names the site that raised it, which for a frame need not be the tab's own
    private func origin(_ webView: WKWebView, _ frame: WKFrameInfo) -> String {
        let host = frame.securityOrigin.host
        return host.isEmpty ? (webView.url?.host ?? "") : host
    }

    // a page's dialog waits over its own tab: a modal alert would hold every terminal and tab until answered
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard let v = webView as? BrowserView else { return completionHandler() }
        v.ask(message, origin: origin(webView, frame), cancellable: false) { _, _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let v = webView as? BrowserView else { return completionHandler(false) }
        v.ask(message, origin: origin(webView, frame), cancellable: true) { ok, _ in completionHandler(ok) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard let v = webView as? BrowserView else { return completionHandler(nil) }
        v.ask(prompt, origin: origin(webView, frame), cancellable: true, text: defaultText ?? "") { ok, text in completionHandler(ok ? text : nil) }
    }

    // a panel of its own rather than a sheet, so the terminals and other tabs carry on while it is open
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = !parameters.allowsDirectories
        panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
    }
}
