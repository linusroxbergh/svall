import XCTest
@testable import Svall

private let detached = #"{"event":"handover.detached","data":{"pid":4242}}"#
private let freeze = #"{"event":"handover.changed","data":{"transactionId":"tx1","phase":"freeze"}}"#
private let complete = #"{"event":"handover.result","data":{"status":"complete","transactionId":"tx1","generation":2,"characters":[]}}"#
private let blocked = #"{"event":"handover.result","data":{"status":"blocked","phase":"begin","blockers":[{"code":"character_pinned","message":"ada is kept on this machine"}]}}"#
private let status = #"{"event":"handover.status","data":{"standing":"none","safe":[],"reason":"no handover is open"}}"#
private let liveStatus = #"{"event":"handover.status","data":{"standing":"open","phase":"transfer","safe":["resume","abort"],"reason":"handover tx1 is under way","helper":{"pid":4242}}}"#
private let blockedFreeze = #"{"event":"handover.blocked","data":{"transactionId":"tx1","phase":"freeze","blockers":[]}}"#

/// A stand-in for the bundled svall's handover forms: a `--detach` launcher prints its lines and exits, and
/// `attach` prints its lines, then keeps every line of its stdin until EOF, as the real relay does.
private struct FakeHandover {
    let executable: String
    let argv: URL, stdin: URL, events: URL

