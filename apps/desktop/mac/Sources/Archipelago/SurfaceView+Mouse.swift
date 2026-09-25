import AppKit
import GhosttyKit

extension SurfaceView {
    /// Ctrl is the link modifier here, where libghostty's own is cmd. Shift comes along while the
    /// program in the pane is reading the mouse: it is how Ghostty takes the events back, and Ghostty
    /// drops it again before matching a link, leaving the cmd it wants.
    private func linkMods(_ flags: NSEvent.ModifierFlags) -> NSEvent.ModifierFlags {
        guard let surface, flags.contains(.control), !flags.contains(.command) else { return flags }
        var mods = flags.subtracting(.control).union(.command)
        if ghostty_surface_mouse_captured(surface) { mods.insert(.shift) }
        return mods
    }

    private func mousePos(_ event: NSEvent, mods: NSEvent.ModifierFlags? = nil) {
        guard let surface else { return }
        let pos = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, pos.x, frame.height - pos.y, Ghostty.ghosttyMods(mods ?? linkMods(event.modifierFlags)))
    }

    override func mouseDown(with event: NSEvent) {
        guard let surface else { return }
        // a click into an unfocused surface only moves focus, like Ghostty's split focus transfer
        if let window, window.firstResponder !== self {
            window.makeFirstResponder(self)
            suppressNextLeftMouseUp = true
            onFocused?()
            return
        }
        let mods = linkMods(event.modifierFlags)
        // libghostty looks a link up when the pointer moves onto a cell, so a modifier pressed over a
        // resting pointer needs the position stated again; clearing it first is what makes it a move
        if mods != event.modifierFlags {
            ghostty_surface_mouse_pos(surface, -1, -1, Ghostty.ghosttyMods(mods))
            mousePos(event, mods: mods)
        }
        ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, Ghostty.ghosttyMods(mods))
    }

    override func mouseUp(with event: NSEvent) {
        if suppressNextLeftMouseUp { suppressNextLeftMouseUp = false; return }
        guard let surface else { return }
        ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, Ghostty.ghosttyMods(linkMods(event.modifierFlags)))
        ghostty_surface_mouse_pressure(surface, 0, 0)
    }

    override func rightMouseDown(with event: NSEvent) {
        guard let surface, ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_RIGHT, Ghostty.ghosttyMods(event.modifierFlags)) else {
            return super.rightMouseDown(with: event)
        }
    }

    override func rightMouseUp(with event: NSEvent) {
        guard let surface, ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_RIGHT, Ghostty.ghosttyMods(event.modifierFlags)) else {
            return super.rightMouseUp(with: event)
        }
    }

    override func otherMouseDown(with event: NSEvent) {
        guard let surface else { return }
        ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, Ghostty.mouseButton(event.buttonNumber), Ghostty.ghosttyMods(event.modifierFlags))
    }

    override func otherMouseUp(with event: NSEvent) {
        guard let surface else { return }
        ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, Ghostty.mouseButton(event.buttonNumber), Ghostty.ghosttyMods(event.modifierFlags))
    }

    override func mouseEntered(with event: NSEvent) { mousePos(event) }
    override func mouseMoved(with event: NSEvent) { mousePos(event) }
    override func mouseDragged(with event: NSEvent) { mousePos(event) }
    override func rightMouseDragged(with event: NSEvent) { mousePos(event) }
    override func otherMouseDragged(with event: NSEvent) { mousePos(event) }

    override func mouseExited(with event: NSEvent) {
        guard let surface, NSEvent.pressedMouseButtons == 0 else { return }
        ghostty_surface_mouse_pos(surface, -1, -1, Ghostty.ghosttyMods(event.modifierFlags))
    }

    override func scrollWheel(with event: NSEvent) {
        guard let surface else { return }
        var x = event.scrollingDeltaX
        var y = event.scrollingDeltaY
        let precision = event.hasPreciseScrollingDeltas
        if precision { x *= 2; y *= 2 }
        ghostty_surface_mouse_scroll(surface, x, y, Ghostty.scrollMods(precision: precision, phase: event.momentumPhase))
    }
}
