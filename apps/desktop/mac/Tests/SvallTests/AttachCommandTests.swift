import XCTest
@testable import Svall

final class AttachCommandTests: XCTestCase {
    private let attach = WebAttach(socket: "/tmp/svall/fleet.sock", session: "char-1")

    func testLocalAttachRunsTmuxDirectly() {
        let command = AttachCommand.build(route: .local, attach: attach, tmux: "/opt/homebrew/bin/tmux")
        XCTAssertEqual(command, "'/opt/homebrew/bin/tmux' -S '/tmp/svall/fleet.sock' attach -t '=char-1'")
    }

    func testRemoteAttachGoesThroughTheControlSocket() {
        let route = ConnectionRoute.remote(RemoteRoute(name: "studio", destination: "linus@studio", controlSocket: "/tmp/svall/studio.sock"))
        let command = AttachCommand.build(route: route, attach: attach, tmux: "/opt/homebrew/bin/tmux", masterAnswers: { _ in true })
        // the socket and session are quoted once for this shell and once more for the far one. A terminal past the
        // master's MaxSessions opens a login of its own, which never prompts
        XCTAssertEqual(command, "ssh -S '/tmp/svall/studio.sock' -o ControlMaster=no -o BatchMode=yes -tt -- 'linus@studio' tmux -S ''\\''/tmp/svall/fleet.sock'\\''' attach -t ''\\''=char-1'\\'''")
    }

    /// With the helper's master gone, ssh would dial the destination itself, where no check covers which machine answers.
    func testNoCommandIsBuiltWhileTheMasterDoesNotAnswer() {
        let route = ConnectionRoute.remote(RemoteRoute(name: "studio", destination: "linus@studio", controlSocket: "/tmp/svall/studio.sock"))
        var asked: [String] = []
        XCTAssertNil(AttachCommand.build(route: route, attach: attach, tmux: "tmux", masterAnswers: { asked.append($0); return false }))
        XCTAssertEqual(asked, ["/tmp/svall/studio.sock"])
    }

    func testAMasterAnswersOnlyWhileSomethingListensOnItsSocket() throws {
        let dir = URL(fileURLWithPath: "/tmp").appendingPathComponent("svall-cs-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("m").path
        XCTAssertFalse(ControlSocket.answers(path))
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: Array(path.utf8)) }
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(Darwin.listen(fd, 4), 0)
        XCTAssertTrue(ControlSocket.answers(path))
        // a master that was killed leaves its socket file behind
        Darwin.close(fd)
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
        XCTAssertFalse(ControlSocket.answers(path))
    }

    /// ssh joins the words after the destination into one line, and the far login shell splits it
    /// again: a fake ssh on PATH does both, so this is the argv the far tmux is handed.
    func testTheFarShellGetsTheSocketAndSessionAsOneWordEach() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("svall-ssh-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let ssh = dir.appendingPathComponent("ssh").path
        try "#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift; done\nshift 2\nexec /bin/sh -c \"printf '%s\\\\n' $*\"\n"
            .write(toFile: ssh, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: ssh)

        let odd = WebAttach(socket: "/home/li nus/.svall/tmux.sock", session: "v-it's $(x)")
        let route = ConnectionRoute.remote(RemoteRoute(name: "studio", destination: "linus@studio", controlSocket: "/tmp/a b/studio.sock"))
        let command = try XCTUnwrap(AttachCommand.build(route: route, attach: odd, tmux: "tmux", masterAnswers: { _ in true }))

        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/sh")
        shell.arguments = ["-c", command]
        shell.environment = ["PATH": "\(dir.path):/usr/bin:/bin"]
        let out = Pipe()
        shell.standardOutput = out
        try shell.run()
        shell.waitUntilExit()
        let words = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").map(String.init)
        XCTAssertEqual(words, ["tmux", "-S", "/home/li nus/.svall/tmux.sock", "attach", "-t", "=v-it's $(x)"])
    }

    func testNoCommandIsBuiltWhileTheRouteIsUnknown() {
        XCTAssertNil(AttachCommand.build(route: .pending, attach: attach, tmux: "tmux"))
    }

    func testQuotingSurvivesASingleQuoteInASessionName() {
        let odd = WebAttach(socket: "/tmp/a b.sock", session: "it's")
        XCTAssertEqual(AttachCommand.build(route: .local, attach: odd, tmux: "tmux"),
                       "'tmux' -S '/tmp/a b.sock' attach -t '=it'\\''s'")
    }
}
