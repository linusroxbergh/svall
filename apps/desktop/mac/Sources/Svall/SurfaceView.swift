import AppKit
import GhosttyKit

/// One libghostty terminal surface. Input handling follows Ghostty's SurfaceView_AppKit.swift;
/// libghostty renders into a layer it attaches to this view, on its own thread.
final class SurfaceView: NSView, NSTextInputClient, OverlayView {
    private(set) var surface: ghostty_surface_t?
    /// The command ended, after running for `ms` milliseconds.
    var onChildExited: ((_ ms: UInt64) -> Void)?
    var onFocused: (() -> Void)?
    var onCloseRequested: (() -> Void)?
    /// A link followed in this terminal; without one it goes to the user's browser.
    var onOpenURL: ((String) -> Void)?

    var markedText = NSMutableAttributedString()
    var keyTextAccumulator: [String]?
    var lastPerformKeyEvent: TimeInterval?
    var suppressNextLeftMouseUp = false
    var focused = false
    var cellSize = CGSize(width: 8, height: 16)
    private var cursor: NSCursor = .iBeam
    private var sizeTimer: Timer?

    var cutout = Cutout() {
        didSet {
            cutout.apply(to: self)
            window?.invalidateCursorRects(for: self)
        }
    }

    override var acceptsFirstResponder: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        cutout.hit(at: point, in: self, otherwise: super.hitTest(point))
    }

    /// `command` is passed to libghostty as is; it runs it through a shell, so use absolute paths.
    init?(app: ghostty_app_t, command: String, frame: NSRect) {
        super.init(frame: frame)
        var cfg = ghostty_surface_config_new()
        cfg.platform_tag = GHOSTTY_PLATFORM_MACOS
        cfg.platform = ghostty_platform_u(macos: ghostty_platform_macos_s(nsview: Unmanaged.passUnretained(self).toOpaque()))
        cfg.userdata = Unmanaged.passUnretained(self).toOpaque()
        cfg.scale_factor = Double(NSScreen.main?.backingScaleFactor ?? 2)
        cfg.context = GHOSTTY_SURFACE_CONTEXT_WINDOW
        surface = command.withCString { ptr in
            cfg.command = ptr
            return ghostty_surface_new(app, &cfg)
        }
        guard let surface else { return nil }
        // libghostty starts a surface focused, blinking its cursor and, once visible, drawing every vsync
        ghostty_surface_set_focus(surface, false)
        for name in [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(windowKeyChanged), name: name, object: nil)
        }
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    deinit { destroy() }

    /// Frees the libghostty surface. Call on the main thread, after removing the view.
    func destroy() {
        guard let surface else { return }
        self.surface = nil
        ghostty_surface_free(surface)
    }

    /// Sets the font `delta` points from the config's size; starting from the reset keeps repeated calls from drifting.
    func setFontDelta(_ delta: Double) {
        perform("reset_font_size")
        if delta > 0 { perform("increase_font_size:\(delta)") }
        if delta < 0 { perform("decrease_font_size:\(-delta)") }
    }

    private func perform(_ action: String) {
        guard let surface else { return }
        if !ghostty_surface_binding_action(surface, action, UInt(action.utf8.count)) { NSLog("ghostty refused %@", action) }
    }

    /// The last line with text in it, scrollback included: what a command that just ended said last. The banner
    /// login(1) prints without ~/.hushlogin is not the command's.
    func lastLine() -> String? {
        guard let surface else { return nil }
        var text = ghostty_text_s()
        let all = ghostty_selection_s(
            top_left: ghostty_point_s(tag: GHOSTTY_POINT_SCREEN, coord: GHOSTTY_POINT_COORD_TOP_LEFT, x: 0, y: 0),
            bottom_right: ghostty_point_s(tag: GHOSTTY_POINT_SCREEN, coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT, x: 0, y: 0),
            rectangle: false)
        guard ghostty_surface_read_text(surface, all, &text) else { return nil }
        defer { ghostty_surface_free_text(surface, &text) }
        let lines = String(cString: text.text).split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        return lines.last { !$0.isEmpty && !$0.hasPrefix("Last login:") }
    }

    func setOccluded(_ occluded: Bool) {
        guard let surface else { return }
        ghostty_surface_set_occlusion(surface, !occluded)
    }

    // MARK: size, scale, focus

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { viewDidChangeBackingProperties() }
    }

    // the view follows its card every frame, drawing the grid it has at the top left; the grid, and with it
    // the pty and a tmux reflow, changes once the size has held still
    override func setFrameSize(_ newSize: NSSize) {
        let resized = newSize != frame.size
        super.setFrameSize(newSize)
        guard resized else { return }
        sizeTimer?.invalidate()
        let timer = Timer(timeInterval: 0.1, repeats: false) { [weak self] _ in self?.syncSize() }
        RunLoop.main.add(timer, forMode: .common)
        sizeTimer = timer
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        guard let surface, let window else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer?.contentsScale = window.backingScaleFactor
        CATransaction.commit()
        ghostty_surface_set_content_scale(surface, window.backingScaleFactor, window.backingScaleFactor)
        syncSize()
    }

    private func syncSize() {
        guard let surface, frame.width > 0, frame.height > 0 else { return }
        let backing = convertToBacking(frame.size)
        ghostty_surface_set_size(surface, UInt32(backing.width), UInt32(backing.height))
        let size = ghostty_surface_size(surface)
        let scale = window?.backingScaleFactor ?? 1
        if size.cell_width_px > 0 {
            cellSize = CGSize(width: Double(size.cell_width_px) / scale, height: Double(size.cell_height_px) / scale)
        }
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { focusDidChange(window?.isKeyWindow ?? false) }
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { focusDidChange(false) }
        return ok
    }

    private func focusDidChange(_ focused: Bool) {
        guard let surface, self.focused != focused else { return }
        self.focused = focused
        if !focused { suppressNextLeftMouseUp = false }
        ghostty_surface_set_focus(surface, focused)
    }

    // focused means first responder in the key window; becoming key races the responder change, so it waits a turn
    @objc private func windowKeyChanged(_ note: Notification) {
        guard note.object as? NSWindow === window else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            focusDidChange(window?.isKeyWindow == true && window?.firstResponder === self)
        }
    }

    override func updateTrackingAreas() {
        trackingAreas.forEach { removeTrackingArea($0) }
        addTrackingArea(NSTrackingArea(rect: frame, options: [.mouseEnteredAndExited, .mouseMoved, .inVisibleRect, .activeAlways], owner: self, userInfo: nil))
    }

    override func resetCursorRects() {
        for rect in Cutout.around(cutout.rects, in: bounds) { addCursorRect(rect, cursor: cursor) }
    }

    func setCursorShape(_ shape: ghostty_action_mouse_shape_e) {
        let next: NSCursor
        switch shape {
        case GHOSTTY_MOUSE_SHAPE_DEFAULT: next = .arrow
        case GHOSTTY_MOUSE_SHAPE_TEXT: next = .iBeam
        case GHOSTTY_MOUSE_SHAPE_GRAB: next = .openHand
        case GHOSTTY_MOUSE_SHAPE_GRABBING: next = .closedHand
        case GHOSTTY_MOUSE_SHAPE_POINTER: next = .pointingHand
        case GHOSTTY_MOUSE_SHAPE_W_RESIZE: next = .resizeLeft
        case GHOSTTY_MOUSE_SHAPE_E_RESIZE: next = .resizeRight
        case GHOSTTY_MOUSE_SHAPE_N_RESIZE: next = .resizeUp
        case GHOSTTY_MOUSE_SHAPE_S_RESIZE: next = .resizeDown
        case GHOSTTY_MOUSE_SHAPE_NS_RESIZE: next = .resizeUpDown
        case GHOSTTY_MOUSE_SHAPE_EW_RESIZE: next = .resizeLeftRight
        case GHOSTTY_MOUSE_SHAPE_VERTICAL_TEXT: next = .iBeamCursorForVerticalLayout
        case GHOSTTY_MOUSE_SHAPE_CONTEXT_MENU: next = .contextualMenu
        case GHOSTTY_MOUSE_SHAPE_CROSSHAIR: next = .crosshair
        case GHOSTTY_MOUSE_SHAPE_NOT_ALLOWED: next = .operationNotAllowed
        default: return
        }
        guard next !== cursor else { return }
        cursor = next
        window?.invalidateCursorRects(for: self)
    }
}
