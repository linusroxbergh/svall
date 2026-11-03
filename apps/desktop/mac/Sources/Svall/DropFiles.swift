import AppKit

/// A file dropped, or an image pasted, into a terminal on another machine, as the page is told of it.
struct DroppedFile: Equatable {
    let token: String, name: String, bytes: Int, folder: Bool

    var json: [String: Any] { ["token": token, "name": name, "bytes": bytes, "folder": folder] }
}

/// What the page reads at `svall://app/__drop/<token>?at=&size=`, one part per request, so no more than a part is held.
/// Every hold shares one deadline, five minutes past the last hold or read, so the last file of a drop outlives the
/// upload of those before it.
final class DropFiles {
    static let shared = DropFiles()
    static let path = "/__drop/"

    private enum Source { case file(URL), data(Data) }
    private var held: [String: Source] = [:]
    private var until = Date.distantPast

    /// The files at `urls` for the page to read, a link read as what it names; a folder is named for the page to refuse,
    /// and nothing in it is held.
    func hold(_ urls: [URL], now: Date = Date()) -> [DroppedFile] {
        urls.map { url in
            let target = url.resolvingSymlinksInPath()
            let values = try? target.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
            if values?.isDirectory == true { return DroppedFile(token: "", name: url.lastPathComponent, bytes: 0, folder: true) }
            return DroppedFile(token: hold(.file(target), now: now), name: url.lastPathComponent, bytes: values?.fileSize ?? 0, folder: false)
        }
    }

    /// An image pasted as PNG, named for when it was pasted.
    func hold(png: Data, now: Date = Date()) -> DroppedFile {
        DroppedFile(token: hold(.data(png), now: now), name: Self.pastedName(at: now), bytes: png.count, folder: false)
    }

    /// Up to `size` bytes of what `token` holds, from `at`; a read that comes up short is its last, and lets it go.
    func read(_ token: String, at: Int, size: Int, now: Date = Date()) -> Data? {
        renew(now)
        guard let source = held[token] else { return nil }
        let part = Self.part(of: source, at: at, size: size)
        if (part?.count ?? 0) < size { held[token] = nil }
        return part
    }

    private func hold(_ source: Source, now: Date) -> String {
        renew(now)
        let token = UUID().uuidString
        held[token] = source
        return token
    }

    private func renew(_ now: Date) {
        if now >= until { held = [:] }
        until = now.addingTimeInterval(300)
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
