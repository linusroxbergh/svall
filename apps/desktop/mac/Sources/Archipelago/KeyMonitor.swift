import AppKit

/// Swallows registered Cmd chords app-wide before any view sees them, and routes Cmd keyUp
/// (which AppKit never delivers through the responder chain) to a focused surface.
final class KeyMonitor {
    var registered: Set<String> = []
    /// while the page is waiting for a chord to assign, every Cmd chord goes to it, registered or not
    var capturing = false
    var onChord: (String) -> Void = { _ in }
    private var monitor: Any?

    static func chord(for event: NSEvent) -> String? {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard mods.contains(.command), !mods.contains(.control), !mods.contains(.option) else { return nil }
        guard let raw = event.charactersIgnoringModifiers?.lowercased() else { return nil }
        let key: String
        if raw == "\r" || raw == "\u{3}" { key = "enter" } else if raw.count == 1 { key = raw } else { return nil }
        return "cmd+" + (mods.contains(.shift) ? "shift+" : "") + key
    }

    func install() {
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
            guard let self else { return event }
            if event.type == .keyDown, let chord = Self.chord(for: event), self.capturing || self.registered.contains(chord) {
                self.onChord(chord)
                return nil
            }
            if event.type == .keyUp, event.modifierFlags.contains(.command),
               let view = event.window?.firstResponder as? SurfaceView {
                view.keyUp(with: event)
                return nil
            }
            return event
        }
    }

    deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
}
