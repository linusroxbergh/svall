import AppKit
import WebKit

/// A right-click menu the page asks for, with the Reload that WebKit's own menu offers under the page's items.
final class PageMenu: NSObject {
    var onPick: (String) -> Void = { _ in }

    func show(_ items: [WebMenuItem], x: Double, y: Double, in webView: WKWebView) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for item in items {
            let entry = NSMenuItem(title: item.title, action: #selector(pick(_:)), keyEquivalent: "")
            entry.target = self
            entry.representedObject = item.id
            entry.isEnabled = item.enabled
            menu.addItem(entry)
        }
        menu.addItem(.separator())
        let reload = NSMenuItem(title: "Reload", action: #selector(WKWebView.reload(_:)), keyEquivalent: "")
        reload.target = webView
        menu.addItem(reload)
        let zoom = webView.pageZoom
        let point = NSPoint(x: x * zoom, y: webView.isFlipped ? y * zoom : webView.bounds.height - y * zoom)
        menu.popUp(positioning: nil, at: point, in: webView)
    }

    @objc private func pick(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String { onPick(id) }
    }
}
