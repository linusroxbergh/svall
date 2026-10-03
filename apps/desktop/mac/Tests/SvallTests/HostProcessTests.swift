import XCTest
@testable import Svall

private let step = #"{"step":"ssh","status":"ok","detail":"linus@studio accepted an interactive login"}"#
private let warn = #"{"step":"claude","status":"warn","detail":"1.2.3, not logged in","action":"ssh linus@studio, then claude auth status and log in"}"#
private let outcome = #"{"result":"actions","actions":["ssh linus@studio, then claude auth status and log in"]}"#
// what `svall host doctor --json` prints: one report, through JSON.stringify(report, null, 2)
private let doctorReport = #"""
{
  "machine": "studio",
  "checks": [
    {
      "name": "tmux",
      "status": "ok",
      "detail": "tmux 3.5a"
    },
    {
      "name": "linger",
      "status": "warn",
      "detail": "off for linus: the fleet stops when you log out; run loginctl enable-linger linus"
    },
    {
      "name": "release",
      "status": "fail",
      "detail": "0.4.0, protocol 3; this controller runs 0.5.0, protocol 4"
    }
  ]
}
"""#

final class HostProcessTests: XCTestCase {
    private func argv(_ op: HostOp, _ args: HostArgs, fleet: String? = "work") -> [String]? {
        HostCommand.arguments(op: op, args: args, fleet: fleet)
    }

    private func run(_ process: HostProcess) throws -> (steps: [HostProcess.Step], code: Int32?) {
        var steps: [HostProcess.Step] = []
        var code: Int32?
        let done = expectation(description: "exit")
        process.onStep = { steps.append($0) }
        process.onExit = { code = $0; done.fulfill() }
        try process.start()
        wait(for: [done], timeout: 5)
        return (steps, code)
    }

    func testEachOperationBuildsTheArgvItsFlagsAllow() {
        XCTAssertEqual(argv(.add, HostArgs(name: "studio", ssh: "linus@studio")),
                       ["host", "add", "studio", "--ssh", "linus@studio", "--json"])
        XCTAssertEqual(argv(.doctor, HostArgs(name: "studio")), ["host", "doctor", "studio", "--json"])
        XCTAssertEqual(argv(.upgrade, HostArgs(name: "studio")), ["host", "upgrade", "studio", "--json"])
        XCTAssertEqual(argv(.remove, HostArgs(name: "studio")), ["host", "remove", "studio", "--json"])
        XCTAssertEqual(argv(.remove, HostArgs(name: "studio", forget: true)),
                       ["host", "remove", "studio", "--forget", "--json"])
        XCTAssertEqual(argv(.enable, HostArgs(name: "studio")),
                       ["host", "enable", "studio", "--fleet", "work", "--json"])
        XCTAssertEqual(argv(.enable, HostArgs(name: "studio"), fleet: "private"),
                       ["host", "enable", "studio", "--fleet", "private", "--json"])
    }

    func testTheGatewayIsForTheFleetTheShellRunsNotOneThePageNames() throws {
        let start = #"{"type":"host.start","op":"enable","args":{"name":"studio","fleet":"other"}}"#
        guard case .hostStart(let op, let args) = try JSONDecoder().decode(ToShell.self, from: Data(start.utf8)) else {
            return XCTFail("host.start did not decode")
        }
        XCTAssertEqual(argv(op, args), ["host", "enable", "studio", "--fleet", "work", "--json"])
        // a home that is no profile has no name for --fleet
        XCTAssertNil(argv(.enable, HostArgs(name: "studio"), fleet: nil))
        XCTAssertEqual(argv(.doctor, HostArgs(name: "studio"), fleet: nil), ["host", "doctor", "studio", "--json"])
    }

    func testAFleetIsNamedByTheProfileSvallKnowsItBy() {
        XCTAssertEqual(SvallHome.fleetProfile(of: "/Users/x/.svall", in: "/Users/x"), "private")
        XCTAssertEqual(SvallHome.fleetProfile(of: "/Users/x/.svall-work", in: "/Users/x"), "work")
        XCTAssertNil(SvallHome.fleetProfile(of: "/tmp/somewhere", in: "/Users/x"))
    }

    func testNothingTheFlagsDoNotCoverBecomesArgv() {
        // a name or a destination that could read as an option, or as a second word
        XCTAssertNil(argv(.add, HostArgs(name: "--help", ssh: "linus@studio")))
        XCTAssertNil(argv(.add, HostArgs(name: "Studio", ssh: "linus@studio")))
        XCTAssertNil(argv(.add, HostArgs(name: "studio", ssh: "-oProxyCommand=curl evil")))
        XCTAssertNil(argv(.add, HostArgs(name: "studio", ssh: "linus@studio extra")))
        XCTAssertNil(argv(.add, HostArgs(name: "studio")))
        XCTAssertNil(argv(.enable, HostArgs(name: "studio"), fleet: "--json"))
        // a flag on an operation that does not take it
        XCTAssertNil(argv(.doctor, HostArgs(name: "studio", ssh: "linus@studio")))
        XCTAssertNil(argv(.add, HostArgs(name: "studio", ssh: "linus@studio", forget: true)))
        XCTAssertNil(argv(.upgrade, HostArgs(name: "studio", forget: true)))
    }

    func testThePageAsksForAnOperationByNameOrNotAtAll() throws {
        let start = #"{"type":"host.start","op":"remove","args":{"name":"studio","forget":true}}"#
        guard case .hostStart(let op, let args) = try JSONDecoder().decode(ToShell.self, from: Data(start.utf8)) else {
            return XCTFail("host.start did not decode")
        }
        XCTAssertEqual(op, .remove)
        XCTAssertEqual(args, HostArgs(name: "studio", forget: true))
        guard case .hostCancel = try JSONDecoder().decode(ToShell.self, from: Data(#"{"type":"host.cancel"}"#.utf8)) else {
            return XCTFail("host.cancel did not decode")
        }
        XCTAssertThrowsError(try JSONDecoder().decode(ToShell.self, from: Data(#"{"type":"host.start","op":"format","args":{"name":"studio"}}"#.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(ToShell.self, from: Data(#"{"type":"host.start","op":"add","args":{}}"#.utf8)))
    }

    func testStepsReachThePageAsTheyArriveAndTheExitCodeEndsTheRun() throws {
        let helper = try fakeHelper(prints: ["not json", step, warn, outcome], then: "exit 1")
        let process = HostProcess(executable: helper, arguments: ["host", "add", "studio", "--json"])
        var steps: [HostProcess.Step] = []
        let done = expectation(description: "exit")
        var code: Int32?
        process.onStep = { step in
            XCTAssertTrue(Thread.isMainThread)
            steps.append(step)
        }
        process.onExit = { status in
            code = status
            done.fulfill()
        }
        try process.start()
        wait(for: [done], timeout: 5)
        XCTAssertEqual(steps, [
            HostProcess.Step(step: "ssh", status: "ok", detail: "linus@studio accepted an interactive login", action: nil),
            HostProcess.Step(step: "claude", status: "warn", detail: "1.2.3, not logged in",
                             action: "ssh linus@studio, then claude auth status and log in"),
        ])
        XCTAssertEqual(code, 1)
    }

    func testCancellingStopsAChildThatWouldOtherwiseKeepRunning() throws {
        let helper = try fakeHelper(prints: [step], then: "exec sleep 30")
        let process = HostProcess(executable: helper, arguments: ["host", "doctor", "studio", "--json"])
        let stepped = expectation(description: "step")
        process.onStep = { _ in stepped.fulfill() }
        try process.start()
        wait(for: [stepped], timeout: 5)
        XCTAssertTrue(process.isRunning)
        let began = Date()
        process.cancel()
        XCTAssertFalse(process.isRunning)
        XCTAssertLessThan(Date().timeIntervalSince(began), 5)
    }

    /// A child that holds SIGTERM off is killed after a bounded wait, so a cancel never hangs the window.
    func testCancellingKillsAChildThatHoldsSIGTERMOff() throws {
        let helper = try fakeHelper(prints: [step], then: "trap '' TERM\nwhile :; do sleep 1; done")
        addTeardownBlock { pkill(helper) }
        let process = HostProcess(executable: helper, arguments: ["host", "doctor", "studio", "--json"])
        let stepped = expectation(description: "step")
        process.onStep = { _ in stepped.fulfill() }
        try process.start()
        wait(for: [stepped], timeout: 5)
        let cancelled = expectation(description: "cancelled")
        DispatchQueue.global().async {
            process.cancel()
            cancelled.fulfill()
        }
        wait(for: [cancelled], timeout: 10)
        XCTAssertFalse(process.isRunning)
    }

    /// The end of a run reaches the page only after every step the child printed before it exited.
    func testEveryStepArrivesBeforeTheEndOfTheRun() throws {
        let many = (0..<200).map { #"{"step":"s\#($0)","status":"ok"}"# }
        let helper = try fakeHelper(prints: many, then: "exit 0")
        for round in 0..<20 {
            let process = HostProcess(executable: helper, arguments: [])
            var steps = 0, stepsAtExit = -1
            let done = expectation(description: "exit \(round)")
            process.onStep = { _ in steps += 1 }
            process.onExit = { _ in stepsAtExit = steps; done.fulfill() }
            try process.start()
            wait(for: [done], timeout: 5)
            XCTAssertEqual(stepsAtExit, 200, "round \(round)")
        }
    }

    func testACheckReportsEachOfTheMachinesChecksAsAStep() throws {
        let helper = try fakeHelper(prints: doctorReport.components(separatedBy: "\n"), then: "exit 1")
        let words = try XCTUnwrap(argv(.doctor, HostArgs(name: "studio")))
        let (steps, code) = try run(HostProcess(executable: helper, arguments: words, report: HostOp.doctor.printsReport))
        // a failing check is the failure: nothing from stderr is added after it
        XCTAssertEqual(steps, [
            HostProcess.Step(step: "tmux", status: "ok", detail: "tmux 3.5a", action: nil),
            HostProcess.Step(step: "linger", status: "warn",
                             detail: "off for linus: the fleet stops when you log out; run loginctl enable-linger linus", action: nil),
            HostProcess.Step(step: "release", status: "fail",
                             detail: "0.4.0, protocol 3; this controller runs 0.5.0, protocol 4", action: nil),
        ])
        XCTAssertEqual(code, 1)
        XCTAssertFalse(HostOp.add.printsReport)
    }

    func testStderrIsKeptInWholeLinesAcrossChunksAndUpToTheLastByte() throws {
        let tail = [
            "printf 'Warning: Permanently added studio to the list of known hosts.\\n' >&2",
            "printf 'svall: could not open a master to linus@studio:' >&2",
            "sleep 0.3",
            "printf ' Permission denied (publickey).' >&2",
            "exit 1",
        ].joined(separator: "\n")
        let helper = try fakeHelper(prints: [], then: tail)
        let (steps, _) = try run(HostProcess(executable: helper, arguments: ["host", "doctor", "studio", "--json"], report: true))
        XCTAssertEqual(steps, [HostProcess.Step(step: "svall", status: "fail", detail: [
            "Warning: Permanently added studio to the list of known hosts.",
            "svall: could not open a master to linus@studio: Permission denied (publickey).",
        ].joined(separator: "\n"), action: nil)])
    }

    func testTheStderrTailIsBounded() {
        var tail = StderrTail(limit: 2)
        tail.take(Data("one\ntwo\nthree\nfo".utf8))
        tail.take(Data("ur".utf8))
        XCTAssertEqual(tail.lines, ["two", "three"])
        tail.end()
        XCTAssertEqual(tail.lines, ["three", "four"])
    }

    func testWhatTheChildSaysOnStderrIsKeptWhenNoStepFailed() throws {
        let helper = try fakeHelper(prints: [step], then: "echo 'svall: no registry at ~/.config/svall' >&2\nexit 1")
        let process = HostProcess(executable: helper, arguments: ["host", "doctor", "studio", "--json"])
        var steps: [HostProcess.Step] = []
        let done = expectation(description: "exit")
        process.onStep = { steps.append($0) }
        process.onExit = { _ in done.fulfill() }
        try process.start()
        wait(for: [done], timeout: 5)
        XCTAssertEqual(steps.last, HostProcess.Step(step: "svall", status: "fail",
                                                    detail: "svall: no registry at ~/.config/svall", action: nil))
    }

    func testTheStepsAndTheEndOfARunAreWhatThePageIsSent() {
        let step = HostProcess.Step(step: "ssh", status: "warn", detail: "slow", action: "try again")
        XCTAssertEqual(FromShell.hostStep(op: "add", step: step).json as NSDictionary,
                       ["type": "host.step", "op": "add",
                        "event": ["step": "ssh", "status": "warn", "detail": "slow", "action": "try again"]] as NSDictionary)
        XCTAssertEqual(FromShell.hostStep(op: "doctor", step: HostProcess.Step(step: "machine", status: "ok", detail: nil, action: nil)).json as NSDictionary,
                       ["type": "host.step", "op": "doctor", "event": ["step": "machine", "status": "ok"]] as NSDictionary)
        XCTAssertEqual(FromShell.hostDone(op: "add", code: 1).json as NSDictionary,
                       ["type": "host.done", "op": "add", "code": 1] as NSDictionary)
    }

    func testTheOperationsThatRewriteTheFleetsConfigAreTheOnesThatTellThePageItsGatewayAfresh() {
        XCTAssertTrue(HostOp.enable.rewritesFleetConfig)
        XCTAssertTrue(HostOp.remove.rewritesFleetConfig)
        for op in [HostOp.add, .doctor, .upgrade] { XCTAssertFalse(op.rewritesFleetConfig, op.rawValue) }
    }

    func testTheWindowNamesTheMachineTheFleetIsOn() {
        XCTAssertEqual(RemoteConnection.windowTitle(base: "Svall", owner: "local"), "Svall")
        XCTAssertEqual(RemoteConnection.windowTitle(base: "Svall · work", owner: "studio"), "Svall · work — studio")
    }

    func testTheHandoverControlsFollowTheFleetsOwnConfig() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("svall-home-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let fleet = dir.appendingPathComponent("fleet.json").path

        XCTAssertFalse(SvallHome.handoverEnabled(at: dir.path))
        try #"{"id":"f","handover":{"exclude":[]}}"#.write(toFile: fleet, atomically: true, encoding: .utf8)
        XCTAssertFalse(SvallHome.handoverEnabled(at: dir.path))
        try #"{"id":"f","handover":{"enabled":true}}"#.write(toFile: fleet, atomically: true, encoding: .utf8)
        XCTAssertTrue(SvallHome.handoverEnabled(at: dir.path))
        try "not json".write(toFile: fleet, atomically: true, encoding: .utf8)
        XCTAssertFalse(SvallHome.handoverEnabled(at: dir.path))
    }
}
