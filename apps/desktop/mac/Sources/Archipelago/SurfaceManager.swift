import AppKit
import GhosttyKit

// the page names the socket and session only; which binary a terminal runs is decided here: the one the daemon
// names in the home, else a search. an app opened from Finder has no Homebrew on PATH, so the search adds it
private var tmux: String {
    if let named = ArchiHome.tmux, FileManager.default.isExecutableFile(atPath: named) { return named }
    let path = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
    let dirs = path + [NSHomeDirectory() + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
    return dirs.map { $0 + "/tmux" }.first { FileManager.default.isExecutableFile(atPath: $0) } ?? "tmux"
}

/// The shell command a surface runs to attach to a character's tmux session, here or on the owner's machine.
enum AttachCommand {
    static func quote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    // libghostty runs the command through a shell, so each field is single-quoted.
    // nil while the route is unknown: a session is attached only where the helper says it lives
    static func build(route: ConnectionRoute, attach: WebAttach, tmux: String = tmux) -> String? {
        let session = "-S \(quote(attach.socket)) attach -t \(quote(attach.session))"
        switch route {
        case .local:
            return "\(quote(tmux)) \(session)"
        case .pending:
            return nil
        case .remote(let route):
            // ssh joins the words after the destination into one line for the far login shell, which
            // splits it again, so the socket and session are quoted a second time for that shell
            let far = "-S \(quote(quote(attach.socket))) attach -t \(quote(quote(attach.session)))"
            return "ssh -S \(quote(route.controlSocket)) -tt -- \(quote(route.destination)) tmux \(far)"
        }
    }
}

private struct Attached {
    let rect: WebRect, attach: WebAttach, opacity: Double?
    var hidden = false
}

/// Creates, positions, hides and frees one SurfaceView per character id, above the webview.
final class SurfaceManager {
    private let makeView: (String, NSRect) -> SurfaceView?
    private let overlay: OverlayViews<SurfaceView>
    // what each surface was asked for with, so a route that is back can be attached to again
    private var attached: [String: Attached] = [:]
    var route: () -> ConnectionRoute = { .local }
    private var fontDelta = 0.0
    // false while the window is minimised, hidden or covered, when no surface need draw
    private var windowVisible = true
    var onExited: (String) -> Void = { _ in }
    var onFailed: (_ id: String, _ reason: String) -> Void = { _, _ in }
    var onFocused: (String) -> Void = { _ in }
    var onOpenURL: (String, String) -> Void = { _, _ in }

    convenience init(runtime: GhosttyRuntime, container: NSView, webView: NSView) {
        self.init(container: container, webView: webView) { SurfaceView(app: runtime.app, command: $0, frame: $1) }
    }

    init(container: NSView, webView: NSView, makeView: @escaping (String, NSRect) -> SurfaceView?) {
        self.makeView = makeView
        overlay = OverlayViews(container: container, webView: webView)
    }

    func setZoom(_ factor: Double, fontDelta: Double) {
        overlay.setZoom(factor)
        guard fontDelta != self.fontDelta else { return }
        self.fontDelta = fontDelta
        for view in overlay.views.values { view.setFontDelta(fontDelta) }
    }

    func setCutout(rects: [WebRect], passive: [WebRect]) {
        overlay.setCutout(rects: rects, passive: passive)
    }

    func show(id: String, rect: WebRect, attach: WebAttach?, opacity: Double?) {
        if let view = overlay[id] {
            overlay.place(view, rect)
            view.isHidden = false
            view.setOccluded(!windowVisible)
            view.alphaValue = opacity ?? 1
            attached[id] = attached[id].map { Attached(rect: rect, attach: $0.attach, opacity: opacity) }
            return
        }
        guard let attach else { return }
        let route = route()
        let binary = tmux
        guard let command = AttachCommand.build(route: route, attach: attach, tmux: binary) else {
            // the helper is opening a route: the session is remembered and attached once it is online
            attached[id] = Attached(rect: rect, attach: attach, opacity: opacity)
            return
        }
        guard let view = makeView(command, overlay.frame(rect)) else {
            NSLog("ghostty_surface_new failed for %@", id)
            onFailed(id, "Ghostty could not open a terminal; see the app log")
            return
        }
        let program = switch route { case .remote: "ssh"; default: binary }
        let gone: (_ failure: String?) -> Void = { [weak self, weak view] failure in
            guard let self, let view, self.overlay[id] === view else { return }
            self.close(id: id)
            if let failure { self.onFailed(id, failure) } else { self.onExited(id) }
        }
        // a tmux that ends as it starts could not attach, and shown again it would only end again; its last line says why
        view.onChildExited = { [weak view] ms in
            gone(ms < 1000 ? "\(program) quit as soon as it started" + (view?.lastLine().map { ": \($0)" } ?? "") : nil)
        }
        view.onCloseRequested = { gone(nil) }
        view.onFocused = { [weak self] in self?.onFocused(id) }
        view.onOpenURL = { [weak self] url in self?.onOpenURL(id, url) }
        if fontDelta != 0 { view.setFontDelta(fontDelta) }
        overlay.add(view, as: id)
        attached[id] = Attached(rect: rect, attach: attach, opacity: opacity)
        overlay.mask(view)
        view.alphaValue = opacity ?? 1
        if !windowVisible { view.setOccluded(true) }
    }

    func move(id: String, rect: WebRect) {
        attached[id] = attached[id].map { Attached(rect: rect, attach: $0.attach, opacity: $0.opacity, hidden: $0.hidden) }
        overlay.move(id, rect: rect)
    }

    func hide(id: String) {
        attached[id]?.hidden = true
        guard let view = overlay[id] else { return }
        overlay.hide(id)
        view.setOccluded(true)
    }

    func close(id: String) {
        attached[id] = nil
        overlay.close(id)
    }

    func setWindowVisible(_ visible: Bool) {
        windowVisible = visible
        for view in overlay.views.values where !view.isHidden { view.setOccluded(!visible) }
    }

    func focus(id: String?) {
        if let id, let view = overlay[id], !view.isHidden { view.window?.makeFirstResponder(view) }
        else { overlay.focusPage() }
    }

    /// After a reconnection or a new owner, tmux has destroyed each viewer session its client left, so every
    /// surface is let go and the page told it exited, to ask the daemon for a fresh attach.
    func rebuild() {
        for id in Set(overlay.views.keys).union(attached.keys) {
            close(id: id)
            onExited(id)
        }
    }

    func closeAll() {
        attached = [:]
        overlay.closeAll()
    }
}
