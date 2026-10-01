import AppKit
import WebKit

/// Finder drops reach the page as bridge messages with the point in web coordinates; the page decides the target.
/// Handling the drop here also stops WebKit from navigating to a dropped file.
final class DropWebView: WKWebView {
    var onDrag: ((FromShell) -> Void)?

    private func fileURLs(_ sender: NSDraggingInfo) -> [URL] {
        (sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }

    // the page is zoomed, so a window point is fewer page pixels than one
    func webPoint(_ windowPoint: NSPoint) -> (Double, Double) {
        let p = convert(windowPoint, from: nil)
        return (p.x / pageZoom, (isFlipped ? p.y : bounds.height - p.y) / pageZoom)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        fileURLs(sender).isEmpty ? super.draggingEntered(sender) : draggingUpdated(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard !fileURLs(sender).isEmpty else { return super.draggingUpdated(sender) }
        let (x, y) = webPoint(sender.draggingLocation)
        onDrag?(.dragOver(x: x, y: y))
        return .copy
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        onDrag?(.dragExit)
        super.draggingExited(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = fileURLs(sender)
        guard !urls.isEmpty else { return super.performDragOperation(sender) }
        let (x, y) = webPoint(sender.draggingLocation)
        onDrag?(.dragDrop(paths: urls.map(\.path), x: x, y: y))
        return true
    }
}
