import Foundation

/// What the user picked about terminals that are not at rest and destination roots in the way: the only
/// choices the page may pass on, in the shapes `HandoverChoices` has on the wire.
struct HandoverChoices: Codable, Equatable {
    var interruptAfterMs: Int?
    var terminateShells: TerminateShells?
    var archiveRoots: [String]?
}

/// `terminateShells` on the wire: every busy terminal or none, or the characters whose terminals it names.
enum TerminateShells: Codable, Equatable {
    case all(Bool)
    case characters([String])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let all = try? c.decode(Bool.self) { self = .all(all) } else { self = .characters(try c.decode([String].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .all(let all): try c.encode(all)
        case .characters(let ids): try c.encode(ids)
        }
    }
}

/// The argv of `svall handover …`: a detached start, resume or abort, and the `attach` that follows each.
enum HandoverCommand {
    private static func prefix(_ profile: String?) -> [String] {
        profile.map { ["-p", $0] } ?? []
    }

    /// `to` is `local` or the fleet's gateway by its registry name; nothing else is a destination.
    static func start(to: String, choices: HandoverChoices?, gateway: String?, profile: String?) -> [String]? {
        guard to == "local" || to == gateway, to.allowed(by: machineNamePattern) else { return nil }
        var flags: [String] = []
        if let ms = choices?.interruptAfterMs {
            guard ms >= 0 else { return nil }
            flags += ["--interrupt-after", "\(ms)ms"]
        }
        // the flag terminates every busy terminal, so a list of characters is left for the run to ask about again
        if choices?.terminateShells == .all(true) { flags.append("--terminate-shells") }
        for root in choices?.archiveRoots ?? [] {
            // a root by its manifest id, or by its absolute path on the destination
            guard root.allowed(by: "^(r_[0-9a-f]+|/[^\\x00\\n]*)$") else { return nil }
            flags += ["--archive", root]
        }
        return prefix(profile) + ["handover", to, "--json", "--detach"] + flags
    }

    static func resume(profile: String?) -> [String] { prefix(profile) + ["handover", "--resume", "--json", "--detach"] }
    static func abort(profile: String?) -> [String] { prefix(profile) + ["handover", "--abort", "--json", "--detach"] }
    static func attach(profile: String?) -> [String] { prefix(profile) + ["handover", "attach", "--json"] }
    static func status(profile: String?) -> [String] { prefix(profile) + ["handover", "status", "--json"] }
    static func forget(profile: String?) -> [String] { prefix(profile) + ["handover", "--forget", "--json"] }
}

/// A line `attach` passes to the live helper on its stdin.
enum HandoverControl {
    case choose(HandoverChoices)
    case cancel

    var line: String {
        switch self {
        case .choose(let choices):
            let body = (try? JSONEncoder().encode(choices)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
            return #"{"choose":\#(body)}"#
        case .cancel:
            return #"{"cancel":true}"#
        }
    }
}

/// One line the helper printed, kept as the JSON object it is for the page, with what the shell reads from it.
struct HandoverLine {
    let json: [String: Any]
    let event: String
    /// a `handover.result`'s outcome
    let status: String?

    static func decode(_ line: String) -> HandoverLine? {
        guard let data = line.data(using: .utf8),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let event = json["event"] as? String else { return nil }
        let status = event == "handover.result" ? (json["data"] as? [String: Any])?["status"] as? String : nil
        return HandoverLine(json: json, event: event, status: status)
    }
}

/// The handover helper as the window follows it: a `--detach` launcher that starts, resumes or aborts the
/// transaction, then `svall handover attach`, whose stdout is the run and whose stdin carries the user's answers.
/// With no helper live, the last run is read back from the events file instead. The helper outlives the app;
/// quitting ends only the attach.
final class HandoverSession {
    private let executable: String
    private let profile: String?
    private let eventsFile: String
    // a launcher, a status or a forget: one short command at a time
    private var launcher: LineChild?
    private var following: LineChild?
    private var stopped = false

    var onLine: (HandoverLine) -> Void = { _ in }
    /// The last run as the events file kept it, then the status: a finished move read back, never followed.
    var onReplay: ([HandoverLine]) -> Void = { _ in }
    /// The process the page follows ended; `error` is what it said on stderr when it printed nothing the page can show.
    var onExit: (Int32, String?) -> Void = { _, _ in }
    /// A helper this window watched completed the move, so the fleet is elsewhere now.
    var onMoved: () -> Void = {}

