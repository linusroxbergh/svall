import Foundation
import UniformTypeIdentifiers
import WebKit

// Serves the bundled web build over svall://app/. A file:// page is an opaque origin, where
// WebKit refuses ES modules and fetch; a custom scheme gives the bundle a real one.
final class WebAssets: NSObject, WKURLSchemeHandler {
    static let scheme = "svall"
    static let start = URL(string: "\(scheme)://app/index.html")!

    private let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    private func file(for url: URL) -> URL? {
        let path = url.path.isEmpty || url.path == "/" ? "/index.html" : url.path
        let target = root.appendingPathComponent(path).standardizedFileURL
        guard target.path == root.path || target.path.hasPrefix(root.path + "/") else { return nil }
        return target
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        if let url = task.request.url, url.path.hasPrefix(DropFiles.path) {
            guard let data = DropFiles.shared.take(String(url.path.dropFirst(DropFiles.path.count))) else {
                return task.didFailWithError(URLError(.fileDoesNotExist))
            }
            return respond(task, url: url, data: data, type: "application/octet-stream", part: 1 << 20)
        }
        guard let url = task.request.url, let target = file(for: url), let data = try? Data(contentsOf: target) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        respond(task, url: url, data: data, type: UTType(filenameExtension: target.pathExtension)?.preferredMIMEType ?? "application/octet-stream")
    }

    /// `part`: the most of `data` handed over at once, so a large file reaches the page as a stream.
    private func respond(_ task: WKURLSchemeTask, url: URL, data: Data, type: String, part: Int = .max) {
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": type,
            "Content-Length": String(data.count),
        ])!
        task.didReceive(response)
        for at in stride(from: 0, to: data.count, by: part) { task.didReceive(data.subdata(in: at..<min(at + part, data.count))) }
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
