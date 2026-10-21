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

    /// Starts the daemon, loading its job first when launchd has not, or has the label from another plist (a test fleet's,
    /// another copy of Svall's); a running one of ours is left be. At most every 10 s, as launchd itself spaces restarts,
    /// so a daemon that keeps failing is not started on every page retry.
    static func start() {
        guard let label, let plist, Date().timeIntervalSince(lastStart) > 10 else { return }
        lastStart = Date()
        let domain = "gui/\(getuid())", job = "\(domain)/\(label)"
        let ours = realPath(plist)
        DispatchQueue.global(qos: .userInitiated).async {
            for step in loadSteps(printed: run("/bin/launchctl", ["print", job]).printed, ours: ours) {
                switch step {
                case .bootout:
                    run("/bin/launchctl", ["bootout", job])
                case .bootstrap:
                    // launchd refuses a bootstrap while the job it booted out is still going away, so a refusal is tried once more
                    if run("/bin/launchctl", ["bootstrap", domain, plist]).status != 0 {
                        usleep(500_000)
                        run("/bin/launchctl", ["bootstrap", domain, plist])
                    }
                }
            }
            run("/bin/launchctl", ["kickstart", job])
        }
    }

    enum LoadStep: Equatable { case bootout, bootstrap }

    /// What has launchd run the job from `ours`, a real path: nothing when it already does, else a bootout of the job another
    /// plist loaded under the label and a bootstrap of ours. launchd names the plist as it was given, perhaps through a link.
    static func loadSteps(printed: String, ours: String, real: (String) -> String = realPath) -> [LoadStep] {
        guard let loaded = loadedPlist(printed) else { return [.bootstrap] }
        return real(loaded) == ours ? [] : [.bootout, .bootstrap]
    }

    static func realPath(_ path: String) -> String {
        realpath(path, nil).map { p in defer { free(p) }; return String(cString: p) } ?? path
    }

    /// The plist `launchctl print` says its job was loaded from.
    static func loadedPlist(_ printed: String) -> String? {
        printed.split(separator: "\n").first { $0.hasPrefix("\tpath = ") }.map { String($0.dropFirst("\tpath = ".count)) }
    }

    /// Ends the fleet off the main thread when the daemon could not be asked to, then calls `done` on main: the daemon first, so
    /// the hooks of the terminals closing after it find nobody to clear the agents its next start resumes, then the tmux server.
    static func kill(then done: @escaping () -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            if let label, plist != nil {
                run("/bin/launchctl", ["kill", "SIGTERM", "gui/\(getuid())/\(label)"])
                let port = SvallHome.path + "/port"
                var waited = 0
                while FileManager.default.fileExists(atPath: port), waited < 20 { usleep(100_000); waited += 1 }
            }
            run(SvallHome.tmuxBinary, ["-S", SvallHome.path + "/tmux.sock", "kill-server"])
            // by the run loop, not the main queue: a quit started from a main-queue block holds that queue while AppKit waits on it
            RunLoop.main.perform(inModes: [.common], block: done)
        }
    }

    @discardableResult
    private static func run(_ path: String, _ args: [String]) -> (printed: String, status: Int32) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return ("", -1) }
        let printed = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        return (printed, p.terminationStatus)
    }
}
