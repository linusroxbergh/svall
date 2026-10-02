import Foundation

/// The fleet's daemon, from the launchd job setup writes, which starts it only when the app asks: while the fleet's window is
/// open. A home with no job (a test fleet's) runs whatever daemon its owner started, which a quit stops all the same.
enum FleetDaemon {
    private static var label: String? {
        Bundle.main.bundleIdentifier.map { $0 + ".svalld" + (SvallHome.directoryName.map { ".\($0)" } ?? "") }
    }

    static func plistPath(label: String) -> String { NSHomeDirectory() + "/Library/LaunchAgents/\(label).plist" }

    private static var plist: String? {
        guard let label else { return nil }
        let file = plistPath(label: label)
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

    /// Ends the fleet off the main thread when the daemon could not be asked to, then calls `done` on main: the daemon first, so
    /// the hooks of the terminals closing after it find nobody to clear the agents its next start resumes, then the tmux server.
    static func kill(then done: @escaping () -> Void) -> DispatchWorkItem {
        let work = DispatchWorkItem {
            if let label, plist != nil {
                run("/bin/launchctl", ["kill", "SIGTERM", "gui/\(getuid())/\(label)"])
                let port = SvallHome.path + "/port"
                var waited = 0
                while FileManager.default.fileExists(atPath: port), waited < 20 { usleep(100_000); waited += 1 }
            }
            run(SvallHome.tmuxBinary, ["-S", SvallHome.path + "/tmux.sock", "kill-server"])
        }
        work.notify(queue: .main, execute: done)
        DispatchQueue.global(qos: .userInitiated).async(execute: work)
        return work
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
