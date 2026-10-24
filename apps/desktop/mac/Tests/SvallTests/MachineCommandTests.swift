import AppKit
import XCTest
@testable import Svall

final class MachineCommandTests: XCTestCase {
    func testAMachineTerminalIsAnSshOfItsOwnThatAsksNothingAndForwardsNoAgent() {
        XCTAssertEqual(MachineCommand.build(WebMachine(ssh: "linus@studio")),
                       "env TERM=xterm-256color ssh -t -o BatchMode=yes -o ForwardAgent=no -- 'linus@studio'")
    }

    /// Codex's login waits for the browser on localhost:1455 there, which only this Mac's own loopback may reach.
    func testALoginsPortIsForwardedFromThisMacsLoopbackOrTheSshQuits() {
        XCTAssertEqual(MachineCommand.build(WebMachine(ssh: "studio", forward: 1455)),
                       "env TERM=xterm-256color ssh -t -o BatchMode=yes -o ForwardAgent=no -o ExitOnForwardFailure=yes -L 127.0.0.1:1455:localhost:1455 -- 'studio'")
        XCTAssertNil(MachineCommand.build(WebMachine(ssh: "studio", forward: 22)))
        XCTAssertNil(MachineCommand.build(WebMachine(ssh: "studio", forward: 70000)))
    }

    func testADestinationThatReadsAsAFlagOrHoldsAShellWordOpensNothing() {
        for ssh in ["-oProxyCommand=sh", "studio; rm -rf ~", "studio'", "", "a b"] {
            XCTAssertNil(MachineCommand.build(WebMachine(ssh: ssh)), ssh)
        }
    }

    /// A newline would run what is typed; only one line of printable text is ever put at the prompt.
    func testOnlyOneLineOfPrintableTextIsTyped() {
        XCTAssertTrue(MachineCommand.typeable("sudo apt install bubblewrap apparmor-profiles && sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict"))
        for text in ["claude auth login\n", "codex\rlogin", "a\u{1b}[201~b", "tab\there", ""] {
            XCTAssertFalse(MachineCommand.typeable(text), text.debugDescription)
        }
    }

    func testThePromptCountsAsUpOnceTheScreenHasShownSomethingAndStoppedChanging() {
        var screen = QuietScreen(quiet: 0.8)
        let t0 = Date()
        XCTAssertFalse(screen.settled("", at: t0))
        // nothing yet but a blank screen, however long it stays so
        XCTAssertFalse(screen.settled("", at: t0 + 5))
        XCTAssertFalse(screen.settled("Welcome to Ubuntu", at: t0 + 5.1))
        XCTAssertFalse(screen.settled("Welcome to Ubuntu", at: t0 + 5.5))
        XCTAssertFalse(screen.settled("Welcome to Ubuntu\nlinus@studio:~$ ", at: t0 + 5.6))
        XCTAssertFalse(screen.settled("Welcome to Ubuntu\nlinus@studio:~$ ", at: t0 + 6.3))
        XCTAssertTrue(screen.settled("Welcome to Ubuntu\nlinus@studio:~$ ", at: t0 + 6.5))
    }

    func testAMachineTerminalRunsItsOwnSshAndThePageHearsWhenNoneOpens() {
        let container = NSView(), webView = NSView()
        var ran: [String] = []
        let manager = SurfaceManager(container: container, webView: webView) { command, _ in ran.append(command); return nil }
        var failed: [String] = []
        manager.onFailed = { id, _ in failed.append(id) }
        manager.show(id: "machine:studio", rect: WebRect(x: 0, y: 0, width: 10, height: 10), attach: nil,
                     machine: WebMachine(ssh: "linus@studio", type: "claude auth login"), opacity: nil)
        XCTAssertEqual(ran, ["env TERM=xterm-256color ssh -t -o BatchMode=yes -o ForwardAgent=no -- 'linus@studio'"])
        // no view could be made here, which the page hears as a terminal that failed
        XCTAssertEqual(failed, ["machine:studio"])
        manager.show(id: "machine:x", rect: WebRect(x: 0, y: 0, width: 10, height: 10), attach: nil, machine: WebMachine(ssh: "-oProxyCommand=sh"), opacity: nil)
        XCTAssertEqual(ran.count, 1)
        XCTAssertEqual(failed, ["machine:studio", "machine:x"])
        withExtendedLifetime((container, webView)) {}
    }

    func testThePageNamesAMachineTerminalByItsDestinationAndWhatToType() throws {
        let json = #"{"type":"term.show","id":"machine:studio","rect":{"x":0,"y":0,"width":10,"height":10},"machine":{"ssh":"linus@studio","type":"codex login","forward":1455}}"#
        guard case .termShow(let id, _, let attach, let machine, _) = try JSONDecoder().decode(ToShell.self, from: Data(json.utf8)) else {
            return XCTFail("not a term.show")
        }
        XCTAssertEqual(id, "machine:studio")
        XCTAssertNil(attach)
        XCTAssertEqual(machine, WebMachine(ssh: "linus@studio", type: "codex login", forward: 1455))
    }
}
