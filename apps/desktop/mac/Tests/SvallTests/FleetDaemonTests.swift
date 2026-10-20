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
}
