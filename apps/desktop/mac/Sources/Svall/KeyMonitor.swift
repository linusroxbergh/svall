import AppKit

/// Swallows registered Cmd chords in the app's window before any view sees them, and routes Cmd keyUp
/// (which AppKit never delivers through the responder chain) to a focused surface.
final class KeyMonitor {
    /// What a web app in a browser tab formats and sends with: bold, italic, underline, link and send.
    private static let pageChords: Set<String> = ["cmd+b", "cmd+i", "cmd+u", "cmd+k", "cmd+enter"]
    /// The chord that quits before the page has named its own, so a blank or crashed page can still be left.
    static let defaultQuit = "cmd+q"

    var registered: Set<String> = []
    /// while the page is waiting for a chord to assign, every Cmd chord goes to it, registered or not
    var capturing = false
    /// the chord that quits, taken whether or not the page registered it; nil when the page left quitting unbound
    var quit: String? = KeyMonitor.defaultQuit
    var onChord: (String) -> Void = { _ in }
    private var monitor: Any?
    private weak var window: NSWindow?

    static func chord(for event: NSEvent) -> String? {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard mods.contains(.command), !mods.contains(.control), !mods.contains(.option) else { return nil }
        guard let raw = event.charactersIgnoringModifiers?.lowercased() else { return nil }
        let key: String
        if raw == "\r" || raw == "\u{3}" { key = "enter" } else if raw.count == 1 { key = raw } else { return nil }
        return "cmd+" + (mods.contains(.shift) ? "shift+" : "") + key
    }

    /// The menu key equivalent for a chord in the form above: "cmd+shift+q" is Q with Command and Shift.
    static func keyEquivalent(for chord: String?) -> (key: String, mods: NSEvent.ModifierFlags) {
        guard let chord, chord.hasPrefix("cmd+") else { return ("", []) }
        var key = chord.dropFirst("cmd+".count)
        var mods: NSEvent.ModifierFlags = [.command]
        if key.hasPrefix("shift+"), key.count > "shift+".count { key = key.dropFirst("shift+".count); mods.insert(.shift) }
        return (key == "enter" ? "\r" : String(key), mods)
    }

    // the tab with the keys, or a dialog it holds
    private static func inBrowser(_ responder: NSResponder?) -> Bool {
        var view = responder as? NSView
        while let v = view {
            if v is BrowserView { return true }
            view = v.superview
        }
        return false
    }

    private func claims(_ chord: String, in window: NSWindow) -> Bool {
        if capturing || chord == quit { return true }
        guard registered.contains(chord) else { return false }
        return !(Self.pageChords.contains(chord) && Self.inBrowser(window.firstResponder))
    }

    func install(in window: NSWindow?) {
        self.window = window
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
            // a file picker, an alert or a sheet is a window of its own, and its keys stay its own
            guard let self, let window = self.window, event.window === window else { return event }
            if event.type == .keyDown, let chord = Self.chord(for: event), self.claims(chord, in: window) {
                self.onChord(chord)
                return nil
            }
            if event.type == .keyUp, event.modifierFlags.contains(.command),
               let view = window.firstResponder as? SurfaceView {
                view.keyUp(with: event)
                return nil
            }
            return event
        }
    }

    deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
}
