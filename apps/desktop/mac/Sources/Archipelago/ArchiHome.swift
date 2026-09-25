import AppKit

struct ArchiConnection: Encodable {
    let host: String
    let port: Int
    let token: String
}

enum ArchiHome {
    static var path: String {
        ProcessInfo.processInfo.environment["ARCHI_HOME"] ?? NSHomeDirectory() + "/.archipelago"
    }

    private static func read(_ file: String) -> String? {
        (try? String(contentsOfFile: path + "/" + file, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The tmux the daemon runs, as it names it in the home.
    static var tmux: String? { read("tmux-binary") }

    /// The fleet's config.json, created empty when the fleet has none so there is something to edit.
    static func configPath() -> String? {
        let file = path + "/config.json"
        if !FileManager.default.fileExists(atPath: file), !FileManager.default.createFile(atPath: file, contents: Data("{}\n".utf8)) {
            NSLog("archi: could not create %@", file)
            return nil
        }
        return file
    }

    /// The last lines of the daemon log, read from its end so a large log costs no more than a small one.
    static func logTail(_ lines: Int = 20) -> [String] {
        guard let handle = FileHandle(forReadingAtPath: path + "/archid.log") else { return [] }
        defer { try? handle.close() }
        let end = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: end > 16_384 ? end - 16_384 : 0)
        let text = String(decoding: handle.readDataToEndOfFile(), as: UTF8.self)
        return Array(text.split(separator: "\n").suffix(lines).map(String.init))
    }

    static func connection() -> ArchiConnection? {
        guard let port = read("port").flatMap(Int.init), let token = read("token"), !token.isEmpty else { return nil }
        var host = "127.0.0.1"
        if let data = FileManager.default.contents(atPath: path + "/config.json"),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let h = json["host"] as? String {
            host = h
        }
        return ArchiConnection(host: host, port: port, token: token)
    }

    private static var isPrivate: Bool {
        (path as NSString).standardizingPath == NSHomeDirectory() + "/.archipelago"
    }

    /// The fleet's own name, nil for the private one.
    static var fleetName: String? {
        if isPrivate { return nil }
        let base = ((path as NSString).standardizingPath as NSString).lastPathComponent
        let prefix = ".archipelago-"
        return base.hasPrefix(prefix) ? String(base.dropFirst(prefix.count)) : base
    }

    static var displayName: String { fleetName.map { "Archipelago · \($0)" } ?? "Archipelago" }

    // one saved frame per fleet, so a second window does not land on the first one's
    static var frameAutosaveName: String { isPrivate ? "main" : "main-\(displayName)" }

    private static var pidFile: String { path + "/app.pid" }
    private static var pid: Int32 { ProcessInfo.processInfo.processIdentifier }

    // false when another instance of this app already owns the home; that one is brought to the front.
    // the home travels with the pid so a recycled pid belonging to another fleet is taken over, not obeyed
    static func claim() -> Bool {
        let parts = (read("app.pid") ?? "").split(separator: "\t", maxSplits: 1)
        if let other = parts.first.flatMap({ Int32($0) }), other != pid, parts.count == 2, String(parts[1]) == path,
           let app = NSRunningApplication(processIdentifier: other), app.bundleIdentifier == Bundle.main.bundleIdentifier {
            app.activate()
            return false
        }
        do { try "\(pid)\t\(path)".write(toFile: pidFile, atomically: true, encoding: .utf8) }
        catch { NSLog("archi: could not claim %@: %@", pidFile, "\(error)") }
        return true
    }

    static func release() {
        guard read("app.pid")?.split(separator: "\t").first.flatMap({ Int32($0) }) == pid else { return }
        try? FileManager.default.removeItem(atPath: pidFile)
    }

    /// The pid of the instance that holds another fleet's home, as that home's app.pid names it.
    static func appPid(of home: String) -> pid_t? {
        let text = (try? String(contentsOfFile: home + "/app.pid", encoding: .utf8)) ?? ""
        let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\t", maxSplits: 1)
        guard parts.count == 2, String(parts[1]) == home else { return nil }
        return Int32(parts[0])
    }
}
