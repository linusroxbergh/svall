import AppKit

/// The rects, in its own coordinates, a terminal or browser tab gives up so a panel the page draws below it shows through.
/// A press in `rects` goes to the page; `passive` ones show a panel that takes no presses, so theirs stay with the view.
struct Cutout {
    var rects: [NSRect] = []
    var passive: [NSRect] = []

    func apply(to view: NSView) {
        guard let layer = view.layer else { return }
        let kept = Cutout.around(rects + passive, in: view.bounds)
        guard kept != [view.bounds] else {
            if layer.mask != nil { layer.mask = nil }
            return
        }
        let shape = layer.mask as? CAShapeLayer ?? CAShapeLayer()
        let path = CGMutablePath()
        // the pieces left never overlap, so the mask keeps exactly them however the holes overlap each other
        path.addRects(kept)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shape.fillColor = NSColor.black.cgColor
        // a mask layer starts at 1x, which would rasterize the edge of the hole below the screen's grid
        shape.contentsScale = view.window?.backingScaleFactor ?? 2
        shape.frame = view.bounds
        shape.path = path
        CATransaction.commit()
        if layer.mask !== shape { layer.mask = shape }
    }

    /// The hit test a masked view answers: a press in a hole that takes presses belongs to the page, not to this view.
    func hit(at point: NSPoint, in view: NSView, otherwise hit: NSView?) -> NSView? {
        guard hit != nil else { return hit }
        let local = view.convert(point, from: view.superview)
        return rects.contains { $0.contains(local) } ? nil : hit
    }

    /// `bounds` with every hole taken out of it, as the rects left over. Cursor rects cannot be subtracted.
    static func around(_ holes: [NSRect], in bounds: NSRect) -> [NSRect] {
        holes.reduce([bounds]) { pieces, hole in pieces.flatMap { around(hole, in: $0) } }
    }

    private static func around(_ rect: NSRect, in bounds: NSRect) -> [NSRect] {
        let hole = rect.intersection(bounds)
        guard !hole.isEmpty else { return [bounds] }
        return [
            NSRect(x: bounds.minX, y: hole.maxY, width: bounds.width, height: bounds.maxY - hole.maxY),
            NSRect(x: bounds.minX, y: bounds.minY, width: bounds.width, height: hole.minY - bounds.minY),
            NSRect(x: bounds.minX, y: hole.minY, width: hole.minX - bounds.minX, height: hole.height),
            NSRect(x: hole.maxX, y: hole.minY, width: bounds.maxX - hole.maxX, height: hole.height),
        ].filter { $0.width > 0 && $0.height > 0 }
    }
}
