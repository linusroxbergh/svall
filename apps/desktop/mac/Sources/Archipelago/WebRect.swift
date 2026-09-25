import AppKit

struct WebRect: Decodable {
    let x: Double, y: Double, width: Double, height: Double
}

/// The window frame for a rect the page measured. The page is zoomed, so its rects are in page pixels: `zoom` window
/// points each. A view off the backing grid is composited through a resample, which softens text, so the frame lands
/// on whole device pixels.
func windowFrame(_ rect: WebRect, zoom: Double, in container: NSView) -> NSRect {
    let r = NSRect(x: rect.x * zoom, y: container.bounds.height - (rect.y + rect.height) * zoom, width: rect.width * zoom, height: rect.height * zoom)
    return container.backingAlignedRect(r, options: .alignAllEdgesNearest)
}
