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

    func testADropTypesThisMacsEscapedPathsIntoALocalTerminalAndSendsAFarOnesThere() {
        let urls = [URL(fileURLWithPath: "/Users/ada/Desktop/Screen Shot (1).png"), URL(fileURLWithPath: "/tmp/notes.txt")]
        XCTAssertEqual(SurfaceManager.drop(urls, over: .local), .type(#"/Users/ada/Desktop/Screen\ Shot\ \(1\).png /tmp/notes.txt"#))
        XCTAssertEqual(SurfaceManager.drop(urls, over: .remote(RemoteRoute(destination: "box", controlSocket: "/tmp/s"))), .send(urls))
    }

    private let rect = WebRect(x: 0, y: 0, width: 10, height: 10)
    private let file = URL(fileURLWithPath: "/tmp/notes.txt")

    private func manager() -> (SurfaceManager, views: () -> [SurfaceView]) {
        let container = NSView(), webView = NSView()
        container.addSubview(webView)
        addTeardownBlock { withExtendedLifetime((container, webView)) {} }
        var made: [SurfaceView] = []
        let manager = SurfaceManager(container: container, webView: webView) { _, frame in
            let view = SurfaceView(frame: frame)
            made.append(view)
            return view
        }
        return (manager, { made })
    }

    func testALocalTerminalSendsNothingAway() throws {
        let (manager, views) = manager()
        var sent: [String] = []
        manager.onDrop = { id, _ in sent.append(id) }
        manager.show(id: "c_1", rect: rect, attach: WebAttach(socket: "/s", session: "v-c_1"), opacity: nil)
        let view = try XCTUnwrap(views().first)
        XCTAssertNil(view.onImagePaste)
        try XCTUnwrap(view.onDropFiles)([file])
        XCTAssertEqual(sent, [])
    }

    func testATerminalOnAnotherMachineSendsItsDropsAndImagesThere() throws {
        let dir = URL(fileURLWithPath: "/tmp").appendingPathComponent("svall-sm-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let master = dir.appendingPathComponent("m").path
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        defer { Darwin.close(fd) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: Array(master.utf8)) }
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(Darwin.listen(fd, 4), 0)

        let (manager, views) = manager()
        var sent: [(String, [DroppedFile])] = []
        manager.onDrop = { sent.append(($0, $1)) }
        manager.show(id: "c_1", rect: rect, attach: WebAttach(socket: "/s", session: "v-c_1", via: WebVia(ssh: "box", controlSocket: master)), opacity: nil)
        let view = try XCTUnwrap(views().first)
        XCTAssertNotNil(view.onImagePaste)
        try XCTUnwrap(view.onDropFiles)([file])
        XCTAssertEqual(sent.map(\.0), ["c_1"])
        XCTAssertEqual(sent.first?.1.map(\.name), ["notes.txt"])
    }
}
