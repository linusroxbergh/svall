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

/// One line of `archi connect --json`.
enum ControllerEvent: Equatable {
    case connecting(owner: String)
    case online(connection: ArchiConnection, remote: RemoteRoute?)
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
            return .online(connection: ArchiConnection(host: host, port: port, token: token),
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

/// The bundled `archi connect --json` helper: one child per window, holding the SSH master and the API
/// forward for as long as its stdin is open, and reporting where the fleet is on its stdout.
final class ControllerProcess {
    /// A dev build points `ARCHI_HELPER` at a checkout; a shipped app carries the release in its bundle.
    static func locate(environment: [String: String] = ProcessInfo.processInfo.environment,
                       resourcePath: String? = Bundle.main.resourcePath) -> String? {
        [environment["ARCHI_HELPER"], resourcePath.map { $0 + "/release/bin/archi" }]
            .compactMap { $0 }
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static func connectArguments(profile: String?) -> [String] {
        ["connect", "--json"] + (profile.map { ["-p", $0] } ?? [])
    }

    private let process = Process()
    private let input = Pipe(), output = Pipe()
    // read on the pipe's own queue only
    private var buffer = LineBuffer()
    private var loggedBadLine = false
    private var stopping = false

    var onEvent: (ControllerEvent) -> Void = { _ in }
    var onExit: (Int32) -> Void = { _ in }

    init(executable: String, arguments: [String]) {
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardInput = input
        process.standardOutput = output
    }

    var isRunning: Bool { process.isRunning }

    func start() throws {
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            self?.take(data)
        }
        process.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            DispatchQueue.main.async {
                guard let self, !self.stopping else { return }
                self.onExit(status)
            }
        }
        try process.run()
    }

    /// The helper closes its master and forward when its stdin ends, so quitting asks before it insists,
    /// and a helper that holds SIGTERM off mid-open is killed rather than waited on.
    func stop() {
        guard !stopping else { return }
        stopping = true
        output.fileHandleForReading.readabilityHandler = nil
        try? input.fileHandleForWriting.close()
        guard process.isRunning else { return }
        if !exits(within: 1) { process.terminate() }
        if !exits(within: 2) { kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
    }

    private func exits(within seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while process.isRunning, Date() < deadline { usleep(10_000) }
        return !process.isRunning
    }

    private func take(_ data: Data) {
        for line in buffer.take(data) { deliver(line) }
    }

    private func deliver(_ line: String) {
        let line = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return }
        guard let event = ControllerEvent.decode(line) else {
            // the line may carry the token, so only its arrival is reported, and only once
            if !loggedBadLine {
                loggedBadLine = true
                NSLog("archi: ignoring a line the connect helper's protocol does not cover")
            }
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.stopping else { return }
            self.onEvent(event)
        }
    }
}

/// The host operations the page may ask the shell to run, and nothing else.
enum HostOp: String, Decodable {
    case add, doctor, upgrade, remove, enable

    /// doctor prints its checks as one report when it ends; the others print a step per line as they go
    var printsReport: Bool { self == .doctor }
}

/// What the page named the operation with. Each field belongs to one operation's flags; the fleet an
/// enable is for is the shell's own, never the page's.
struct HostArgs: Decodable, Equatable {
    let name: String
    var ssh: String?
    var forget: Bool?
}

/// The argv of `archi host <op> … --json`. The page never passes argv: it names an operation and its
/// arguments, and every one of them is held to the flag it belongs to before it becomes a word here.
enum HostCommand {
    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    /// `fleet` is the profile of the fleet this window runs, which only enable names.
    static func arguments(op: HostOp, args: HostArgs, fleet: String?) -> [String]? {
        guard matches(args.name, "^[a-z][a-z0-9-]{0,31}$") else { return nil }
        var argv = ["host", op.rawValue, args.name]
        switch op {
        case .add:
            guard let ssh = args.ssh, args.forget == nil,
                  matches(ssh, "^[A-Za-z0-9][A-Za-z0-9._@:\\[\\]-]*$") else { return nil }
            argv += ["--ssh", ssh]
        case .enable:
            guard let fleet, args.ssh == nil, args.forget == nil, matches(fleet, "^[a-z][a-z0-9-]*$") else { return nil }
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

/// One run of the bundled `archi host …`: its steps go to the page as the child prints them, and it
/// is killed when the page cancels or the window goes.
final class HostProcess {
    struct Step: Codable, Equatable {
        let step: String, status: String
        let detail: String?, action: String?
    }

    /// What `archi host doctor --json` prints once it is done: each check becomes a step.
    private struct Report: Decodable {
        struct Check: Decodable { let name: String, status: String, detail: String? }
        let checks: [Check]
    }

    private let process = Process()
    private let output = Pipe(), errors = Pipe()
    private let report: Bool
    private var cancelled = false
    // each pipe reads on a queue of its own, and the end of the run reads on main: one lock holds these
    private let lock = NSLock()
    private var buffer = LineBuffer()
    private var printed = Data()
    private var stderr = StderrTail()
    private var sawFailure = false

    var onStep: (Step) -> Void = { _ in }
    var onExit: (Int32) -> Void = { _ in }

    init(executable: String, arguments: [String], report: Bool = false) {
        self.report = report
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = errors
    }

    var isRunning: Bool { process.isRunning }

    func start() throws {
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return handle.readabilityHandler = nil }
            self?.take(data)
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self, !data.isEmpty else { return handle.readabilityHandler = nil }
            lock.withLock { self.stderr.take(data) }
        }
        process.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            DispatchQueue.main.async { self?.finish(status) }
        }
        try process.run()
    }

    /// The page gave up on this run; the child holds an ssh master, so it is not left behind.
    func cancel() {
        guard !cancelled else { return }
        cancelled = true
        guard process.isRunning else { return }
        process.terminate()
        process.waitUntilExit()
    }

    private func take(_ data: Data) {
        for step in steps(in: data) {
            DispatchQueue.main.async { [weak self] in self?.onStep(step) }
        }
    }

    private func steps(in data: Data) -> [Step] {
        lock.withLock {
            if report {
                printed.append(data)
                return []
            }
            return failing(buffer.take(data).compactMap { try? JSONDecoder().decode(Step.self, from: Data($0.utf8)) })
        }
    }

    private func reportSteps() -> [Step] {
        lock.withLock {
            guard report, let report = try? JSONDecoder().decode(Report.self, from: printed) else { return [] }
            return failing(report.checks.map { Step(step: $0.name, status: $0.status, detail: $0.detail, action: nil) })
        }
    }

    // under the lock
    private func failing(_ steps: [Step]) -> [Step] {
        if steps.contains(where: { $0.status == "fail" }) { sawFailure = true }
        return steps
    }

    /// The end of the run, on main: whatever the child printed last is still in its pipes, and a run that
    /// failed with nothing to show for it leaves the user what the command itself said.
    private func finish(_ status: Int32) {
        output.fileHandleForReading.readabilityHandler = nil
        errors.fileHandleForReading.readabilityHandler = nil
        if let rest = try? output.fileHandleForReading.readToEnd(), !rest.isEmpty {
            for step in steps(in: rest) { onStep(step) }
        }
        for step in reportSteps() { onStep(step) }
        let unread = try? errors.fileHandleForReading.readToEnd()
        let (said, failed) = lock.withLock {
            if let unread { stderr.take(unread) }
            stderr.end()
            return (stderr.lines, sawFailure)
        }
        if status != 0, !failed, !said.isEmpty {
            onStep(Step(step: "archi", status: "fail", detail: said.joined(separator: "\n"), action: nil))
        }
        onExit(status)
    }
}
