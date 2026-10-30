import XCTest
@testable import Svall

final class SurfaceViewTests: XCTestCase {
    func testTheLastLineIsTheFarTmuxsReasonNotSshsClosingLine() {
        let screen = """
            Last login: Mon Oct 20 09:12:01 on ttys004
            open terminal failed: missing or unsuitable terminal: xterm-ghostty
            Shared connection to 100.64.0.7 closed.

            """
        XCTAssertEqual(SurfaceView.lastLine(of: screen), "open terminal failed: missing or unsuitable terminal: xterm-ghostty")
        // past the master's MaxSessions, ssh's own login ends with its unshared line
        XCTAssertEqual(SurfaceView.lastLine(of: "no sessions\nConnection to studio closed.\n"), "no sessions")
    }
}
