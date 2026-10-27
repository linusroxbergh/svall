import AppKit
import XCTest
@testable import Svall

final class SurfaceManagerTests: XCTestCase {
    /// A robot on another machine whose master is gone: the page asks again at once.
    func testAnAttachOverARobotsOwnRouteWhoseMasterIsGoneExitsAtOnce() {
        var ran: [String] = []
        let container = NSView(), webView = NSView()
        let manager = SurfaceManager(container: container, webView: webView) { command, _ in ran.append(command); return nil }
        var exited: [String] = []
        manager.onExited = { exited.append($0) }

        let via = WebVia(ssh: "box", controlSocket: "/tmp/svall-test-no-master-\(UUID().uuidString.prefix(8))")
        manager.show(id: "c_1", rect: WebRect(x: 0, y: 0, width: 10, height: 10), attach: WebAttach(socket: "/s", session: "v-c_1", via: via), opacity: nil)
        XCTAssertEqual(exited, ["c_1"])
        XCTAssertEqual(ran, [])
        withExtendedLifetime((container, webView)) {}
    }
}
