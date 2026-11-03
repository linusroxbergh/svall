import AppKit

/// A file dropped, or an image pasted, into a terminal on another machine, as the page is told of it.
struct DroppedFile: Equatable {
    let token: String, name: String, bytes: Int, folder: Bool

    var json: [String: Any] { ["token": token, "name": name, "bytes": bytes, "folder": folder] }
}

/// What the page reads at `svall://app/__drop/<token>`: each file or image once, within five minutes of its drop.
final class DropFiles {
    static let shared = DropFiles()
    static let path = "/__drop/"

    private enum Source { case file(URL), data(Data) }
    private var held: [String: (source: Source, until: Date)] = [:]

    /// The files at `urls` for the page to read; a folder is named for the page to refuse, and nothing in it is held.
    func hold(_ urls: [URL], now: Date = Date()) -> [DroppedFile] {
        urls.map { url in
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
            if values?.isDirectory == true { return DroppedFile(token: "", name: url.lastPathComponent, bytes: 0, folder: true) }
            return DroppedFile(token: hold(.file(url), now: now), name: url.lastPathComponent, bytes: values?.fileSize ?? 0, folder: false)
        }
    }

    /// An image pasted as PNG, named for when it was pasted.
    func hold(png: Data, now: Date = Date()) -> DroppedFile {
        DroppedFile(token: hold(.data(png), now: now), name: Self.pastedName(at: now), bytes: png.count, folder: false)
    }

    /// The bytes held under `token`, once.
    func take(_ token: String, now: Date = Date()) -> Data? {
        guard let held = held.removeValue(forKey: token), held.until > now else { return nil }
        switch held.source {
        case .file(let url): return try? Data(contentsOf: url, options: .mappedIfSafe)
        case .data(let data): return data
        }
    }

    private func hold(_ source: Source, now: Date) -> String {
        held = held.filter { $0.value.until > now }
        let token = UUID().uuidString
        held[token] = (source, now.addingTimeInterval(300))
        return token
    }

    static func pastedName(at date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        return "pasted-image-\(f.string(from: date)).png"
    }

    /// The image a paste would carry as PNG: only from a pasteboard with no text on it, which pastes as it always has.
    static func pastedImage(_ pasteboard: NSPasteboard) -> Data? {
        guard pasteboard.string(forType: .string) == nil else { return nil }
        if let png = pasteboard.data(forType: .png) { return png }
        guard let tiff = pasteboard.data(forType: .tiff), let image = NSBitmapImageRep(data: tiff) else { return nil }
        return image.representation(using: .png, properties: [:])
    }
}

/// Paths as Ghostty types a dropped file: a backslash before each character a shell would read otherwise, one space
/// between. A path with a control character in it, which would run what follows, is left out.
enum ShellEscape {
    private static let special = Set("\\ ()[]{}<>\"'`!#$&;|*?")

    static func paths(_ paths: [String]) -> String {
        paths.filter(MachineCommand.typeable).map { $0.map { special.contains($0) ? "\\\($0)" : String($0) }.joined() }.joined(separator: " ")
    }
}
