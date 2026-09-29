import Foundation

/// The NDJSON a child writes, cut into lines as its bytes arrive.
struct LineBuffer {
    private var data = Data()

    mutating func take(_ chunk: Data) -> [String] {
        data.append(chunk)
        var lines: [String] = []
        while let end = data.firstIndex(of: 0x0A) {
            lines.append(String(decoding: data[data.startIndex..<end], as: UTF8.self))
            data.removeSubrange(data.startIndex...end)
        }
        return lines
    }

    /// The child is gone: bytes after the last newline are a line too.
    mutating func end() -> [String] {
        defer { data.removeAll() }
        return data.isEmpty ? [] : [String(decoding: data, as: UTF8.self)]
    }
}

/// The last few whole lines a child wrote to stderr, however its bytes were cut into chunks.
struct StderrTail {
    private var buffer = LineBuffer()
    private let limit: Int
    private(set) var lines: [String] = []

    init(limit: Int = 5) { self.limit = limit }

    mutating func take(_ chunk: Data) { keep(buffer.take(chunk)) }
    mutating func end() { keep(buffer.end()) }

    private mutating func keep(_ new: [String]) {
        let said = new.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        lines = Array((lines + said).suffix(limit))
    }
}

/// A route to the machine that owns the fleet: the SSH master the helper holds open to reach it.
struct RemoteRoute: Equatable {
    let name: String, destination: String, controlSocket: String
}

/// One line of `svall connect --json`.
enum ControllerEvent: Equatable {
    case connecting(owner: String)
    case online(connection: SvallConnection, remote: RemoteRoute?)
    case error(kind: String, message: String)
    case ownerChanged(owner: String)

    private struct Line: Decodable {
        struct Remote: Decodable { let name: String, destination: String, controlSocket: String }
        let type: String
        let owner: String?, host: String?, port: Int?, token: String?, kind: String?, message: String?
        let remote: Remote?
    }

    static func decode(_ line: String) -> ControllerEvent? {
        guard let data = line.data(using: .utf8), let line = try? JSONDecoder().decode(Line.self, from: data) else { return nil }
        switch line.type {
        case "connecting":
            return line.owner.map { .connecting(owner: $0) }
        case "online":
            guard let host = line.host, let port = line.port, let token = line.token else { return nil }
            return .online(connection: SvallConnection(host: host, port: port, token: token),
                           remote: line.remote.map { RemoteRoute(name: $0.name, destination: $0.destination, controlSocket: $0.controlSocket) })
        case "error":
            guard let kind = line.kind, let message = line.message else { return nil }
            return .error(kind: kind, message: message)
        case "owner-changed":
            return line.owner.map { .ownerChanged(owner: $0) }
        default:
            return nil
        }
    }
}

/// The bundled `svall connect --json` helper: one child per window, holding the SSH master and the API
/// forward for as long as its stdin is open, and reporting where the fleet is on its stdout.
final class ControllerProcess {
    /// A dev build points `SVALL_HELPER` at a checkout; a shipped app carries the release in its bundle.
    static func locate(environment: [String: String] = ProcessInfo.processInfo.environment,
                       resourcePath: String? = Bundle.main.resourcePath) -> String? {
        [environment["SVALL_HELPER"], resourcePath.map { $0 + "/release/bin/svall" }]
            .compactMap { $0 }
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static func connectArguments(profile: String?) -> [String] {
        ["connect", "--json"] + (profile.map { ["-p", $0] } ?? [])
    }

    private let child: LineChild
    private var loggedBadLine = false
    private var stopping = false

    var onEvent: (ControllerEvent) -> Void = { _ in }
    var onExit: (Int32) -> Void = { _ in }

    init(executable: String, arguments: [String]) {
        child = LineChild(executable: executable, arguments: arguments, stdin: true, captureStderr: false)
    }

    var isRunning: Bool { child.isRunning }

    func start() throws {
        child.onLine = { [weak self] line in self?.deliver(line) }
        child.onExit = { [weak self] status, _ in
            guard let self, !stopping else { return }
            onExit(status)
        }
        try child.start()
    }

    /// The helper closes its master and forward when its stdin ends, so quitting asks before it insists,
    /// and a helper that holds SIGTERM off mid-open is killed rather than waited on.
    func stop() {
        guard !stopping else { return }
        stopping = true
        child.stop()
    }

    private func deliver(_ line: String) {
        let line = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !stopping, !line.isEmpty else { return }
        guard let event = ControllerEvent.decode(line) else {
            // the line may carry the token, so only its arrival is reported, and only once
            if !loggedBadLine {
                loggedBadLine = true
                NSLog("svall: ignoring a line the connect helper's protocol does not cover")
            }
            return
        }
        onEvent(event)
    }
}

/// The host operations the page may ask the shell to run, and nothing else.
enum HostOp: String, Decodable {
    case add, doctor, upgrade, remove, enable

