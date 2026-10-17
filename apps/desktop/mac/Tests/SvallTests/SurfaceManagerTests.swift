import AppKit
import XCTest
@testable import Svall

final class SurfaceManagerTests: XCTestCase {
    private let studio = ConnectionRoute.remote(RemoteRoute(name: "studio", destination: "linus@studio", controlSocket: "/tmp/svall/studio.sock"))

    /// A rebuild after a dropped master, or after an owner change, never re-runs a stored attach: tmux
    /// destroyed the `v-<id>` viewer session when its client left, so the page is told the surface
    /// exited and asks the daemon for a fresh one.
    func testARebuildTellsThePageEverySurfaceExitedInsteadOfReattachingAStaleSession() {
        var route = ConnectionRoute.pending
        var ran: [String] = []
        let container = NSView(), webView = NSView()
        let manager = SurfaceManager(container: container, webView: webView) { command, _ in ran.append(command); return nil }
        manager.route = { route }
        var exited: [String] = [], failed: [String] = []
        manager.onExited = { exited.append($0) }
        manager.onFailed = { id, _ in failed.append(id) }

        // asked for while the route was unknown, so only remembered
        manager.show(id: "c_1", rect: WebRect(x: 0, y: 0, width: 10, height: 10), attach: WebAttach(socket: "/s", session: "v-c_1"), opacity: nil)
        route = studio
        manager.rebuild()

        XCTAssertEqual(exited, ["c_1"])
        XCTAssertEqual(ran, [])
        XCTAssertEqual(failed, [])
        // told once: the page's fresh attach arrives as a new show
        manager.rebuild()
        XCTAssertEqual(exited, ["c_1"])
        withExtendedLifetime((container, webView)) {}
    }
}
