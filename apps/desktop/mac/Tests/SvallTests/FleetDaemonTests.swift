import XCTest
@testable import Svall

final class FleetDaemonTests: XCTestCase {
    func testTheLoadedPlistIsTheJobsOwnPathLine() {
        let printed = """
            gui/501/io.github.linusroxbergh.svall.svalld = {
            \tactive count = 0
            \tpath = /Users/Shared/test/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.plist
            \ttype = LaunchAgent
            \tstate = not running

            \tprogram = /Applications/Svall.app/Contents/Resources/runtime/bin/svalld
            \tstdout path = /Users/linus/.svall/svalld.log
            \tenvironment = {
            \t\tPATH => /usr/bin:/bin
            \t}
            }

            """
        XCTAssertEqual(FleetDaemon.loadedPlist(printed), "/Users/Shared/test/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.plist")
        XCTAssertNil(FleetDaemon.loadedPlist(""))
    }

    private func printed(path: String) -> String {
        "gui/501/io.github.linusroxbergh.svall.svalld = {\n\tactive count = 1\n\tpath = \(path)\n\tstate = running\n}\n"
    }

    func testAJobLoadedFromOurPlistIsLeftRunning() {
        let ours = "/Users/linus/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.plist"
        XCTAssertEqual(FleetDaemon.loadSteps(printed: printed(path: ours), ours: ours, real: { $0 }), [])
    }

    func testAJobLoadedThroughALinkToOurPlistIsLeftRunning() {
        let ours = "/Users/linus/dotfiles/LaunchAgents/io.github.linusroxbergh.svall.svalld.plist"
        let link = "/Users/linus/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.plist"
        XCTAssertEqual(FleetDaemon.loadSteps(printed: printed(path: link), ours: ours, real: { $0 == link ? ours : $0 }), [])
    }

    func testAJobLaunchdDoesNotHaveIsLoadedFromOurPlist() {
        XCTAssertEqual(FleetDaemon.loadSteps(printed: "", ours: "/u/ours.plist", real: { $0 }), [.bootstrap])
    }

    func testAJobLoadedFromAnotherPlistIsBootedOutForOurs() {
        XCTAssertEqual(FleetDaemon.loadSteps(printed: printed(path: "/Users/Shared/test/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.plist"),
                                             ours: "/u/ours.plist", real: { $0 }), [.bootout, .bootstrap])
    }
}
