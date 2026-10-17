import XCTest
@testable import Svall

final class ControllerProcessTests: XCTestCase {
    func testEventsArriveLineByLineAndTheChildLivesUntilStdinCloses() throws {
        let helper = try fakeHelper(prints: [
            #"{"type":"connecting","owner":"local"}"#,
            #"{"type":"online","host":"127.0.0.1","port":8123,"token":"t0ken"}"#,
        ])
        let process = ControllerProcess(executable: helper, arguments: ["connect", "--json"])
        var events: [ControllerEvent] = []
        let online = expectation(description: "online")
        process.onEvent = { event in
            XCTAssertTrue(Thread.isMainThread)
            events.append(event)
            if case .online = event { online.fulfill() }
        }
        try process.start()
        wait(for: [online], timeout: 5)
        XCTAssertEqual(events, [.connecting(owner: "local"),
                                .online(connection: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"), remote: nil)])
        XCTAssertTrue(process.isRunning)
        process.stop()
        XCTAssertFalse(process.isRunning)
    }

    func testAChildThatExitsOnItsOwnIsReported() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#], then: "exit 3")
        let process = ControllerProcess(executable: helper, arguments: ["connect", "--json"])
        let exited = expectation(description: "exit")
        process.onExit = { _ in
            XCTAssertTrue(Thread.isMainThread)
            exited.fulfill()
        }
        try process.start()
        wait(for: [exited], timeout: 5)
        process.stop()
    }

    func testMalformedLinesDoNotStopTheStream() throws {
        let helper = try fakeHelper(prints: [
            "not json",
            #"{"type":"weather"}"#,
            #"{"type":"connecting","owner":"local"}"#,
        ])
        let process = ControllerProcess(executable: helper, arguments: ["connect", "--json"])
        var events: [ControllerEvent] = []
        let connecting = expectation(description: "connecting")
        process.onEvent = { events.append($0); connecting.fulfill() }
        try process.start()
        wait(for: [connecting], timeout: 5)
        XCTAssertEqual(events, [.connecting(owner: "local")])
        process.stop()
    }

    /// A helper mid-open may hold SIGTERM off for tens of seconds; quitting waits a bounded time, then kills it.
    func testStoppingEndsAHelperThatIgnoresItsInputAndSIGTERM() throws {
        let helper = try fakeHelper(prints: [#"{"type":"connecting","owner":"studio"}"#], then: "trap '' TERM\nwhile :; do sleep 1; done")
        addTeardownBlock {
            let kill = Process()
            kill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
            kill.arguments = ["-9", "-f", helper]
            try? kill.run()
            kill.waitUntilExit()
        }
        let process = ControllerProcess(executable: helper, arguments: [])
        let connecting = expectation(description: "connecting")
        process.onEvent = { _ in connecting.fulfill() }
        try process.start()
        wait(for: [connecting], timeout: 5)

        let stopped = expectation(description: "stopped")
        DispatchQueue.global().async {
            process.stop()
            stopped.fulfill()
        }
        wait(for: [stopped], timeout: 10)
        XCTAssertFalse(process.isRunning)
    }

    func testAMissingHelperFailsToStartRatherThanCrashing() {
        let process = ControllerProcess(executable: "/nonexistent/svall", arguments: ["connect", "--json"])
        XCTAssertThrowsError(try process.start())
        XCTAssertFalse(process.isRunning)
    }

    func testTheHelperIsTakenFromTheEnvironmentBeforeTheBundle() throws {
        let helper = try fakeHelper(prints: [])
        let bundle = try fakeHelper(prints: [])
        let resources = (bundle as NSString).deletingLastPathComponent
        let bundled = resources + "/release/bin/svall"
        try FileManager.default.createDirectory(atPath: (bundled as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try FileManager.default.copyItem(atPath: bundle, toPath: bundled)

        XCTAssertEqual(ControllerProcess.locate(environment: ["SVALL_HELPER": helper], resourcePath: resources), helper)
        XCTAssertEqual(ControllerProcess.locate(environment: [:], resourcePath: resources), bundled)
        XCTAssertNil(ControllerProcess.locate(environment: [:], resourcePath: nil))
        XCTAssertNil(ControllerProcess.locate(environment: ["SVALL_HELPER": "/nonexistent/svall"], resourcePath: nil))
    }

    func testTheProfileIsPassedOnlyWhenTheAppRunsOne() {
        XCTAssertEqual(ControllerProcess.connectArguments(profile: nil), ["connect", "--json"])
        XCTAssertEqual(ControllerProcess.connectArguments(profile: "work"), ["connect", "--json", "-p", "work"])
        XCTAssertNil(SvallHome.profileName(of: "/Users/x/.svall", in: "/Users/x"))
        XCTAssertEqual(SvallHome.profileName(of: "/Users/x/.svall-work", in: "/Users/x"), "work")
        XCTAssertNil(SvallHome.profileName(of: "/tmp/somewhere", in: "/Users/x"))
    }
}
