import XCTest
@testable import Svall

final class QuitFlowTests: XCTestCase {
    private var sent: [String] = []
    private var asked: [String] = []
    private var kills = 0
    private var holds = 0
    private var answers: [Bool] = []
    private var quits: [Bool] = []
    // what happens while the user's question is up
    private var whileAsked: () -> Void = {}

    private func flow(listening: Bool = true) -> QuitFlow {
        QuitFlow(send: { [unowned self] in sent.append($0.json["type"] as? String ?? "") }, isListening: { listening }, hideWindow: {},
                 confirm: { [unowned self] message, detail in asked.append("\(message) \(detail)"); whileAsked(); return true },
                 kill: { [unowned self] done in kills += 1; done() }, holdStarts: { [unowned self] in holds += 1 },
                 terminate: { [unowned self] in quits.append($0) })
    }

    private func quit(_ flow: QuitFlow, unsaved: [String] = [], working: Int = 0, placed: Int = 0) {
        XCTAssertEqual(flow.ask(confirm: true) { [unowned self] in answers.append($0) }, .terminateLater)
        flow.answered(unsaved: unsaved, working: working, placed: placed)
    }

    func testALocalFleetIsPutToSleepByThePage() {
        let local = flow()
        quit(local, working: 1)
        XCTAssertEqual(sent, ["quit.ask", "quit.stop"])
        XCTAssertEqual(asked, ["Quit Svall? 1 robot is working and will stop. Everything picks up where it left off when you open Svall again."])
        XCTAssertEqual(answers, [])
        local.stopped(ok: true)
        XCTAssertEqual(answers, [true])
        XCTAssertEqual(kills, 0)
    }

    func testRobotsOnWorkersAreSaidToKeepRunningThere() {
        quit(flow(), working: 1, placed: 2)
        quit(flow(), placed: 1)
        XCTAssertEqual(asked, [
            "Quit Svall? 1 robot is working and will stop. Everything picks up where it left off when you open Svall again. 2 robots keep running on their machines.",
            "Quit Svall? The robots on this Mac stop and pick up where they left off when you open Svall again. 1 robot keeps running on its machine.",
        ])
    }

    func testAQuitTheAppStartsWhileOneWaitsLeavesThatOneToFinish() {
        let local = flow()
        XCTAssertEqual(local.ask(confirm: true) { [unowned self] in answers.append($0) }, .terminateLater)
        // an update's quit while the page names its unsaved files, then while the fleet stops
        local.quit(quietly: true)
        local.answered(unsaved: [], working: 0)
        local.quit(quietly: true)
        XCTAssertEqual(quits, [])
        local.stopped(ok: true)
        XCTAssertEqual(answers, [true])
        local.quit(quietly: true)
        XCTAssertEqual(quits, [true])
    }

    func testAQuitTheAppStartsWhileTheUserIsAskedWithNoPageUpWaitsToo() {
        let local = flow(listening: false)
        whileAsked = { local.quit(quietly: true) }
        XCTAssertEqual(local.ask(confirm: true) { [unowned self] in answers.append($0) }, .terminateLater)
        XCTAssertEqual(quits, [])
        XCTAssertEqual(answers, [true])
        local.quit(quietly: false)
        XCTAssertEqual(quits, [false])
    }

    func testADaemonStartAlreadyUnderWayIsHeldOnceTheFleetIsBeingStopped() {
        let local = flow()
        quit(local)
        XCTAssertEqual(holds, 1)
        local.stopped(ok: true)
        XCTAssertEqual(holds, 1)
    }

    func testUnsavedFilesAreNamedBesideTheRobotsThatStop() {
        quit(flow(), unsaved: ["notes.md"], working: 1)
        XCTAssertEqual(asked, ["Quit with unsaved changes? notes.md has changes that were not saved. Quitting drops them. 1 robot is working and will stop."])
    }

    func testAPageThatIsNotUpHasTheFleetEndedFromHere() {
        XCTAssertEqual(flow(listening: false).ask(confirm: false) { [unowned self] in answers.append($0) }, .terminateLater)
        XCTAssertEqual(kills, 1)
        XCTAssertEqual(answers, [true])
    }
}
