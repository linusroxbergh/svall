import Foundation

/// The Mac's one record of the app's keys, beside machines.json: what every fleet's window and both builds read.
/// Only bindings the user or the first launch changed; a key's null is an action left unbound.
enum BindingsRecord {
    static func file(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        (environment["SVALL_CONFIG_DIR"] ?? NSHomeDirectory() + "/.config/svall") + "/bindings.json"
    }

    /// Nil when there is none, or what is there is no record: the page then writes one.
    static func read(from file: String = file()) -> [String: Any]? { readJSON(file) }

    static func write(_ bindings: [String: String?], to file: String = file()) {
        do {
            let dir = (file as NSString).deletingLastPathComponent
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try JSONEncoder().encode(bindings).write(to: URL(fileURLWithPath: file), options: .atomic)
        } catch {
            NSLog("bindings: could not write %@: %@", file, "\(error)")
        }
    }
}
