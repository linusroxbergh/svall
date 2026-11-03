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
        guard let url = task.request.url else { return task.didFailWithError(URLError(.fileDoesNotExist)) }
        if url.path.hasPrefix(DropFiles.path) {
            guard let data = dropPart(url) else { return task.didFailWithError(URLError(.fileDoesNotExist)) }
            return respond(task, url: url, data: data, type: "application/octet-stream")
        }
        guard let target = file(for: url), let data = try? Data(contentsOf: target) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        respond(task, url: url, data: data, type: UTType(filenameExtension: target.pathExtension)?.preferredMIMEType ?? "application/octet-stream")
    }

    private func dropPart(_ url: URL) -> Data? {
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        let number = { (name: String) in query?.first { $0.name == name }?.value.flatMap { Int($0) } }
        guard let at = number("at"), let size = number("size"), at >= 0, size > 0 else { return nil }
        return DropFiles.shared.read(String(url.path.dropFirst(DropFiles.path.count)), at: at, size: size)
    }

    private func respond(_ task: WKURLSchemeTask, url: URL, data: Data, type: String) {
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": type,
            "Content-Length": String(data.count),
        ])!
        task.didReceive(response)
        if !data.isEmpty { task.didReceive(data) }
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
