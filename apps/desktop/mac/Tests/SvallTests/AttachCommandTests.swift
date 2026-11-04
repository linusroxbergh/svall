import XCTest
@testable import Svall

final class AttachCommandTests: XCTestCase {
    private let attach = WebAttach(socket: "/tmp/svall/fleet.sock", session: "robot-1")
    private let studio = WebVia(ssh: "linus@studio", controlSocket: "/tmp/svall/studio.sock")
    private func overStudio(_ a: WebAttach) -> WebAttach { var far = a; far.master = studio; return far }

    func testTheWindowRouteIsThisMacAndARobotOnAWorkerGoesOverItsVia() {
        XCTAssertEqual(AttachCommand.route(attach), .local)
        let far = WebAttach(socket: "/home/linus/.svall/tmux.sock", session: "v-c_1", via: WebVia(ssh: "w1", controlSocket: "/tmp/s"))
        XCTAssertEqual(AttachCommand.route(far), .remote(RemoteRoute(destination: "w1", controlSocket: "/tmp/s")))
    }

    func testARobotOnTheFarHomeGoesOverThisMachinesMasterAndAWorkerOfItNests() {
        let home = RemoteRoute(destination: "linus@studio", controlSocket: "/tmp/svall/studio.sock")
        XCTAssertEqual(AttachCommand.route(overStudio(attach)), .remote(home))
        let worker = overStudio(WebAttach(socket: "/s", session: "v-c_1", via: WebVia(ssh: "w1", controlSocket: "/home/ada/ctl")))
        let inner = RemoteRoute(destination: "w1", controlSocket: "/home/ada/ctl")
        XCTAssertEqual(AttachCommand.route(worker), .nested(outer: home, inner: inner))
        XCTAssertTrue(AttachCommand.route(worker).far)
        XCTAssertTrue(ConnectionRoute.remote(home).far)
        XCTAssertFalse(ConnectionRoute.local.far)
    }

    /// A drop on a worker of a far home is sent there, as one on any machine but this one.
    func testADropOnANestedTerminalIsSentThere() {
        let url = URL(fileURLWithPath: "/tmp/a.png")
        let nested = ConnectionRoute.nested(outer: RemoteRoute(destination: "a", controlSocket: "/a"), inner: RemoteRoute(destination: "b", controlSocket: "/b"))
        XCTAssertEqual(SurfaceManager.drop([url], over: nested), .send([url]))
        XCTAssertEqual(SurfaceManager.drop([url], over: .local), .type("/tmp/a.png"))
    }

    /// Only the first hop's socket is here to probe: the home answers `via` only while its own master answers.
    func testNoNestedCommandIsBuiltWhileTheFirstMasterDoesNotAnswer() {
        let worker = overStudio(WebAttach(socket: "/s", session: "v-c_1", via: WebVia(ssh: "w1", controlSocket: "/home/ada/ctl")))
        var asked: [String] = []
        XCTAssertNil(AttachCommand.build(attach: worker, tmux: "tmux", masterAnswers: { asked.append($0); return false }))
        XCTAssertEqual(asked, ["/tmp/svall/studio.sock"])
        XCTAssertNotNil(AttachCommand.build(attach: worker, tmux: "tmux", masterAnswers: { $0 == "/tmp/svall/studio.sock" }))
    }

    func testLocalAttachRunsTmuxDirectly() {
        let command = AttachCommand.build(attach: attach, tmux: "/opt/homebrew/bin/tmux")
        XCTAssertEqual(command, "'/opt/homebrew/bin/tmux' -S '/tmp/svall/fleet.sock' attach -t '=robot-1'")
    }

    func testRemoteAttachGoesThroughTheControlSocket() {
        let command = AttachCommand.build(attach: overStudio(attach), tmux: "/opt/homebrew/bin/tmux", masterAnswers: { _ in true })
        // the socket and session are quoted once for this shell and once more for the far one. A terminal past the
        // master's MaxSessions opens a login of its own, which never prompts
        XCTAssertEqual(command, "env TERM=xterm-256color ssh -S '/tmp/svall/studio.sock' -o ControlMaster=no -o BatchMode=yes -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -o RemoteCommand=none -tt -- 'linus@studio' tmux -S ''\\''/tmp/svall/fleet.sock'\\''' attach -t ''\\''=robot-1'\\'''")
    }

    /// The far daemon names the tmux that serves its socket, which a companion carries in its own release.
    func testRemoteAttachRunsTheTmuxTheFarDaemonNames() {
        let bundled = WebAttach(socket: "/tmp/svall/fleet.sock", session: "robot-1", tmux: "/home/linus/.local/share/svall/releases/v1/bin/tmux")
        let command = AttachCommand.build(attach: overStudio(bundled), tmux: "/opt/homebrew/bin/tmux", masterAnswers: { _ in true })
        XCTAssertEqual(command, "env TERM=xterm-256color ssh -S '/tmp/svall/studio.sock' -o ControlMaster=no -o BatchMode=yes -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -o RemoteCommand=none -tt -- 'linus@studio' ''\\''/home/linus/.local/share/svall/releases/v1/bin/tmux'\\''' -S ''\\''/tmp/svall/fleet.sock'\\''' attach -t ''\\''=robot-1'\\'''")
    }

