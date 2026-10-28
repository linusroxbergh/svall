import AppKit
import UniformTypeIdentifiers

/// Opens links the page hands out in the user's browser; other schemes are dropped.
enum ExternalURL {
    static let schemes: Set<String> = ["http", "https", "mailto"]

    static func open(_ text: String) {
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), schemes.contains(scheme) else {
            NSLog("refused to open url: %@", redacted(URL(string: text)))
            return
        }
        NSWorkspace.shared.open(url)
    }

    /// A url fit for the log: its scheme and host, never the path or query that can carry a sign-in code.
    static func redacted(_ url: URL?) -> String {
        guard let url else { return "an unreadable url" }
        return (url.scheme ?? "") + (url.host.map { "://" + $0 } ?? ":")
    }

    /// Opens a plain directory in Finder. A bundle such as an .app is not one.
    static func openFolder(_ path: String) {
        let url = URL(fileURLWithPath: path)
        let kind = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey])
        guard kind?.isDirectory == true, kind?.isPackage != true else {
            NSLog("refused to open folder: %@", path)
            return
        }
        NSWorkspace.shared.open(url)
    }

    /// Opens a file in the user's default text editor.
    static func openText(_ path: String) {
        guard FileManager.default.fileExists(atPath: path) else { NSLog("refused to open: %@", path); return }
        run(["-t", path])
    }

    /// Opens a file the editor cannot show: a picture, PDF or film in its own app, text in the text editor, and anything else,
    /// a program above all, selected in Finder rather than run.
    static func openFile(_ path: String) {
        guard let type = (try? URL(fileURLWithPath: path).resourceValues(forKeys: [.contentTypeKey]))?.contentType else { reveal(path); return }
        if [UTType.image, .pdf, .audiovisualContent].contains(where: { type.conforms(to: $0) }) { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
        else if type.conforms(to: .text) { openText(path) }
        else { reveal(path) }
    }

    private static func run(_ args: [String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = args
        process.terminationHandler = { p in
            if p.terminationStatus != 0 { NSLog("open %@ exited %d", args.joined(separator: " "), p.terminationStatus) }
        }
        do { try process.run() } catch { NSLog("open %@: %@", args.joined(separator: " "), "\(error)") }
    }

    static func reveal(_ path: String) {
        guard FileManager.default.fileExists(atPath: path) else { NSLog("refused to reveal: %@", path); return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }
}
