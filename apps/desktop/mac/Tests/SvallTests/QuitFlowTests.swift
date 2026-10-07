import XCTest
@testable import Svall

final class QuitFlowTests: XCTestCase {
    private var sent: [String] = []
    private var asked: [String] = []
    private var kills = 0
    private var answers: [Bool] = []

    private func flow(listening: Bool = true, elsewhere: Bool = false, handover: Bool = false) -> QuitFlow {
        QuitFlow(send: { [unowned self] in sent.append($0.json["type"] as? String ?? "") }, isListening: { listening }, hideWindow: {},
                 elsewhere: { elsewhere }, handoverOpen: { handover },
                 confirm: { [unowned self] message, detail in asked.append("\(message) \(detail)"); return true },
                 kill: { [unowned self] done in kills += 1; done() })
    }

    private func quit(_ flow: QuitFlow, unsaved: [String] = [], working: Int = 0) {
        XCTAssertEqual(flow.ask(confirm: true) { [unowned self] in answers.append($0) }, .terminateLater)
        flow.answered(unsaved: unsaved, working: working)
    }

    func testALocalFleetIsPutToSleepByThePage() {
        let local = flow()
        quit(local, working: 1)
        XCTAssertEqual(sent, ["quit.ask", "quit.stop"])
        XCTAssertEqual(asked, ["Quit Svall? 1 character is working and will stop. Everything picks up where it left off when you open Svall again."])
        XCTAssertEqual(answers, [])
        local.stopped(ok: true)
        XCTAssertEqual(answers, [true])
        XCTAssertEqual(kills, 0)
    }

    func testAFleetThatRunsElsewhereIsNeverAskedToStop() {
        quit(flow(elsewhere: true), working: 1)
        XCTAssertEqual(sent, ["quit.ask"])
        XCTAssertEqual(asked, ["Quit Svall? Your characters keep working on the machine this fleet runs on."])
        // this Mac's daemon alone
        XCTAssertEqual(kills, 1)
        XCTAssertEqual(answers, [true])
    }

    func testAnOpenHandoverKeepsThisMacsDaemonOnEitherRoute() {
        for elsewhere in [false, true] {
            sent = []; asked = []; kills = 0; answers = []
            quit(flow(elsewhere: elsewhere, handover: true), working: 2)
            XCTAssertEqual(sent, ["quit.ask"], "elsewhere: \(elsewhere)")
            XCTAssertEqual(kills, 0, "elsewhere: \(elsewhere)")
            XCTAssertEqual(answers, [true], "elsewhere: \(elsewhere)")
            // this Mac may be where the fleet is going, and its characters may be at rest for the move
            XCTAssertEqual(asked, ["Quit Svall? The handover carries on while Svall is closed."], "elsewhere: \(elsewhere)")
        }
    }

    func testUnsavedFilesAreNamedBesideAnOpenHandover() {
        quit(flow(handover: true), unsaved: ["notes.md"], working: 1)
        XCTAssertEqual(asked, ["Quit with unsaved changes? notes.md has changes that were not saved. Quitting drops them. The handover carries on while Svall is closed."])
        XCTAssertEqual(sent, ["quit.ask"])
        XCTAssertEqual(kills, 0)
    }

    func testAPageThatIsNotUpHasTheFleetEndedFromHere() {
        XCTAssertEqual(flow(listening: false).ask(confirm: false) { [unowned self] in answers.append($0) }, .terminateLater)
        XCTAssertEqual(kills, 1)
        XCTAssertEqual(answers, [true])
    }

    func testAHandoverIsOpenWhileTheControllerOrTheDaemonKeepsAJournalOfIt() throws {
        let home = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("svall-quit-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }
        let write = { (file: String) in
            let url = home.appendingPathComponent(file)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("{}".utf8).write(to: url)
        }
        // what a finished run leaves behind
        try write("controller/events.ndjson")
        try write("controller/handover.log")
        XCTAssertFalse(SvallHome.handoverOpen(at: home.path))
        for journal in ["controller/handover.json", "handover/journal.json"] {
            try write(journal)
            XCTAssertTrue(SvallHome.handoverOpen(at: home.path), journal)
            try FileManager.default.removeItem(at: home.appendingPathComponent(journal))
        }
    }

    func testAPageThatIsNotUpLeavesAnOpenHandoversDaemon() {
        XCTAssertEqual(flow(listening: false, handover: true).ask(confirm: false) { [unowned self] in answers.append($0) }, .terminateNow)
        XCTAssertEqual(sent, [])
        XCTAssertEqual(kills, 0)
    }
}