    func calls() -> [String] {
        ((try? String(contentsOf: argv, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }

    func received() -> [String] {
        ((try? String(contentsOf: stdin, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }
}

final class HandoverTests: XCTestCase {
    private func fake(launcher: [String], launcherExit: Int32 = 0, attach: [String], attachThen: String = "",
                      status: [String] = [], statusExit: Int32 = 0, forgetExit: Int32 = 0) throws -> FakeHandover {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("svall-handover-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let argv = dir.appendingPathComponent("argv"), stdin = dir.appendingPathComponent("stdin"), events = dir.appendingPathComponent("events.ndjson")
        let say = { (lines: [String]) in lines.map { "printf '%s\\n' '\($0)'" }.joined(separator: "\n") }
        let script = """
        #!/bin/sh
        printf '%s\\n' "$*" >> '\(argv.path)'
        case " $* " in
          *" status "*)
        \(say(status))
            echo 'svall: status said this on stderr' >&2
            exit \(statusExit) ;;
          *" --forget "*)
            exit \(forgetExit) ;;
          *" attach "*)
        \(say(attach))
        \(attachThen)
            while IFS= read -r line; do printf '%s\\n' "$line" >> '\(stdin.path)'; done
            exit 0 ;;
          *)
        \(say(launcher))
            echo 'svall: launcher said this on stderr' >&2
            exit \(launcherExit) ;;
        esac

        """
        let path = dir.appendingPathComponent("svall").path
        try script.write(toFile: path, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
        return FakeHandover(executable: path, argv: argv, stdin: stdin, events: events)
    }

    private struct Transcript {
        var lines: [String] = []
        var exits: [(Int32, String?)] = []
        var replays: [[String]] = []
        var moved = 0
    }

    private func session(_ fake: FakeHandover, until done: @escaping (Transcript) -> Bool) -> (HandoverSession, () -> Transcript) {
        let session = HandoverSession(executable: fake.executable, profile: "work", eventsFile: fake.events.path)
        var t = Transcript()
        let finished = expectation(description: "transcript")
        var fulfilled = false
        let check = { if !fulfilled, done(t) { fulfilled = true; finished.fulfill() } }
        session.onLine = { line in
            XCTAssertTrue(Thread.isMainThread)
            t.lines.append(line.event + (line.status.map { " \($0)" } ?? ""))
            check()
        }
        session.onExit = { code, error in t.exits.append((code, error)); check() }
        session.onMoved = { t.moved += 1; check() }
        session.onReplay = { lines in
            XCTAssertTrue(Thread.isMainThread)
            t.replays.append(lines.map { $0.event + ($0.status.map { " \($0)" } ?? "") })
            check()
        }
        return (session, { self.wait(for: [finished], timeout: 5); return t })
    }

    func testEachFormOfTheHelperIsTheArgvTheContractNames() {
        XCTAssertEqual(HandoverCommand.start(to: "studio", choices: nil, gateway: "studio", profile: nil),
                       ["handover", "studio", "--json", "--detach"])
        XCTAssertEqual(HandoverCommand.start(to: "local", choices: nil, gateway: "studio", profile: "work"),
                       ["-p", "work", "handover", "local", "--json", "--detach"])
        XCTAssertEqual(HandoverCommand.start(to: "studio", choices: HandoverChoices(interruptAfterMs: 0, terminateShells: true, archiveRoots: ["r_0a1b", "/w/app"]),
                                             gateway: "studio", profile: nil),
                       ["handover", "studio", "--json", "--detach", "--interrupt-after", "0ms", "--terminate-shells",
                        "--archive", "r_0a1b", "--archive", "/w/app"])
        // the wait the page chose goes on as it chose it, not rounded to a second
        XCTAssertEqual(HandoverCommand.start(to: "studio", choices: HandoverChoices(interruptAfterMs: 1500), gateway: "studio", profile: nil),
                       ["handover", "studio", "--json", "--detach", "--interrupt-after", "1500ms"])
        XCTAssertEqual(HandoverCommand.resume(profile: "work"), ["-p", "work", "handover", "--resume", "--json", "--detach"])
        XCTAssertEqual(HandoverCommand.abort(profile: nil), ["handover", "--abort", "--json", "--detach"])
        XCTAssertEqual(HandoverCommand.attach(profile: "work"), ["-p", "work", "handover", "attach", "--json"])
        XCTAssertEqual(HandoverCommand.status(profile: nil), ["handover", "status", "--json"])
        XCTAssertEqual(HandoverCommand.forget(profile: "work"), ["-p", "work", "handover", "--forget", "--json"])
    }

    func testAHandoverGoesOnlyToThisMacOrTheFleetsGatewayAndNothingElseBecomesArgv() {
        XCTAssertNil(HandoverCommand.start(to: "elsewhere", choices: nil, gateway: "studio", profile: nil))
        XCTAssertNil(HandoverCommand.start(to: "studio", choices: nil, gateway: nil, profile: nil))
        XCTAssertNil(HandoverCommand.start(to: "--resume", choices: nil, gateway: "--resume", profile: nil))
        XCTAssertNil(HandoverCommand.start(to: "local", choices: HandoverChoices(archiveRoots: ["--delete"]), gateway: "studio", profile: nil))
        XCTAssertNil(HandoverCommand.start(to: "local", choices: HandoverChoices(archiveRoots: ["relative/path"]), gateway: "studio", profile: nil))
        XCTAssertNil(HandoverCommand.start(to: "local", choices: HandoverChoices(interruptAfterMs: -1), gateway: "studio", profile: nil))
    }

    func testThePageAsksForAHandoverByTheFormsItMayUse() throws {
        let decode = { (json: String) in try JSONDecoder().decode(ToShell.self, from: Data(json.utf8)) }
        guard case .handoverStart(let to, let choices) = try decode(#"{"type":"handover.start","to":"studio","choices":{"interruptAfterMs":0,"archiveRoots":["r_0a1b"]}}"#) else {
            return XCTFail("handover.start did not decode")
        }
        XCTAssertEqual(to, "studio")
        XCTAssertEqual(choices, HandoverChoices(interruptAfterMs: 0, archiveRoots: ["r_0a1b"]))
        guard case .handoverChoose(let chosen) = try decode(#"{"type":"handover.choose","choices":{"terminateShells":true}}"#) else {
            return XCTFail("handover.choose did not decode")
        }
        XCTAssertEqual(chosen, HandoverChoices(terminateShells: true))
        for (json, name) in [(#"{"type":"handover.resume"}"#, "resume"), (#"{"type":"handover.abort"}"#, "abort"),
                             (#"{"type":"handover.attach"}"#, "attach"), (#"{"type":"handover.cancel"}"#, "cancel"),
                             (#"{"type":"handover.forget"}"#, "forget")] {
            let msg = try decode(json)
            switch (msg, name) {
            case (.handoverResume, "resume"), (.handoverAbort, "abort"), (.handoverAttach, "attach"), (.handoverCancel, "cancel"),
                 (.handoverForget, "forget"): break
            default: XCTFail("\(json) decoded as \(msg)")
            }
        }
        // only the choices the contract names, in the shapes it names
        XCTAssertThrowsError(try decode(#"{"type":"handover.choose","choices":{"terminateShells":"yes"}}"#))
    }

    func testAControlLineIsWhatAttachWritesToTheHelper() throws {
        let choose = try JSONSerialization.jsonObject(with: Data(HandoverControl.choose(HandoverChoices(interruptAfterMs: 0)).line.utf8)) as? NSDictionary
        XCTAssertEqual(choose, ["choose": ["interruptAfterMs": 0]] as NSDictionary)
        XCTAssertEqual(HandoverControl.cancel.line, #"{"cancel":true}"#)
    }

    func testOnlyALineWithAnEventReachesThePage() {
        XCTAssertEqual(HandoverLine.decode(freeze)?.event, "handover.changed")
        XCTAssertEqual(HandoverLine.decode(complete)?.status, "complete")
        XCTAssertEqual(HandoverLine.decode(freeze)?.json["data"] as? NSDictionary, ["transactionId": "tx1", "phase": "freeze"] as NSDictionary)
        XCTAssertNil(HandoverLine.decode("not json"))
        XCTAssertNil(HandoverLine.decode(#"{"type":"online"}"#))
        XCTAssertNil(HandoverLine.decode(#"["handover.changed"]"#))
        XCTAssertEqual(FromShell.handoverEvent(HandoverLine.decode(freeze)!.json).json as NSDictionary,
                       ["type": "handover.event", "event": ["event": "handover.changed", "data": ["transactionId": "tx1", "phase": "freeze"]]] as NSDictionary)
        XCTAssertEqual(FromShell.handoverExit(code: 1, error: "no svall").json as NSDictionary, ["type": "handover.exit", "code": 1, "error": "no svall"] as NSDictionary)
        XCTAssertEqual(FromShell.handoverExit(code: 0, error: nil).json as NSDictionary, ["type": "handover.exit", "code": 0] as NSDictionary)
        XCTAssertEqual(FromShell.handoverReplay([HandoverLine.decode(freeze)!.json]).json as NSDictionary,
                       ["type": "handover.replay", "events": [["event": "handover.changed", "data": ["transactionId": "tx1", "phase": "freeze"]]]] as NSDictionary)
    }

    func testAStartDetachesTheHelperThenFollowsItAndCarriesTheUsersAnswers() throws {
        let fake = try fake(launcher: [detached], attach: [freeze])
        let (session, transcript) = session(fake) { $0.lines.count >= 2 }
        try session.launch(HandoverCommand.start(to: "studio", choices: nil, gateway: "studio", profile: "work")!)
        XCTAssertEqual(transcript().lines, ["handover.detached", "handover.changed"])
        XCTAssertEqual(fake.calls(), ["-p work handover studio --json --detach", "-p work handover attach --json"])

        session.send(.choose(HandoverChoices(interruptAfterMs: 0)))
        session.send(.cancel)
        let deadline = Date().addingTimeInterval(5)
        while fake.received().count < 2, Date() < deadline { usleep(20_000) }
        XCTAssertEqual(fake.received(), [#"{"choose":{"interruptAfterMs":0}}"#, #"{"cancel":true}"#])
        session.stop()
    }

    func testQuittingEndsTheAttachAndNeverAsksTheHelperToStop() throws {
        let fake = try fake(launcher: [detached], attach: [freeze])
        let (session, transcript) = session(fake) { $0.lines.count >= 2 }
        try session.launch(HandoverCommand.start(to: "studio", choices: nil, gateway: "studio", profile: nil)!)
        _ = transcript()
        XCTAssertTrue(session.isFollowing)
        let began = Date()
        session.stop()
        XCTAssertFalse(session.isFollowing)
        XCTAssertLessThan(Date().timeIntervalSince(began), 3)
        XCTAssertEqual(fake.received(), [])
    }

    func testQuittingKillsAnAttachThatHoldsOnPastItsStdinAndSIGTERM() throws {
        let fake = try fake(launcher: [detached], attach: [freeze], attachThen: "trap '' TERM\nwhile :; do sleep 1; done")
        addTeardownBlock { pkill(fake.executable) }
        let (session, transcript) = session(fake) { $0.lines.count >= 2 }
        try session.launch(HandoverCommand.start(to: "studio", choices: nil, gateway: "studio", profile: nil)!)
        _ = transcript()
        let began = Date()
        session.stop()
        XCTAssertLessThan(Date().timeIntervalSince(began), 5)
        XCTAssertFalse(running(fake.executable))
    }

    func testALauncherThatCouldNotStartSaysWhyAndNothingIsFollowed() throws {
        let fake = try fake(launcher: [blocked], launcherExit: 1, attach: [freeze])
        let (session, transcript) = session(fake) { !$0.exits.isEmpty }
        try session.launch(HandoverCommand.resume(profile: nil))
        let t = transcript()
        XCTAssertEqual(t.lines, ["handover.result blocked"])
        XCTAssertEqual(t.exits.map(\.0), [1])
        // the helper's own result says why; stderr is kept for a launcher that said nothing
        XCTAssertNil(t.exits.first?.1)
        XCTAssertEqual(fake.calls(), ["handover --resume --json --detach"])
    }

    func testALauncherThatSaysNothingLeavesThePageItsStderr() throws {
        let fake = try fake(launcher: [], launcherExit: 2, attach: [])
        let (session, transcript) = session(fake) { !$0.exits.isEmpty }
        try session.launch(HandoverCommand.abort(profile: nil))
        let t = transcript()
        XCTAssertEqual(t.exits.first?.0, 2)
        XCTAssertEqual(t.exits.first?.1, "svall: launcher said this on stderr")
    }

    func testAMoveTheLiveHelperCompletedAsksWhereTheFleetIsNow() throws {
        let fake = try fake(launcher: [detached], attach: [freeze, complete], attachThen: "exit 0")
        let (session, transcript) = session(fake) { !$0.exits.isEmpty }
        try session.launch(HandoverCommand.start(to: "studio", choices: nil, gateway: "studio", profile: nil)!)
        let t = transcript()
        XCTAssertEqual(t.lines, ["handover.detached", "handover.changed", "handover.result complete"])
        XCTAssertEqual(t.moved, 1)
        XCTAssertEqual(t.exits.map(\.0), [0])
    }

    func testAMoveReadBackFromTheEventsFileAsksNothing() throws {
        // no helper is live: attach prints the last run's lines, then the status, and exits
        let fake = try fake(launcher: [], attach: [freeze, complete, status], attachThen: "exit 0")
        let (session, transcript) = session(fake) { !$0.exits.isEmpty }
        try session.attach()
        let t = transcript()
        XCTAssertEqual(t.lines, ["handover.changed", "handover.result complete", "handover.status"])
        XCTAssertEqual(t.moved, 0)
        XCTAssertEqual(fake.calls(), ["-p work handover attach --json"])
    }

    func testWithNoHelperLiveTheLastRunIsReadBackWithTheStatusAndNothingIsAttached() throws {
        let fake = try fake(launcher: [], attach: [freeze], status: [status])
        try ([freeze, blockedFreeze, "not json", complete].joined(separator: "\n") + "\n").write(to: fake.events, atomically: true, encoding: .utf8)
        let (session, transcript) = session(fake) { !$0.replays.isEmpty }
        try session.observe()
        let t = transcript()
        XCTAssertEqual(t.replays, [["handover.changed", "handover.blocked", "handover.result complete", "handover.status"]])
        XCTAssertEqual(t.lines, [])
        XCTAssertEqual(t.moved, 0)
        XCTAssertEqual(fake.calls(), ["-p work handover status --json"])
    }

    func testAFleetThatNeverMovedIsReadBackAsItsStatusAlone() throws {
        let fake = try fake(launcher: [], attach: [], status: [status])
        let (session, transcript) = session(fake) { !$0.replays.isEmpty }
        try session.observe()
        XCTAssertEqual(transcript().replays, [["handover.status"]])
    }

    func testALiveHelperIsFollowedFromItsOwnStream() throws {
        let fake = try fake(launcher: [], attach: [freeze], status: [liveStatus])
        let (session, transcript) = session(fake) { !$0.lines.isEmpty }
        try session.observe()
        XCTAssertEqual(transcript().lines, ["handover.changed"])
        XCTAssertEqual(fake.calls(), ["-p work handover status --json", "-p work handover attach --json"])
        session.send(.cancel)
        let deadline = Date().addingTimeInterval(5)
        while fake.received().isEmpty, Date() < deadline { usleep(20_000) }
        XCTAssertEqual(fake.received(), [#"{"cancel":true}"#])
        session.stop()
    }

    func testAStatusThatCouldNotBeReadLeavesThePageItsStderr() throws {
        let fake = try fake(launcher: [], attach: [], status: [], statusExit: 1)
        let (session, transcript) = session(fake) { !$0.exits.isEmpty }
        try session.observe()
        let t = transcript()
        XCTAssertEqual(t.exits.first?.0, 1)
        XCTAssertEqual(t.exits.first?.1, "svall: status said this on stderr")
        XCTAssertEqual(t.replays, [])
    }

    func testForgetDropsTheJournalAndThenReadsTheStandingAgain() throws {
        let fake = try fake(launcher: [], attach: [], status: [status])
        let (session, transcript) = session(fake) { !$0.replays.isEmpty }
        try session.forget()
        XCTAssertEqual(transcript().replays, [["handover.status"]])
        XCTAssertEqual(fake.calls(), ["-p work handover --forget --json", "-p work handover status --json"])
    }

    func testAForgetThatWasRefusedSaysSo() throws {
        let fake = try fake(launcher: [], attach: [], status: [status], forgetExit: 1)
        let (session, transcript) = session(fake) { !$0.exits.isEmpty }
        try session.forget()
        XCTAssertEqual(transcript().exits.first?.0, 1)
        XCTAssertEqual(fake.calls(), ["-p work handover --forget --json"])
    }

    func testTheGatewayIsTheMachineTheFleetNamesInTheRegistry() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("svall-gw-\(UUID().uuidString)")
        let home = root.appendingPathComponent("home"), config = root.appendingPathComponent("config")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let id = "0b9d6c3e-1f2a-4b5c-8d7e-9f0a1b2c3d4e"
        try #"{"machines":{"\#(id)":{"name":"studio","gateway":true},"11111111-1f2a-4b5c-8d7e-9f0a1b2c3d4e":{"name":"mac","gateway":false}}}"#
            .write(to: config.appendingPathComponent("machines.json"), atomically: true, encoding: .utf8)

        XCTAssertNil(SvallHome.gatewayName(home: home.path, configDir: config.path))
        XCTAssertFalse(SvallHome.namesGateway(home: home.path))
        try #"{"id":"f","handover":{"enabled":true}}"#.write(to: home.appendingPathComponent("fleet.json"), atomically: true, encoding: .utf8)
        XCTAssertNil(SvallHome.gatewayName(home: home.path, configDir: config.path))
        XCTAssertFalse(SvallHome.namesGateway(home: home.path))
        try #"{"id":"f","gatewayMachineId":"\#(id)"}"#.write(to: home.appendingPathComponent("fleet.json"), atomically: true, encoding: .utf8)
        XCTAssertEqual(SvallHome.gatewayName(home: home.path, configDir: config.path), "studio")
        XCTAssertTrue(SvallHome.namesGateway(home: home.path))
        try #"{"id":"f","gatewayMachineId":"22222222-1f2a-4b5c-8d7e-9f0a1b2c3d4e"}"#.write(to: home.appendingPathComponent("fleet.json"), atomically: true, encoding: .utf8)
        XCTAssertNil(SvallHome.gatewayName(home: home.path, configDir: config.path))
        // a gateway this Mac's registry has lost is still one the fleet may run on
        XCTAssertTrue(SvallHome.namesGateway(home: home.path))
    }
}
