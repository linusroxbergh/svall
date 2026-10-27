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

enum BundledSvall {
    /// A dev build points `SVALL_HELPER` at a checkout; a shipped app carries the release in its bundle.
    static func locate(environment: [String: String] = ProcessInfo.processInfo.environment,
                       resourcePath: String? = Bundle.main.resourcePath) -> String? {
        [environment["SVALL_HELPER"], resourcePath.map { $0 + "/release/bin/svall" }]
            .compactMap { $0 }
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }
}

/// The host operations the page may ask the shell to run, and nothing else.
enum HostOp: String, Decodable {
    case add, doctor, upgrade, rollback, remove

    /// doctor prints its checks as one report when it ends; the others print a step per line as they go
    var printsReport: Bool { self == .doctor }
}

/// What the page named the operation with. Each field belongs to one operation's flags.
struct HostArgs: Decodable, Equatable {
    let name: String
    var ssh: String?
    var forget: Bool?
}

extension String {
    /// Whether the whole value is what an anchored pattern allows.
    func allowed(by pattern: String) -> Bool { range(of: pattern, options: .regularExpression) != nil }
}

/// A machine's registry name: the only name `svall host` takes for one.
let machineNamePattern = "^[a-z][a-z0-9-]{0,31}$"

/// An ssh destination the app hands to ssh: never one that reads as a flag.
let sshDestinationPattern = "^[A-Za-z0-9][A-Za-z0-9._@:\\[\\]-]*$"

/// The argv of `svall host <op> … --json`. The page never passes argv: it names an operation and its
/// arguments, and every one of them is held to the flag it belongs to before it becomes a word here.
enum HostCommand {
    static func arguments(op: HostOp, args: HostArgs) -> [String]? {
        guard args.name.allowed(by: machineNamePattern) else { return nil }
        // a rollback is the upgrade command's
        var argv = ["host", op == .rollback ? "upgrade" : op.rawValue, args.name]
        switch op {
        case .add:
            guard let ssh = args.ssh, args.forget == nil,
                  ssh.allowed(by: sshDestinationPattern) else { return nil }
            argv += ["--ssh", ssh]
        case .remove:
            guard args.ssh == nil else { return nil }
            if args.forget == true { argv.append("--forget") }
        case .doctor, .upgrade:
            guard args.ssh == nil, args.forget == nil else { return nil }
        case .rollback:
            guard args.ssh == nil, args.forget == nil else { return nil }
            argv.append("--rollback")
        }
        return argv + ["--json"]
    }
}

/// One run of the bundled `svall host …`: its steps go to the page as the child prints them, and it
/// is killed when the page cancels or the window goes.
final class HostProcess {
    /// A setup row's consent checkbox: the item's fields, whether they are ticked, and what ticking copies.
    struct Tick: Decodable, Equatable {
        let item: String
        let fields: [String]
        let on: Bool
        let preview: [String]
    }

    struct Step: Decodable, Equatable {
        let step: String, status: String
        let detail: String?, action: String?
        // a next command toward `action`'s fix, for the user to run on the machine; more steps may remain
        var run: String? = nil
        // the port a login on the machine is forwarded through, and the consent a row asks for
        var forward: Int? = nil
        var tick: Tick? = nil
    }

    /// What `svall host doctor --json` prints once it is done: each check becomes a step.
    private struct Report: Decodable {
        struct Check: Decodable { let name: String, status: String, detail: String?, action: String?, run: String?, forward: Int?, tick: Tick? }
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
        child = LineChild(executable: executable, arguments: arguments)
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
            for check in report.checks { send(Step(step: check.name, status: check.status, detail: check.detail, action: check.action, run: check.run, forward: check.forward, tick: check.tick)) }
        }
        if status != 0, !sawFailure, !said.isEmpty {
            onStep(Step(step: "svall", status: "fail", detail: said.joined(separator: "\n"), action: nil))
        }
        onExit(status)
    }
}
