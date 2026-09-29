import AppKit
import WebKit

/// Downloads, saved to ~/Downloads under a name no other file there has.
extension BrowserManager: WKDownloadDelegate {
    // what a tab cannot show, or what the server sends as an attachment, is saved instead; a frame's
    // response is not, so only the page itself puts files in Downloads
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let attachment = disposition.lowercased().hasPrefix("attachment")
        decisionHandler(navigationResponse.isForMainFrame && (attachment || !navigationResponse.canShowMIMEType) ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = (suggestedFilename as NSString).lastPathComponent
        let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
        var file = folder.appendingPathComponent(name)
        var n = 1
        // the name is claimed here, before WebKit creates the file; Downloads does not tell case apart
        while FileManager.default.fileExists(atPath: file.path) || downloads.values.contains(where: { $0.path.lowercased() == file.path.lowercased() }) {
            n += 1
            file = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
        }
        downloads[download] = file
        completionHandler(file)
    }

    // the Downloads stack in the Dock bounces for a finished file, as it does for Safari's
    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: download) else { return }
        DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: file.path)
    }

    // WebKit writes straight to the final name, so a failure would leave a truncated file there
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = downloads.removeValue(forKey: download) { try? FileManager.default.removeItem(at: file) }
        (download.webView as? BrowserView)?.error = "Download failed: \(error.localizedDescription)"
    }

    // a download the app quits during never fails, and what it had written would pass for the whole file
    func dropDownloads() {
        for file in downloads.values { try? FileManager.default.removeItem(at: file) }
        downloads = [:]
    }
}
