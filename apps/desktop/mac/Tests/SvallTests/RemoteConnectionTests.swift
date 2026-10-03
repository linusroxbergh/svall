import XCTest
@testable import Svall

private let localOnline = #"{"type":"online","host":"127.0.0.1","port":8123,"token":"t0ken"}"#
private let remoteOnline = #"{"type":"online","host":"127.0.0.1","port":49321,"token":"other","remote":{"name":"studio","destination":"linus@studio","controlSocket":"/tmp/svall/studio.sock"}}"#

final class RemoteConnectionTests: XCTestCase {
    private var transcript: [String] = []
    private var wanted: XCTestExpectation?
    private var wantedCount = 0

    private func connection(helper: ControllerProcess?, local: SvallConnection? = nil, localOnly: Bool = false) -> RemoteConnection {
        let remote = RemoteConnection(helper: helper, local: { local }, localOnly: { localOnly })
        remote.onConnection = { [unowned self] c in
            record(c.map { "connection \($0.host):\($0.port):\($0.token)" } ?? "connection none")
        }
        remote.onState = { [unowned self] s in
            record("state \(s.state) \(s.owner) \(s.kind ?? "-") \(s.message ?? "-")")
        }
        remote.onSurfaces = { [unowned self] in record("surfaces reattach") }
        return remote
    }

    private func record(_ line: String) {
        transcript.append(line)
        if transcript.count >= wantedCount { wanted?.fulfill() }
    }

    private func waitForTranscript(of count: Int) {
        wantedCount = count
        let done = expectation(description: "\(count) messages")
        wanted = done
        if transcript.count >= count { done.fulfill() }
        wait(for: [done], timeout: 5)
        wanted = nil
    }

