import AppKit

/// A file dropped, or an image pasted, into a terminal on another machine, as the page is told of it.
struct DroppedFile: Equatable {
    let token: String, name: String, bytes: Int, folder: Bool

    var json: [String: Any] { ["token": token, "name": name, "bytes": bytes, "folder": folder] }
}

/// What the page reads at `svall://app/__drop/<token>?at=&size=`, one part per request, so no more than a part is held.
/// A drop's files go together, 11 minutes past its own last read: longer than a client waits for robot.drop, so a file
/// outlives the crossing of the one before it, and a drop no one reads goes whatever other drops do.
final class DropFiles {
    static let shared = DropFiles()
    static let path = "/__drop/"

    private enum Source { case file(URL), data(Data) }
    private struct Drop { var files: [String: Source]; var until: Date }
    private static let window: TimeInterval = 11 * 60
    private var drops: [Drop] = []

    /// The files at `urls` for the page to read, a link read as what it names; a folder is named for the page to refuse,
    /// and nothing in it is held.
    func hold(_ urls: [URL], now: Date = Date()) -> [DroppedFile] {
        var files: [String: Source] = [:]
        let dropped = urls.map { url in
            let target = url.resolvingSymlinksInPath()
            let values = try? target.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
            if values?.isDirectory == true { return DroppedFile(token: "", name: url.lastPathComponent, bytes: 0, folder: true) }
            let token = UUID().uuidString
            files[token] = .file(target)
            return DroppedFile(token: token, name: url.lastPathComponent, bytes: values?.fileSize ?? 0, folder: false)
        }
        keep(files, now: now)
        return dropped
    }

    /// An image pasted as PNG, named for when it was pasted.
    func hold(png: Data, now: Date = Date()) -> DroppedFile {
        let token = UUID().uuidString
        keep([token: .data(png)], now: now)
        return DroppedFile(token: token, name: Self.pastedName(at: now), bytes: png.count, folder: false)
    }

    /// Up to `size` bytes of what `token` holds, from `at`; a read that comes up short is its last, and lets it go.
    func read(_ token: String, at: Int, size: Int, now: Date = Date()) -> Data? {
        purge(now)
        guard let i = drops.firstIndex(where: { $0.files[token] != nil }), let source = drops[i].files[token] else { return nil }
        drops[i].until = now.addingTimeInterval(Self.window)
        let part = Self.part(of: source, at: at, size: size)
        if (part?.count ?? 0) < size {
            drops[i].files[token] = nil
            if drops[i].files.isEmpty { drops.remove(at: i) }
        }
        return part
    }

    private func keep(_ files: [String: Source], now: Date) {
        purge(now)
        if !files.isEmpty { drops.append(Drop(files: files, until: now.addingTimeInterval(Self.window))) }
    }

    private func purge(_ now: Date) {
        drops.removeAll { $0.until <= now }
    }

    private static func part(of source: Source, at: Int, size: Int) -> Data? {
        switch source {
        case .data(let data):
            return at < data.count ? data.subdata(in: at..<min(at + size, data.count)) : Data()
        case .file(let url):
            guard let file = try? FileHandle(forReadingFrom: url) else { return nil }
            defer { try? file.close() }
            do {
                try file.seek(toOffset: UInt64(at))
                return try file.read(upToCount: size) ?? Data()
            } catch { return nil }
        }
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
/// between. Scalar by scalar, as a shell reads them: a metacharacter in a grapheme with its neighbour is still one. A path
/// with a control character in it, which would run what follows, is left out.
enum ShellEscape {
    private static let special = Set("\\ ()[]{}<>\"'`!#$&;|*?".unicodeScalars)

    static func paths(_ paths: [String]) -> String {
        paths.filter(MachineCommand.typeable).map { path in
            var out = String.UnicodeScalarView()
            for scalar in path.unicodeScalars {
                if special.contains(scalar) { out.append("\\") }
                out.append(scalar)
            }
            return String(out)
        }.joined(separator: " ")
    }
}