    /// A robot placed on another machine is reached over the master the daemon's link to it runs on, whatever the window's route.
    func testViaBuildsAnSshAttachWithTheFarTmuxAndQuotesTheHome() {
        let cmd = AttachCommand.build(attach: WebAttach(socket: "/home/ada lovelace/.svall/tmux.sock", session: "v-c_1", tmux: "/home/ada lovelace/.local/share/svall/current/bin/tmux", via: WebVia(ssh: "100.64.0.7", controlSocket: "/tmp/svall-501/123-abc")), tmux: "/opt/homebrew/bin/tmux", masterAnswers: { _ in true })
        XCTAssertTrue(cmd!.hasPrefix("env TERM=xterm-256color ssh -S '/tmp/svall-501/123-abc'")); XCTAssertTrue(cmd!.contains("'/home/ada lovelace/.svall/tmux.sock'"))
    }

    /// With the master gone, ssh would dial the destination itself, where no check covers which machine answers.
    func testNoCommandIsBuiltWhileTheMasterDoesNotAnswer() {
        var asked: [String] = []
        XCTAssertNil(AttachCommand.build(attach: overStudio(attach), tmux: "tmux", masterAnswers: { asked.append($0); return false }))
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
    func testTheFarShellGetsTheTmuxSocketAndSessionAsOneWordEach() throws {
        let dir = try temporaryDirectory("svall-ssh")
        let ssh = dir.appendingPathComponent("ssh").path
        try "#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift; done\nshift 2\nexec /bin/sh -c \"printf '%s\\\\n' $*\"\n"
            .write(toFile: ssh, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: ssh)

        let odd = WebAttach(socket: "/home/li nus/.svall/tmux.sock", session: "v-it's $(x)", tmux: "/home/li nus/.local/share/svall/current/bin/tmux")
        let command = try XCTUnwrap(AttachCommand.build(attach: overStudio(odd), tmux: "tmux", masterAnswers: { _ in true }))

        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/sh")
        shell.arguments = ["-c", command]
        shell.environment = ["PATH": "\(dir.path):/usr/bin:/bin"]
        let out = Pipe()
        shell.standardOutput = out
        try shell.run()
        shell.waitUntilExit()
        let words = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").map(String.init)
        XCTAssertEqual(words, ["/home/li nus/.local/share/svall/current/bin/tmux", "-S", "/home/li nus/.svall/tmux.sock", "attach", "-t", "=v-it's $(x)"])
    }

    /// Two hops, each with a login shell of its own: a fake ssh on PATH runs what it is handed as a far shell would, so the far
    /// tmux here prints the argv it was handed after both.
    func testEachHopOfANestedAttachQuotesItsWordsForItsOwnShell() throws {
        let dir = try temporaryDirectory("svall-ssh")
        let ssh = dir.appendingPathComponent("ssh").path
        let hops = dir.appendingPathComponent("hops").path
        try "#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift; done\nshift\necho \"$1\" >> \"\(hops)\"\nshift\nexec /bin/sh -c \"$*\"\n"
            .write(toFile: ssh, atomically: true, encoding: .utf8)
        let tmux = dir.appendingPathComponent("far tmux").path
        try "#!/bin/sh\nfor a; do printf '%s\\n' \"$a\"; done\n".write(toFile: tmux, atomically: true, encoding: .utf8)
        for file in [ssh, tmux] { try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file) }

        let odd = overStudio(WebAttach(socket: "/home/li nus/.svall/tmux.sock", session: "v-it's $(x)", tmux: tmux, via: WebVia(ssh: "ada@w1", controlSocket: "/home/li nus/ctl")))
        let command = try XCTUnwrap(AttachCommand.build(attach: odd, tmux: "tmux", masterAnswers: { _ in true }))
        XCTAssertFalse(command.contains("svall-remote.invalid"))

        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/sh")
        shell.arguments = ["-c", command]
        shell.environment = ["PATH": "\(dir.path):/usr/bin:/bin"]
        let out = Pipe()
        shell.standardOutput = out
        try shell.run()
        shell.waitUntilExit()
        let words = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").map(String.init)
        XCTAssertEqual(words, ["-S", "/home/li nus/.svall/tmux.sock", "attach", "-t", "=v-it's $(x)"])
        XCTAssertEqual(try String(contentsOfFile: hops, encoding: .utf8), "linus@studio\nada@w1\n")
    }

    /// libghostty runs the command as `exec -l <command>` with TERM=xterm-ghostty, which ssh would hand the far
    /// tmux; a Linux machine has no terminfo for it, and tmux there refuses to attach.
    func testTheFarSideIsHandedXterm256color() throws {
        let dir = try temporaryDirectory("svall-ssh")
        let ssh = dir.appendingPathComponent("ssh").path
        try "#!/bin/sh\necho \"$TERM\"\n".write(toFile: ssh, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: ssh)

        let command = try XCTUnwrap(AttachCommand.build(attach: overStudio(attach), tmux: "tmux", masterAnswers: { _ in true }))

        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/bash")
        shell.arguments = ["--noprofile", "--norc", "-c", "exec -l \(command)"]
        shell.environment = ["PATH": "\(dir.path):/usr/bin:/bin", "TERM": "xterm-ghostty"]
        let out = Pipe()
        shell.standardOutput = out
        try shell.run()
        shell.waitUntilExit()
        XCTAssertEqual(String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self), "xterm-256color\n")
    }

    func testQuotingSurvivesASingleQuoteInASessionName() {
        let odd = WebAttach(socket: "/tmp/a b.sock", session: "it's")
        XCTAssertEqual(AttachCommand.build(attach: odd, tmux: "tmux"),
                       "'tmux' -S '/tmp/a b.sock' attach -t '=it'\\''s'")
    }
}