    func testWithoutAHelperTheLocalConnectionIsUsedAsBefore() {
        let remote = connection(helper: nil, local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"))
        remote.start()
        XCTAssertEqual(transcript, ["connection 127.0.0.1:8123:t0ken"])
        XCTAssertEqual(remote.route, .local)
        XCTAssertEqual(remote.connection, SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"))
        XCTAssertNil(remote.state)
        remote.stop()
    }

    func testAHelperThatCannotBeStartedLeavesAFleetWithNoGatewayOnThisMac() {
        let helper = ControllerProcess(executable: "/nonexistent/svall", arguments: ["connect", "--json"])
        let remote = connection(helper: helper, local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"), localOnly: true)
        remote.start()
        XCTAssertEqual(transcript.last, "connection 127.0.0.1:8123:t0ken")
        XCTAssertEqual(remote.route, .local)
        remote.stop()
    }

    func testAHelperThatCannotBeStartedDoesNotShowAFleetWithAGatewayFromItsCopyHere() {
        let helper = ControllerProcess(executable: "/nonexistent/svall", arguments: ["connect", "--json"])
        let remote = connection(helper: helper, local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"))
        remote.start()
        XCTAssertEqual(remote.route, .pending)
        XCTAssertNil(remote.connection)
        XCTAssertFalse(transcript.contains { $0.hasPrefix("connection") })
        XCTAssertEqual(remote.state?.state, "error")
        XCTAssertEqual(remote.state?.kind, "other")
        remote.stop()
    }

    func testARemoteOwnerBecomesTheCurrentRoute() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#, remoteOnline])
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []))
        remote.start()
        waitForTranscript(of: 3)
        XCTAssertEqual(transcript, ["state connecting studio - -",
                                    "connection 127.0.0.1:49321:other",
                                    "state online studio - -"])
        XCTAssertEqual(remote.route, .remote(RemoteRoute(name: "studio", destination: "linus@studio", controlSocket: "/tmp/svall/studio.sock")))
        remote.stop()
    }

    func testAnOwnerChangeClosesTheSurfacesBeforeTheNewOwnerComesOnline() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"local"}"#, localOnline,
                                             #"{"type":"owner-changed","owner":"studio"}"#,
                                             #"{"type":"connecting","owner":"studio"}"#, remoteOnline])
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []))
        remote.start()
        waitForTranscript(of: 9)
        XCTAssertEqual(transcript, ["state connecting local - -",
                                    "connection 127.0.0.1:8123:t0ken",
                                    "state online local - -",
                                    "surfaces reattach",
                                    "state owner-changed studio - -",
                                    "state connecting studio - -",
                                    "connection 127.0.0.1:49321:other",
                                    "state online studio - -",
                                    "surfaces reattach"])
        remote.stop()
    }

    func testComingBackOnlineForTheSameOwnerRebuildsTheSurfaces() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#, remoteOnline,
                                             #"{"type":"error","kind":"unreachable","message":"ssh closed"}"#,
                                             #"{"type":"connecting","owner":"studio"}"#, remoteOnline])
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []))
        remote.start()
        waitForTranscript(of: 8)
        XCTAssertEqual(transcript, ["state connecting studio - -",
                                    "connection 127.0.0.1:49321:other",
                                    "state online studio - -",
                                    "state error studio unreachable ssh closed",
                                    "state connecting studio - -",
                                    "connection 127.0.0.1:49321:other",
                                    "state online studio - -",
                                    "surfaces reattach"])
        remote.stop()
    }

    func testTheRouteStaysUnknownUntilTheHelperReportsOnline() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#])
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []))
        remote.start()
        XCTAssertEqual(remote.route, .pending)
        waitForTranscript(of: 1)
        XCTAssertEqual(remote.route, .pending)
        remote.stop()
    }

    func testAnOwnerChangeLeavesTheRouteUnknownUntilTheNewOwnerIsOnline() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"local"}"#, localOnline,
                                             #"{"type":"owner-changed","owner":"studio"}"#])
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []))
        remote.start()
        waitForTranscript(of: 5)
        XCTAssertEqual(remote.route, .pending)
        XCTAssertNil(remote.connection)
        remote.stop()
    }

    func testOnlyALocalFleetsPathsAreFindersToOpen() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#, remoteOnline])
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []))
        remote.start()
        // a fleet whose route is still being opened is most often this Mac's: the connect screen's
        // Reveal svalld.log is exactly what a local daemon that is down needs
        XCTAssertNil(remote.notice(forOpening: "/w/isle"))
        waitForTranscript(of: 3)
        XCTAssertEqual(remote.notice(forOpening: "/w/isle"), "/w/isle is on studio; open it there")
        remote.stop()

        let localOnly = connection(helper: nil, local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"))
        localOnly.start()
        XCTAssertNil(localOnly.notice(forOpening: "/w/isle"))
    }

    func testTheFleetsConfigIsOpenedOnlyOnTheMachineItRunsOn() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#, remoteOnline])
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []))
        remote.start()
        waitForTranscript(of: 3)
        XCTAssertEqual(remote.notice(forConfig: "fleet", at: "/Users/x/.svall/fleet.json"), "/Users/x/.svall/fleet.json is on studio; open it there")
        // Ghostty's config is this Mac's own
        XCTAssertNil(remote.notice(forConfig: "ghostty", at: "/Users/x/.config/ghostty/config"))
        remote.stop()

        let localOnly = connection(helper: nil, local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"))
        localOnly.start()
        XCTAssertNil(localOnly.notice(forConfig: "fleet", at: "/Users/x/.svall/fleet.json"))
    }

    func testThePageIsToldWhereTheLocalDaemonIsNowNotWhereItWasWhenTheHelperSaidOnline() throws {
        var port = 8123
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"local"}"#, localOnline])
        let remote = RemoteConnection(helper: ControllerProcess(executable: helper, arguments: []),
                                      local: { SvallConnection(host: "127.0.0.1", port: port, token: "t0ken") })
        remote.onState = { [unowned self] s in record("state \(s.state)") }
        remote.start()
        waitForTranscript(of: 2)
        // a named profile's daemon restarted, on a port of its own choosing
        port = 9001
        XCTAssertEqual(remote.connection, SvallConnection(host: "127.0.0.1", port: 9001, token: "t0ken"))
        remote.stop()
    }

    func testWithoutAHelperThePageIsToldWhereTheLocalDaemonIsNow() {
        var port = 8123
        let remote = RemoteConnection(helper: nil, local: { SvallConnection(host: "127.0.0.1", port: port, token: "t0ken") })
        remote.start()
        port = 9001
        XCTAssertEqual(remote.connection?.port, 9001)
    }

    func testARemoteOwnerIsReachedThroughTheForwardTheHelperOpened() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#, remoteOnline])
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []), local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"))
        remote.start()
        waitForTranscript(of: 3)
        XCTAssertEqual(remote.connection, SvallConnection(host: "127.0.0.1", port: 49321, token: "other"))
        remote.stop()
    }

    func testAMoveAsksAFreshHelperWhereTheFleetIsNowAndAttachesThere() throws {
        let first = ControllerProcess(executable: try fakeHelper(prints: [#"{"type":"connecting","owner":"local"}"#, localOnline]), arguments: [])
        let remote = connection(helper: first)
        remote.start()
        waitForTranscript(of: 3)
        let second = ControllerProcess(executable: try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#, remoteOnline]), arguments: [])
        remote.reconnect(with: second)
        XCTAssertFalse(first.isRunning)
        // nothing is attached until the new helper says where the fleet is
        XCTAssertEqual(remote.route, .pending)
        waitForTranscript(of: 7)
        XCTAssertEqual(Array(transcript.suffix(4)), ["state connecting studio - -",
                                                     "connection 127.0.0.1:49321:other",
                                                     "state online studio - -",
                                                     "surfaces reattach"])
        XCTAssertEqual(remote.route, .remote(RemoteRoute(name: "studio", destination: "linus@studio", controlSocket: "/tmp/svall/studio.sock")))
        remote.stop()
        XCTAssertFalse(second.isRunning)
    }

    func testAHelperThatDiesWhileTheWindowIsOpenIsAnError() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"local"}"#], then: "exit 3")
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []))
        remote.start()
        waitForTranscript(of: 2)
        XCTAssertEqual(transcript.first, "state connecting local - -")
        XCTAssertEqual(remote.state?.state, "error")
        XCTAssertEqual(remote.state?.kind, "other")
        // the fleet names a gateway, so it may be on another machine
        XCTAssertEqual(remote.route, .pending)
        remote.stop()
    }

    func testAHelperThatDiesBeforeItSaysWhereAFleetWithNoGatewayIsLeavesItOnThisMac() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"local"}"#], then: "exit 3")
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []),
                                local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"), localOnly: true)
        remote.start()
        waitForTranscript(of: 3)
        XCTAssertEqual(transcript, ["state connecting local - -",
                                    "state error local other the connection helper stopped (exit 3)",
                                    "connection 127.0.0.1:8123:t0ken"])
        XCTAssertEqual(remote.route, .local)
        XCTAssertEqual(remote.connection, SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"))
    }

    func testAHelperThatFailsBeforeItSaysWhereAFleetWithNoGatewayIsLeavesItOnThisMac() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"local"}"#,
                                             #"{"type":"error","kind":"other","message":"svalld is not running"}"#])
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []),
                                local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"), localOnly: true)
        remote.start()
        waitForTranscript(of: 3)
        XCTAssertEqual(Array(transcript.suffix(1)), ["connection 127.0.0.1:8123:t0ken"])
        XCTAssertEqual(remote.route, .local)
        remote.stop()
    }

    func testAHelperThatFailsOnceTheFleetWasOnlineKeepsTheRouteItHad() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#, remoteOnline], then: "exit 3")
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []), localOnly: true)
        remote.start()
        waitForTranscript(of: 4)
        XCTAssertEqual(remote.state?.state, "error")
        XCTAssertEqual(remote.route, .remote(RemoteRoute(name: "studio", destination: "linus@studio", controlSocket: "/tmp/svall/studio.sock")))
        remote.stop()
    }

    func testStoppingClosesTheHelper() throws {
        let child = ControllerProcess(executable: try fakeHelper(prints: [#"{"type":"connecting","owner":"local"}"#]), arguments: [])
        let remote = connection(helper: child)
        remote.start()
        waitForTranscript(of: 1)
        remote.stop()
        XCTAssertFalse(child.isRunning)
    }
}
