import AppKit

struct SvallConnection: Encodable {
    let host: String
    let port: Int
    let token: String
}

enum SvallHome {
    private static let root = Bundle.main.object(forInfoDictionaryKey: "SvallHomeName") as? String ?? ".svall"

    static var path: String {
        ProcessInfo.processInfo.environment["SVALL_HOME"] ?? NSHomeDirectory() + "/" + root
    }

    private static func read(_ file: String) -> String? {
        (try? String(contentsOfFile: path + "/" + file, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The tmux the daemon names in the home, else a search: an app opened from Finder has no Homebrew on PATH, so the search adds it.
    static var tmuxBinary: String {
        if let named = read("tmux-binary"), FileManager.default.isExecutableFile(atPath: named) { return named }
        let path = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        let dirs = path + [NSHomeDirectory() + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        return dirs.map { $0 + "/tmux" }.first { FileManager.default.isExecutableFile(atPath: $0) } ?? "tmux"
    }

    /// The fleet's config.json, created empty when the fleet has none so there is something to edit.
    static func configPath() -> String? {
        let file = path + "/config.json"
        if !FileManager.default.fileExists(atPath: file), !FileManager.default.createFile(atPath: file, contents: Data("{}\n".utf8)) {
            NSLog("svall: could not create %@", file)
            return nil
        }
        return file
    }

    /// The last lines of the daemon log, read from its end so a large log costs no more than a small one.
    static func logTail(_ lines: Int = 20) -> [String] {
        guard let handle = FileHandle(forReadingAtPath: path + "/svalld.log") else { return [] }
        defer { try? handle.close() }
        let end = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: end > 16_384 ? end - 16_384 : 0)
        let text = String(decoding: handle.readDataToEndOfFile(), as: UTF8.self)
        return Array(text.split(separator: "\n").suffix(lines).map(String.init))
    }

    private static var config: [String: Any]? {
        FileManager.default.contents(atPath: path + "/config.json").flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    static func connection() -> SvallConnection? {
        guard let port = read("port").flatMap(Int.init), let token = read("token"), !token.isEmpty else { return nil }
        return SvallConnection(host: config?["host"] as? String ?? "127.0.0.1", port: port, token: token)
    }

    /// Opened from Finder, Spotlight or the Dock, which name no fleet.
    static var bare: Bool { ProcessInfo.processInfo.environment["SVALL_HOME"] == nil }

    static var isPrivate: Bool {
        (path as NSString).standardizingPath == NSHomeDirectory() + "/" + root
    }

    // the name the fleet's directory gives it, nil for the private one
    static var directoryName: String? {
        if isPrivate { return nil }
        let base = ((path as NSString).standardizingPath as NSString).lastPathComponent
        let prefix = root + "-"
        return base.hasPrefix(prefix) ? String(base.dropFirst(prefix.count)) : base
    }

    /// The fleet's own name: config.json's, else its directory's; nil for a private fleet with neither.
    static var fleetName: String? {
        (config?["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? directoryName
    }

    static var displayName: String {
        let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "Svall"
        return fleetName.map { "\(name) · \($0)" } ?? name
    }

    // one saved frame per fleet, so a second window does not land on the first one's; a rename keeps it
    static var frameAutosaveName: String { directoryName.map { "main-Svall · \($0)" } ?? "main" }

    private static var pidFile: String { path + "/app.pid" }
    private static var pid: Int32 { ProcessInfo.processInfo.processIdentifier }
    // app.pid, locked for as long as this process runs; the kernel lets go of it however the process ends
    private static var held: Int32 = -1

    // false when another instance of this app already owns the home; that one is brought to the front.
    // the file names the home beside the pid for the daemon and other fleets, which read it unlocked
    static func claim() -> Bool {
        if held >= 0 { return true }
        let fd = open(pidFile, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        guard fd >= 0 else { NSLog("svall: could not claim %@: %@", pidFile, String(cString: strerror(errno))); return true }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            guard errno != EWOULDBLOCK else {
                close(fd)
                NSLog("svall: another window holds %@", path)
                if let other = appPid(of: path), let app = NSRunningApplication(processIdentifier: other),
                   app.bundleIdentifier == Bundle.main.bundleIdentifier { app.activate() }
                return false
            }
            // a file system without locks, a network one say, leaves the home unguarded
            NSLog("svall: could not lock %@: %@", pidFile, String(cString: strerror(errno)))
        }
        held = fd
        // written in place: a new file would carry no lock
        let line = Array("\(pid)\t\(path)".utf8)
        if ftruncate(fd, 0) != 0 || pwrite(fd, line, line.count, 0) != line.count { NSLog("svall: could not write %@: %@", pidFile, String(cString: strerror(errno))) }
        return true
    }

    /// Whether a script marked the quit on its way as its own; a mark older than its 60 s wait is stale.
    static func takeQuietQuit() -> Bool {
        let file = path + "/quit-quietly"
        guard let made = (try? FileManager.default.attributesOfItem(atPath: file))?[.modificationDate] as? Date else { return false }
        try? FileManager.default.removeItem(atPath: file)
        return Date().timeIntervalSince(made) < 60
    }

    // emptied rather than removed, so a launch that opened the file as this one quit locks the one the next launch sees
    static func release() {
        guard held >= 0, read("app.pid")?.split(separator: "\t").first.flatMap({ Int32($0) }) == pid else { return }
        ftruncate(held, 0)
    }

    /// The pid of the instance that holds another fleet's home, as that home's app.pid names it.
    static func appPid(of home: String) -> pid_t? {
        let text = (try? String(contentsOfFile: home + "/app.pid", encoding: .utf8)) ?? ""
        let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\t", maxSplits: 1)
        guard parts.count == 2, String(parts[1]) == home else { return nil }
        return Int32(parts[0])
    }
}
