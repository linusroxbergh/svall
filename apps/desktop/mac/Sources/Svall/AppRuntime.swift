import AppKit

/// The node and CLI a release build carries, and what the app asks of them; Svall Dev has neither, as desktop:install sets it up.
enum AppRuntime {
    static var cli: (node: String, script: String)? {
        let contents = Bundle.main.bundleURL.appendingPathComponent("Contents")
        let node = contents.appendingPathComponent("Helpers/node").path
        let script = contents.appendingPathComponent("Resources/runtime/svall.mjs").path
        return FileManager.default.isExecutableFile(atPath: node) && FileManager.default.fileExists(atPath: script) ? (node, script) : nil
    }

    /// No launchd agent for the private fleet: this variant was never set up on this Mac, or was uninstalled.
    static var needsSetup: Bool {
        guard cli != nil, let id = Bundle.main.bundleIdentifier else { return false }
        return !FileManager.default.fileExists(atPath: NSHomeDirectory() + "/Library/LaunchAgents/\(id).svalld.plist")
    }

    /// Runs the bundled CLI off the main thread and hands back its exit and stdout (stderr when it failed, else why it failed) on the main thread.
    static func run(_ args: [String], done: @escaping (Bool, String) -> Void) {
        guard let cli else { return done(false, "this build has no bundled CLI") }
        DispatchQueue.global(qos: .userInitiated).async {
            // files, not pipes: a pipe that fills while nothing reads it would stall the CLI and this wait with it
            let out = FileManager.default.temporaryDirectory.appendingPathComponent("svall-\(UUID().uuidString).out")
            let err = out.deletingPathExtension().appendingPathExtension("err")
            FileManager.default.createFile(atPath: out.path, contents: nil)
            FileManager.default.createFile(atPath: err.path, contents: nil)
            defer { try? FileManager.default.removeItem(at: out); try? FileManager.default.removeItem(at: err) }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: cli.node)
            p.arguments = [cli.script] + args
            // setup and uninstall act on the private fleet, whichever fleet this window shows
            var env = ProcessInfo.processInfo.environment
            env.removeValue(forKey: "SVALL_HOME")
            p.environment = env
            p.standardOutput = try? FileHandle(forWritingTo: out)
            p.standardError = try? FileHandle(forWritingTo: err)
            var ok = false
            let failure: String
            do {
                try p.run(); p.waitUntilExit(); ok = p.terminationStatus == 0
                failure = "svall exited with status \(p.terminationStatus)" + (p.terminationReason == .uncaughtSignal ? " (uncaught signal)" : "")
            } catch { NSLog("svall cli: %@", "\(error)"); failure = error.localizedDescription }
            let text = (try? String(contentsOf: ok ? out : err, encoding: .utf8)) ?? ""
            let reply = ok || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : failure
            DispatchQueue.main.async { done(ok, reply) }
        }
    }
}
