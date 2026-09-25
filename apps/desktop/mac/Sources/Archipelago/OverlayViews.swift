import AppKit

/// A view a manager keeps above the webview: it takes a cutout for the page's panels and is freed when it goes.
protocol OverlayView: NSView {
    var cutout: Cutout { get set }
    func destroy()
}

extension OverlayView {
    /// True while this view, or something inside it, is the window's first responder.
    var hasKeys: Bool { (window?.firstResponder as? NSView)?.isDescendant(of: self) ?? false }
}

/// The overlay views one manager holds by id, and what the page's rects, zoom and cutout do to them.
final class OverlayViews<V: OverlayView> {
    private unowned let container: NSView
    private unowned let webView: NSView
    private(set) var views: [String: V] = [:]
    // the page is zoomed, so its rects are in page pixels: this many window points each
    private(set) var zoom = 1.0
    // the rects the page's panels are drawn into, which every view gives up while they stand
    private var cutout: (rects: [WebRect], passive: [WebRect]) = ([], [])

    init(container: NSView, webView: NSView) {
        self.container = container
        self.webView = webView
    }

    subscript(id: String) -> V? { views[id] }

    /// The window frame for a rect the page measured.
    func frame(_ rect: WebRect) -> NSRect {
        windowFrame(rect, zoom: zoom, in: container)
    }

    func add(_ view: V, as id: String) {
        views[id] = view
        container.addSubview(view, positioned: .above, relativeTo: webView)
    }

    func setZoom(_ factor: Double) {
        zoom = factor
        for view in views.values { mask(view) }
    }

    func setCutout(rects: [WebRect], passive: [WebRect]) {
        cutout = (rects, passive)
        for view in views.values { mask(view) }
    }

    // the view is masked in its own coordinates, so it is given the rects after it has been placed
    func mask(_ view: V) {
        let local = { (rect: WebRect) in view.convert(self.frame(rect), from: self.container) }
        view.cutout = Cutout(rects: cutout.rects.map(local), passive: cutout.passive.map(local))
    }

    func place(_ view: V, _ rect: WebRect) {
        view.frame = frame(rect)
        mask(view)
    }

    func move(_ id: String, rect: WebRect) {
        guard let view = views[id] else { return }
        place(view, rect)
    }

    func hide(_ id: String) {
        guard let view = views[id] else { return }
        // hiding the first responder hands the keys to the window, not the page, so they move first
        if view.hasKeys { focusPage() }
        view.isHidden = true
    }

    func close(_ id: String) {
        guard let view = views.removeValue(forKey: id) else { return }
        if view.hasKeys { focusPage() }
        view.removeFromSuperview()
        view.destroy()
    }

    func closeAll() {
        for id in Array(views.keys) { close(id) }
    }

    func focusPage() {
        webView.window?.makeFirstResponder(webView)
    }
}