    /// doctor prints its checks as one report when it ends; the others print a step per line as they go
    var printsReport: Bool { self == .doctor }

    /// enable and remove rewrite fleet.json, which names the fleet's gateway
    var rewritesFleetConfig: Bool { self == .enable || self == .remove }
}

/// What the page named the operation with. Each field belongs to one operation's flags; the fleet an
/// enable is for is the shell's own, never the page's.
struct HostArgs: Decodable, Equatable {
    let name: String
    var ssh: String?
    var forget: Bool?
}

extension String {
    /// Whether the whole value is what an anchored pattern allows.
    func allowed(by pattern: String) -> Bool { range(of: pattern, options: .regularExpression) != nil }
}

/// A machine's registry name: the only name `svall host` and `svall handover` take for one.
let machineNamePattern = "^[a-z][a-z0-9-]{0,31}$"

/// The argv of `svall host <op> … --json`. The page never passes argv: it names an operation and its
/// arguments, and every one of them is held to the flag it belongs to before it becomes a word here.
enum HostCommand {
    /// `fleet` is the profile of the fleet this window runs, which only enable names.
    static func arguments(op: HostOp, args: HostArgs, fleet: String?) -> [String]? {
        guard args.name.allowed(by: machineNamePattern) else { return nil }
        var argv = ["host", op.rawValue, args.name]
        switch op {
        case .add:
            guard let ssh = args.ssh, args.forget == nil,
                  ssh.allowed(by: "^[A-Za-z0-9][A-Za-z0-9._@:\\[\\]-]*$") else { return nil }
            argv += ["--ssh", ssh]
        case .enable:
            guard let fleet, args.ssh == nil, args.forget == nil, fleet.allowed(by: "^[a-z][a-z0-9-]*$") else { return nil }
            argv += ["--fleet", fleet]
        case .remove:
            guard args.ssh == nil else { return nil }
            if args.forget == true { argv.append("--forget") }
        case .doctor, .upgrade:
            guard args.ssh == nil, args.forget == nil else { return nil }
        }
        return argv + ["--json"]
    }
}

/// One run of the bundled `svall host …`: its steps go to the page as the child prints them, and it
/// is killed when the page cancels or the window goes.
final class HostProcess {
    struct Step: Codable, Equatable {
        let step: String, status: String
        let detail: String?, action: String?
    }

    /// What `svall host doctor --json` prints once it is done: each check becomes a step.
    private struct Report: Decodable {
        struct Check: Decodable { let name: String, status: String, detail: String? }
        let checks: [Check]
    }

    private let child: LineChild
    private let report: Bool
    private var cancelled = false
    private var printed: [String] = []
    private var sawFailure = false

    var onStep: (Step) -> Void = { _ in }
    var onExit: (Int32) -> Void = { _ in }

    init(executable: String, arguments: [String], report: Bool = false) {
        self.report = report
        child = LineChild(executable: executable, arguments: arguments, stdin: false)
    }

    var isRunning: Bool { child.isRunning }

    func start() throws {
        child.onLine = { [weak self] line in self?.take(line) }
        child.onExit = { [weak self] status, said in self?.finish(status, said: said) }
        try child.start()
    }

    /// The page gave up on this run; the child holds an ssh master, so it is not left behind.
    func cancel() {
        guard !cancelled else { return }
        cancelled = true
        child.stop()
    }

    private func take(_ line: String) {
        if report { return printed.append(line) }
        if let step = try? JSONDecoder().decode(Step.self, from: Data(line.utf8)) { send(step) }
    }

    private func send(_ step: Step) {
        if step.status == "fail" { sawFailure = true }
        onStep(step)
    }

    /// The end of the run, after its last line: a run that failed with nothing to show for it leaves the user what the
    /// command itself said.
    private func finish(_ status: Int32, said: [String]) {
        if report, let report = try? JSONDecoder().decode(Report.self, from: Data(printed.joined(separator: "\n").utf8)) {
            for check in report.checks { send(Step(step: check.name, status: check.status, detail: check.detail, action: nil)) }
        }
        if status != 0, !sawFailure, !said.isEmpty {
            onStep(Step(step: "svall", status: "fail", detail: said.joined(separator: "\n"), action: nil))
        }
        onExit(status)
    }
}
