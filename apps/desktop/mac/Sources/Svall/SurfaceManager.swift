import AppKit
import GhosttyKit

private func sh(_ s: String) -> String {
    "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

// the page names the socket and session only; which binary a terminal runs is decided here: the one the daemon
// names in the home, else a search. an app opened from Finder has no Homebrew on PATH, so the search adds it
var tmux: String {
    if let named = SvallHome.tmux, FileManager.default.isExecutableFile(atPath: named) { return named }
    let path = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
    let dirs = path + [NSHomeDirectory() + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
    return dirs.map { $0 + "/tmux" }.first { FileManager.default.isExecutableFile(atPath: $0) } ?? "tmux"
}

/// Creates, positions, hides and frees one SurfaceView per character id, above the webview.
final class SurfaceManager {
    private let runtime: GhosttyRuntime
    private let overlay: OverlayViews<SurfaceView>
    private var fontDelta = 0.0
    // false while the window is minimised, hidden or covered, when no surface need draw
    private var windowVisible = true
    var onExited: (String) -> Void = { _ in }
    var onFailed: (_ id: String, _ reason: String) -> Void = { _, _ in }
    var onFocused: (String) -> Void = { _ in }
    var onOpenURL: (String, String) -> Void = { _, _ in }

    init(runtime: GhosttyRuntime, container: NSView, webView: NSView) {
        self.runtime = runtime
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
            return
        }
        guard let attach else { return }
        let binary = tmux
        // libghostty runs the command through a shell, so each field is single-quoted
        let command = "\(sh(binary)) -S \(sh(attach.socket)) attach -t \(sh(attach.session))"
        guard let view = SurfaceView(app: runtime.app, command: command, frame: overlay.frame(rect)) else {
            NSLog("ghostty_surface_new failed for %@", id)
            onFailed(id, "Ghostty could not open a terminal; see the app log")
            return
        }
        let gone: (_ failure: String?) -> Void = { [weak self, weak view] failure in
            guard let self, let view, self.overlay[id] === view else { return }
            self.close(id: id)
            if let failure { self.onFailed(id, failure) } else { self.onExited(id) }
        }
        // a tmux that ends as it starts could not attach, and shown again it would only end again; its last line says why
        view.onChildExited = { [weak view] ms in
            gone(ms < 1000 ? "\(binary) quit as soon as it started" + (view?.lastLine().map { ": \($0)" } ?? "") : nil)
        }
        view.onCloseRequested = { gone(nil) }
        view.onFocused = { [weak self] in self?.onFocused(id) }
        view.onOpenURL = { [weak self] url in self?.onOpenURL(id, url) }
        if fontDelta != 0 { view.setFontDelta(fontDelta) }
        overlay.add(view, as: id)
        overlay.mask(view)
        view.alphaValue = opacity ?? 1
        if !windowVisible { view.setOccluded(true) }
    }

    func move(id: String, rect: WebRect) {
        overlay.move(id, rect: rect)
    }

    func hide(id: String) {
        guard let view = overlay[id] else { return }
        overlay.hide(id)
        view.setOccluded(true)
    }

    func close(id: String) {
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

    func closeAll() {
        overlay.closeAll()
    }
}