    init(executable: String, profile: String?, eventsFile: String) {
        self.executable = executable
        self.profile = profile
        self.eventsFile = eventsFile
    }

    var isFollowing: Bool { following?.isRunning ?? false }

    /// A launcher at a time; its `handover.detached` is followed by an attach.
    func launch(_ argv: [String]) throws {
        guard launcher == nil else { return }
        // the page follows the run this starts, and nothing of the one it followed before
        following?.stop()
        following = nil
        let child = LineChild(executable: executable, arguments: argv, stdin: false)
        var detached = false, said = false
        child.onLine = { [weak self] text in
            guard let self, !stopped, let line = HandoverLine.decode(text) else { return }
            said = true
            if line.event == "handover.detached" { detached = true }
            onLine(line)
        }
        child.onExit = { [weak self] code, stderr in
            guard let self, !stopped else { return }
            launcher = nil
            if code == 0, detached {
                do { try attach() } catch { onExit(1, "\(error)") }
                return
            }
            onExit(code == 0 ? 1 : code, said ? nil : stderr.joined(separator: "\n"))
        }
        launcher = child
        do { try child.start() } catch {
            launcher = nil
            throw error
        }
    }

    /// Asks whether a helper is live: one is followed, and without one the last run is read back with the status.
    func observe() throws {
        following?.stop()
        following = nil
        var status: HandoverLine?
        try run(HandoverCommand.status(profile: profile), line: { if $0.event == "handover.status" { status = $0 } }) { [weak self] code, stderr in
            guard let self else { return }
            guard let status else { return onExit(code == 0 ? 1 : code, stderr.joined(separator: "\n")) }
            if (status.json["data"] as? [String: Any])?["helper"] != nil {
                do { try attach() } catch { onExit(1, "\(error)") }
                return
            }
            let text = (try? String(contentsOfFile: eventsFile, encoding: .utf8)) ?? ""
            onReplay(text.split(separator: "\n").compactMap { HandoverLine.decode(String($0)) } + [status])
        }
    }

    /// Drops a controller journal the gateway has moved on from, then reads the standing again.
    func forget() throws {
        var said: [HandoverLine] = []
        try run(HandoverCommand.forget(profile: profile), line: { said.append($0) }) { [weak self] code, stderr in
            guard let self else { return }
            if code == 0 {
                do { try observe() } catch { onExit(1, "\(error)") }
                return
            }
            said.forEach(onLine)
            onExit(code, said.isEmpty ? stderr.joined(separator: "\n") : nil)
        }
    }

    private func run(_ argv: [String], line: @escaping (HandoverLine) -> Void, exit: @escaping (Int32, [String]) -> Void) throws {
        guard launcher == nil else { return }
        let child = LineChild(executable: executable, arguments: argv, stdin: false)
        child.onLine = { [weak self] text in
            guard let self, !stopped, let parsed = HandoverLine.decode(text) else { return }
            line(parsed)
        }
        child.onExit = { [weak self] code, stderr in
            guard let self, !stopped else { return }
            launcher = nil
            exit(code, stderr)
        }
        launcher = child
        do { try child.start() } catch {
            launcher = nil
            throw error
        }
    }

    /// Follows the live helper from its first event.
    func attach() throws {
        following?.stop()
        let child = LineChild(executable: executable, arguments: HandoverCommand.attach(profile: profile), stdin: true)
        var complete = false, status = false, said = false
        child.onLine = { [weak self, weak child] text in
            guard let self, !stopped, following === child, let line = HandoverLine.decode(text) else { return }
            said = true
            if line.status == "complete" { complete = true }
            if line.event == "handover.status" { status = true }
            onLine(line)
        }
        child.onExit = { [weak self, weak child] code, stderr in
            guard let self, !stopped, following === child else { return }
            following = nil
            onExit(code, code != 0 && !said ? stderr.joined(separator: "\n") : nil)
            // a status after the result means no helper was live: that move is read back, not watched
            if complete, !status { onMoved() }
        }
        following = child
        try child.start()
    }

    func send(_ control: HandoverControl) {
        following?.write(control.line)
    }

    /// Quitting: the attach lets go and the helper goes on; a launcher still starting one is left to finish.
    func stop() {
        stopped = true
        following?.stop()
        following = nil
    }
}
