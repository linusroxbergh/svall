import XCTest
@testable import Archipelago

final class AttachCommandTests: XCTestCase {
    private let attach = WebAttach(socket: "/tmp/archi/fleet.sock", session: "char-1")

    func testLocalAttachRunsTmuxDirectly() {
        let command = AttachCommand.build(route: .local, attach: attach, tmux: "/opt/homebrew/bin/tmux")
        XCTAssertEqual(command, "'/opt/homebrew/bin/tmux' -S '/tmp/archi/fleet.sock' attach -t 'char-1'")
    }

    func testRemoteAttachGoesThroughTheControlSocket() {
        let route = ConnectionRoute.remote(RemoteRoute(name: "studio", destination: "linus@studio", controlSocket: "/tmp/archi/studio.sock"))
        let command = AttachCommand.build(route: route, attach: attach, tmux: "/opt/homebrew/bin/tmux")
        // the socket and session are quoted once for this shell and once more for the far one
        XCTAssertEqual(command, "ssh -S '/tmp/archi/studio.sock' -tt -- 'linus@studio' tmux -S ''\\''/tmp/archi/fleet.sock'\\''' attach -t ''\\''char-1'\\'''")
    }

    /// ssh joins the words after the destination into one line, and the far login shell splits it
    /// again: a fake ssh on PATH does both, so this is the argv the far tmux is handed.
    func testTheFarShellGetsTheSocketAndSessionAsOneWordEach() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("archi-ssh-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let ssh = dir.appendingPathComponent("ssh").path
        try "#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift; done\nshift 2\nexec /bin/sh -c \"printf '%s\\\\n' $*\"\n"
            .write(toFile: ssh, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: ssh)

        let odd = WebAttach(socket: "/home/li nus/.archipelago/tmux.sock", session: "v-it's $(x)")
        let route = ConnectionRoute.remote(RemoteRoute(name: "studio", destination: "linus@studio", controlSocket: "/tmp/a b/studio.sock"))
        let command = try XCTUnwrap(AttachCommand.build(route: route, attach: odd, tmux: "tmux"))

        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/sh")
        shell.arguments = ["-c", command]
        shell.environment = ["PATH": "\(dir.path):/usr/bin:/bin"]
        let out = Pipe()
        shell.standardOutput = out
        try shell.run()
        shell.waitUntilExit()
        let words = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").map(String.init)
        XCTAssertEqual(words, ["tmux", "-S", "/home/li nus/.archipelago/tmux.sock", "attach", "-t", "v-it's $(x)"])
    }

    func testNoCommandIsBuiltWhileTheRouteIsUnknown() {
        XCTAssertNil(AttachCommand.build(route: .pending, attach: attach, tmux: "tmux"))
    }

    func testQuotingSurvivesASingleQuoteInASessionName() {
        let odd = WebAttach(socket: "/tmp/a b.sock", session: "it's")
        XCTAssertEqual(AttachCommand.build(route: .local, attach: odd, tmux: "tmux"),
                       "'tmux' -S '/tmp/a b.sock' attach -t 'it'\\''s'")
    }
}
