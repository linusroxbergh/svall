import AppKit

/// A rect a native view gives up to the page drawn below it. Terminals and browser tabs sit above the webview,
/// so a panel the page opens over one is seen, and reached, only where that view is masked away.
enum Cutout {
    /// `rect` is in `view`'s own coordinates; nil leaves the view whole.
    static func apply(_ rect: NSRect?, to view: NSView) {
        guard let layer = view.layer else { return }
        guard let rect, rect.intersects(view.bounds) else {
            if layer.mask != nil { layer.mask = nil }
            return
        }
        let shape = layer.mask as? CAShapeLayer ?? CAShapeLayer()
        let path = CGMutablePath()
        path.addRect(view.bounds)
        path.addRect(rect)
        // the two rects are one path with a hole in it, and the mask keeps only what the path fills
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shape.fillRule = .evenOdd
        shape.fillColor = NSColor.black.cgColor
        // a mask layer starts at 1x, which would rasterize the edge of the hole below the screen's grid
        shape.contentsScale = view.window?.backingScaleFactor ?? 2
        shape.frame = view.bounds
        shape.path = path
        CATransaction.commit()
        if layer.mask !== shape { layer.mask = shape }
    }

    /// The hit test a masked view answers: a press inside the rect belongs to the page, not to this view.
    static func hit(_ rect: NSRect?, at point: NSPoint, in view: NSView, otherwise hit: NSView?) -> NSView? {
        guard let rect, hit != nil, rect.contains(view.convert(point, from: view.superview)) else { return hit }
        return nil
    }

    /// `bounds` with `rect` taken out of it, as the rects left over. Cursor rects cannot be subtracted.
    static func around(_ rect: NSRect?, in bounds: NSRect) -> [NSRect] {
        let hole = (rect ?? .zero).intersection(bounds)
        guard !hole.isEmpty else { return [bounds] }
        return [
            NSRect(x: bounds.minX, y: hole.maxY, width: bounds.width, height: bounds.maxY - hole.maxY),
            NSRect(x: bounds.minX, y: bounds.minY, width: bounds.width, height: hole.minY - bounds.minY),
            NSRect(x: bounds.minX, y: hole.minY, width: hole.minX - bounds.minX, height: hole.height),
            NSRect(x: hole.maxX, y: hole.minY, width: bounds.maxX - hole.maxX, height: hole.height),
        ].filter { $0.width > 0 && $0.height > 0 }
    }
}
