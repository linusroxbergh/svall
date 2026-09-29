import WebKit

struct BrowserState {
    let tab: String, url: String, title: String, loading: Bool, canGoBack: Bool, canGoForward: Bool
    let error: String?
}

/// One tab. Reports its url, title and history state whenever WebKit changes them.
final class BrowserView: WKWebView, OverlayView {
    let tab: String
    var onState: ((BrowserState) -> Void)?
    /// What stopped the last navigation, until one gets somewhere.
    var error: String? { didSet { if error != oldValue { report() } } }
    var cutout = Cutout() { didSet { cutout.apply(to: self) } }
    /// When its web process last died and the page was loaded again.
    var crashedAt: Date?
    private var observers: [NSKeyValueObservation] = []

    init(tab: String, configuration: WKWebViewConfiguration) {
        self.tab = tab
        super.init(frame: .zero, configuration: configuration)
        observers = [
            observe(\.url) { v, _ in v.report() },
            observe(\.title) { v, _ in v.report() },
            observe(\.isLoading) { v, _ in v.report() },
            observe(\.canGoBack) { v, _ in v.report() },
            observe(\.canGoForward) { v, _ in v.report() },
        ]
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    override func hitTest(_ point: NSPoint) -> NSView? {
        cutout.hit(at: point, in: self, otherwise: super.hitTest(point))
    }

    /// Ends the observations and any navigation in flight. Call while the view is still alive: an observation's
    /// own deinit cannot unregister it, because its weak reference to the view is already gone by then.
    func destroy() {
        observers.forEach { $0.invalidate() }
        observers = []
        onState = nil
        dismissDialogs()
        stopLoading()
    }

    private var dialogs: [BrowserDialog] { subviews.compactMap { $0 as? BrowserDialog } }

    /// True while a dialog waits over this tab.
    var asking: Bool { !dialogs.isEmpty }

    func takeKeys() {
        if let dialog = dialogs.last { dialog.takeKeys() } else { window?.makeFirstResponder(self) }
    }

    /// Asks over this tab alone. A dialog takes the keys only from its own tab, never from a terminal being typed in.
    func ask(_ message: String, origin: String, cancellable: Bool, text: String? = nil, answer: @escaping (_ ok: Bool, _ text: String) -> Void) {
        let hadKeys = hasKeys
        let dialog = BrowserDialog(message: message, origin: origin, cancellable: cancellable, text: text, answer: answer)
        dialog.frame = bounds
        dialog.autoresizingMask = [.width, .height]
        addSubview(dialog)
        if hadKeys { dialog.takeKeys() }
    }

    /// Answers every waiting dialog as cancelled, which a page that is going away needs before it can go.
    func dismissDialogs() { dialogs.forEach { $0.cancel() } }

    private func report() {
        onState?(BrowserState(tab: tab, url: url?.absoluteString ?? "", title: title ?? "", loading: isLoading, canGoBack: canGoBack, canGoForward: canGoForward, error: error))
    }
}
