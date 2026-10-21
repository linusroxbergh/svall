import XCTest
@testable import Svall

private let localOnline = #"{"type":"online","host":"127.0.0.1","port":8123,"token":"t0ken"}"#
private let remoteOnline = #"{"type":"online","host":"127.0.0.1","port":49321,"token":"other","remote":{"name":"studio","destination":"linus@studio","controlSocket":"/tmp/svall/studio.sock"}}"#

final class RemoteConnectionTests: XCTestCase {
    private var transcript: [String] = []
    private var wanted: XCTestExpectation?
    private var wantedCount = 0

    private func connection(helper: ControllerProcess?, local: SvallConnection? = nil, localOnly: @escaping () -> Bool = { false },
                            answerWithin: TimeInterval = 10, cachedHere: @escaping () -> Bool = { false }) -> RemoteConnection {
        let remote = RemoteConnection(helper: helper, local: { local }, localOnly: localOnly, answerWithin: answerWithin, cachedHere: cachedHere)
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

    private func pause(_ seconds: TimeInterval) {
        let done = expectation(description: "\(seconds) s")
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { done.fulfill() }
        wait(for: [done], timeout: seconds + 2)
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

    func testAFleetWithNoGatewayIsOnThisMacAtOnceWithNoHelper() throws {
        let helper = ControllerProcess(executable: try fakeHelper(prints: [#"{"type":"connecting","owner":"local"}"#]), arguments: [])
        let remote = connection(helper: helper, local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"), localOnly: { true })
        remote.start()
        XCTAssertEqual(transcript, ["connection 127.0.0.1:8123:t0ken"])
        XCTAssertEqual(remote.route, .local)
        XCTAssertFalse(helper.isRunning)
        remote.stop()
    }

    func testAFleetThatGainedAGatewayGetsTheHelperItWentWithout() throws {
        var gateway = false
        let remote = connection(helper: ControllerProcess(executable: try fakeHelper(prints: []), arguments: []),
                                local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"), localOnly: { !gateway })
        remote.start()
        let unused = ControllerProcess(executable: try fakeHelper(prints: []), arguments: [])
        remote.followIfGatewayNamed(with: unused)
        XCTAssertFalse(unused.isRunning)
        gateway = true
        let next = ControllerProcess(executable: try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#, remoteOnline]), arguments: [])
        remote.followIfGatewayNamed(with: next)
        waitForTranscript(of: 4)
        XCTAssertEqual(remote.route, .remote(RemoteRoute(name: "studio", destination: "linus@studio", controlSocket: "/tmp/svall/studio.sock")))
        // one helper already following is left to it
        let another = ControllerProcess(executable: try fakeHelper(prints: []), arguments: [])
        remote.followIfGatewayNamed(with: another)
        XCTAssertTrue(next.isRunning)
        XCTAssertFalse(another.isRunning)
        remote.stop()
    }

    func testAHelperThatSaysNothingLeavesAFleetItsCachedRouteNamesOnThisMac() throws {
        let helper = ControllerProcess(executable: try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#]), arguments: [])
        let remote = connection(helper: helper, local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"),
                                answerWithin: 0.2, cachedHere: { true })
        remote.start()
        waitForTranscript(of: 3)
        XCTAssertEqual(transcript, ["state connecting studio - -", "state online local - -", "connection 127.0.0.1:8123:t0ken"])
        XCTAssertEqual(remote.route, .local)
        remote.stop()
    }

    func testAHelperThatSaysNothingShowsTheBannerWhenNoCachedRouteNamesThisMac() throws {
        let helper = ControllerProcess(executable: try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#]), arguments: [])
        let remote = connection(helper: helper, local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"), answerWithin: 0.2)
        remote.start()
        waitForTranscript(of: 2)
        XCTAssertEqual(transcript, ["state connecting studio - -", "state error studio other the connection helper has not answered in 0.2 s"])
        XCTAssertEqual(remote.route, .pending)
        XCTAssertTrue(helper.isRunning)
        remote.stop()
    }

    func testAHelperThatAnswersInTimeIsNotOverriddenByTheWait() throws {
        let helper = ControllerProcess(executable: try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#, remoteOnline]), arguments: [])
        let remote = connection(helper: helper, answerWithin: 0.2, cachedHere: { true })
        remote.start()
        waitForTranscript(of: 3)
        let settled = expectation(description: "past the wait")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { settled.fulfill() }
        wait(for: [settled], timeout: 2)
        XCTAssertEqual(transcript.count, 3)
        XCTAssertEqual(remote.route, .remote(RemoteRoute(name: "studio", destination: "linus@studio", controlSocket: "/tmp/svall/studio.sock")))
        remote.stop()
    }

    func testAHelperThatNamesAnotherMachineAfterTheCachedFallbackReattachesTheSurfacesThere() throws {
        let late = "sleep 2; printf '%s\\n' '\(remoteOnline)'; exec cat > /dev/null"
        let helper = ControllerProcess(executable: try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#], then: late), arguments: [])
        let remote = connection(helper: helper, local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"),
                                answerWithin: 1, cachedHere: { true })
        remote.start()
        waitForTranscript(of: 6)
        XCTAssertEqual(Array(transcript.suffix(4)), ["connection 127.0.0.1:8123:t0ken",
                                                     "connection 127.0.0.1:49321:other",
                                                     "state online studio - -",
                                                     "surfaces reattach"])
        XCTAssertEqual(remote.route, .remote(RemoteRoute(name: "studio", destination: "linus@studio", controlSocket: "/tmp/svall/studio.sock")))
        remote.stop()
    }

    func testAWindowThatFellBackToThisMacKeepsItsStateThroughTheHelpersRetries() throws {
        let retries = #"sleep 2; printf '%s\n' '{"type":"error","kind":"unreachable","message":"ssh closed"}' '{"type":"connecting","owner":"studio"}'; exec cat > /dev/null"#
        let helper = ControllerProcess(executable: try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#], then: retries), arguments: [])
        let remote = connection(helper: helper, local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"),
                                answerWithin: 1, cachedHere: { true })
        remote.start()
        waitForTranscript(of: 3)
        pause(2)
        XCTAssertEqual(Array(transcript.suffix(2)), ["state online local - -", "connection 127.0.0.1:8123:t0ken"])
        XCTAssertEqual(remote.state?.state, "online")
        XCTAssertEqual(remote.route, .local)
        remote.stop()
    }

    func testTheCachedRouteNamesThisMacOnlyAtTheGenerationItsDaemonHolds() throws {
        let home = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("svall-route-\(UUID().uuidString)")
        let config = home.appendingPathComponent("config")
        try FileManager.default.createDirectory(at: home.appendingPathComponent("controller"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }
        let me = "11111111-2222-3333-4444-555555555555"
        let write = { (file: String, text: String) in try text.write(to: home.appendingPathComponent(file), atomically: true, encoding: .utf8) }
        let here = { RemoteConnection.cachedRouteIsHere(home: home.path, configDir: config.path) }
        XCTAssertFalse(here())
        try write("config/machine.json", #"{"id":"\#(me)"}"#)
        try write("owner.json", #"{"fleetId":"f","generation":3,"ownerMachineId":"\#(me)"}"#)
        try write("controller/route.json", #"{"ownerMachineId":"\#(me)","generation":3,"at":"2026-10-21T00:00:00Z"}"#)
        XCTAssertTrue(here())
        try write("owner.json", #"{"fleetId":"f","generation":4,"ownerMachineId":"\#(me)"}"#)
        XCTAssertFalse(here())
        try write("controller/route.json", #"{"ownerMachineId":"99999999-2222-3333-4444-555555555555","generation":4,"at":"2026-10-21T00:00:00Z"}"#)
        XCTAssertFalse(here())
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

    func testAHelperThatGaveUpOnAnotherVersionIsAskedAfreshOnceTheMachineIsUpgraded() throws {
        let first = ControllerProcess(executable: try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#,
                                                                         #"{"type":"error","kind":"version","message":"studio answered with protocol 3, not 4"}"#]), arguments: [])
        let remote = connection(helper: first)
        remote.start()
        waitForTranscript(of: 2)
        XCTAssertTrue(remote.idle)
        let second = ControllerProcess(executable: try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#, remoteOnline]), arguments: [])
        remote.retryIfIdle(with: second)
        XCTAssertFalse(first.isRunning)
        waitForTranscript(of: 5)
        XCTAssertEqual(Array(transcript.suffix(3)), ["state connecting studio - -",
                                                     "connection 127.0.0.1:49321:other",
                                                     "state online studio - -"])
        XCTAssertFalse(remote.idle)
        remote.stop()
    }

    func testAHelperOnlineOrStillRetryingIsLeftAloneByAnUpgrade() throws {
        let cases = [([#"{"type":"connecting","owner":"studio"}"#, remoteOnline], 3),
                     ([#"{"type":"connecting","owner":"studio"}"#, #"{"type":"error","kind":"unreachable","message":"ssh closed"}"#], 2),
                     ([#"{"type":"connecting","owner":"studio"}"#, #"{"type":"error","kind":"daemon_down","message":"svalld is not running on studio"}"#], 2)]
        for (prints, said) in cases {
            transcript = []
            let first = ControllerProcess(executable: try fakeHelper(prints: prints), arguments: [])
            let remote = connection(helper: first)
            remote.start()
            waitForTranscript(of: said)
            XCTAssertFalse(remote.idle)
            let second = ControllerProcess(executable: try fakeHelper(prints: []), arguments: [])
            remote.retryIfIdle(with: second)
            XCTAssertTrue(first.isRunning)
            XCTAssertFalse(second.isRunning)
            remote.stop()
        }
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
        // the page asking again while it has no port starts no helper after it
        let again = ControllerProcess(executable: try fakeHelper(prints: []), arguments: [])
        remote.followIfGatewayNamed(with: again)
        XCTAssertFalse(again.isRunning)
        remote.stop()
    }

    func testAHelperThatDiesBeforeItSaysWhereAFleetWithNoGatewayIsLeavesItOnThisMac() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"local"}"#], then: "exit 3")
        // the gateway is dropped while the helper runs
        var gateway = true
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []),
                                local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"), localOnly: { !gateway })
        remote.start()
        gateway = false
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
        var gateway = true
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []),
                                local: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"), localOnly: { !gateway })
        remote.start()
        gateway = false
        waitForTranscript(of: 3)
        XCTAssertEqual(Array(transcript.suffix(1)), ["connection 127.0.0.1:8123:t0ken"])
        XCTAssertEqual(remote.route, .local)
        remote.stop()
    }

    func testAHelperThatFailsOnceTheFleetWasOnlineKeepsTheRouteItHad() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#, remoteOnline], then: "exit 3")
        var gateway = true
        let remote = connection(helper: ControllerProcess(executable: helper, arguments: []), localOnly: { !gateway })
        remote.start()
        gateway = false
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
