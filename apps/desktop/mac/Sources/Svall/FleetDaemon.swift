import Foundation

/// The fleet's daemon, as the launchd job setup writes for a profile's home: launchd starts it only when the app asks,
/// so it runs while the fleet's window is open. A home with no job (a test fleet's) runs whatever daemon its owner started,
/// which a quit stops all the same.
enum FleetDaemon {
    private static var label: String? {
        Bundle.main.bundleIdentifier.map { $0 + ".svalld" + (SvallHome.directoryName.map { ".\($0)" } ?? "") }
    }

    private static var plist: String? {
        guard let label else { return nil }
        let file = NSHomeDirectory() + "/Library/LaunchAgents/\(label).plist"
        return FileManager.default.fileExists(atPath: file) ? file : nil
    }

    private static var lastStart = Date.distantPast

    /// Starts the daemon, loading its job first when launchd has not; a running one is left be. At most every 10 s, as
    /// launchd itself spaces restarts, so a daemon that keeps failing is not started on every page retry.
    static func start() {
        guard let label, let plist, Date().timeIntervalSince(lastStart) > 10 else { return }
        lastStart = Date()
        let domain = "gui/\(getuid())"
        DispatchQueue.global(qos: .userInitiated).async {
            if run("/bin/launchctl", ["kickstart", "\(domain)/\(label)"]) != 0 {
                run("/bin/launchctl", ["bootstrap", domain, plist])
                run("/bin/launchctl", ["kickstart", "\(domain)/\(label)"])
            }
        }
    }

    /// Ends the fleet when the daemon could not be asked to, off the main thread, then calls `done` back on it: the daemon
    /// first, so the hooks of the terminals closing after it find nobody to clear the agents its next start resumes, then the
    /// tmux server with every terminal in it.
    static func kill(then done: @escaping () -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            if let label, plist != nil {
                run("/bin/launchctl", ["kill", "SIGTERM", "gui/\(getuid())/\(label)"])
                let port = SvallHome.path + "/port"
                var waited = 0
                while FileManager.default.fileExists(atPath: port), waited < 20 { usleep(100_000); waited += 1 }
            }
            run(tmux, ["-S", SvallHome.path + "/tmux.sock", "kill-server"])
            DispatchQueue.main.async(execute: done)
        }
    }

    @discardableResult
    private static func run(_ path: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }
}
