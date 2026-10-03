import AppKit

struct WebRect: Decodable {
    let x: Double, y: Double, width: Double, height: Double
}

/// The window frame for a rect the page measured, in page pixels of `zoom` window points each. The frame lands on whole
/// device pixels: a view off the backing grid is composited through a resample, which softens text.
func windowFrame(_ rect: WebRect, zoom: Double, in container: NSView) -> NSRect {
    let r = NSRect(x: rect.x * zoom, y: container.bounds.height - (rect.y + rect.height) * zoom, width: rect.width * zoom, height: rect.height * zoom)
    return container.backingAlignedRect(r, options: .alignAllEdgesNearest)
}
