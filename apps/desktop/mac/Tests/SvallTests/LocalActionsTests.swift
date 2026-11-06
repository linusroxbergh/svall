import XCTest
@testable import Svall

final class LocalActionsTests: XCTestCase {
    private var ran: [String] = []
    private var refused: [[String: Any]] = []
    private var dir = ""
    private let actions: [(type: String, field: String, name: String)] = [
        ("openFolder", "path", "folder"), ("reveal", "path", "reveal"), ("openFile", "path", "file"), ("folder.pick", "start", "pick"),
    ]

    // what a daemon writes, read back by the id reader the shell itself uses
    override func setUpWithError() throws {
        dir = NSTemporaryDirectory() + "svall-machine-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        setenv("SVALL_CONFIG_DIR", dir, 1)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: dir)
        unsetenv("SVALL_CONFIG_DIR")
    }

    private func mint(_ id: String) throws {
        try #"{"id":"\#(id)","hardwareId":"h"}"#.write(toFile: dir + "/machine.json", atomically: true, encoding: .utf8)
    }

    private var local: LocalActions {
        LocalActions(refuse: { [unowned self] in refused.append($0.json) }, pickFolder: { [unowned self] in ran.append("pick \($0)") },
                     openFolder: { [unowned self] in ran.append("folder \($0)") }, reveal: { [unowned self] in ran.append("reveal \($0)") },
                     openFile: { [unowned self] in ran.append("file \($0)") })
    }

    private func runAll(machine: String?) throws {
        for a in actions {
            var body = ["type": a.type, a.field: "/home/ada/x"]
            if let machine { body["machine"] = machine }
            local.run(try JSONDecoder().decode(ToShell.self, from: JSONSerialization.data(withJSONObject: body)))
        }
    }

    func testEachRunsForThisMachine() throws {
        try mint("me")
        try runAll(machine: "me")
        XCTAssertEqual(ran, actions.map { "\($0.name) /home/ada/x" })
        XCTAssertTrue(refused.isEmpty)
    }

    func testEachIsRefusedForAnotherWithLocalUnavailable() throws {
        try mint("me")
        try runAll(machine: "studio")
        XCTAssertEqual(ran, [])
        XCTAssertEqual(refused.map { $0["type"] as? String }, actions.map { _ in "local.unavailable" })
        XCTAssertEqual(refused.map { $0["machine"] as? String }, actions.map { _ in "studio" })
    }

    func testAPageThatNamesAMachineToAShellWithNoIdIsRefused() throws {
        try runAll(machine: "studio")
        XCTAssertEqual(ran, [])
        XCTAssertEqual(refused.count, actions.count)
    }

    func testAPageThatNamesNoneToAShellWithAnIdIsRefused() throws {
        try mint("me")
        try runAll(machine: nil)
        XCTAssertEqual(ran, [])
        XCTAssertEqual(refused.map { $0["machine"] as? String }, actions.map { _ in "" })
    }

    func testNeitherKnowingAnIdRunsAsOnAFirstRun() throws {
        try runAll(machine: nil)
        XCTAssertEqual(ran.count, actions.count)
        XCTAssertTrue(refused.isEmpty)
    }

    func testShellInfoNamesThisMachineToThePage() throws {
        let info = FromShell.shellInfo(home: "/h", log: [], op: false, ghosttyKeys: [:], bindings: nil, machine: "abc")
        XCTAssertEqual(info.json["machine"] as? String, "abc")
    }

    func testNoIdStillReachesThePageAsJSON() {
        let messages: [FromShell] = [.localUnavailable(machine: nil), .shellInfo(home: "/h", log: [], op: false, ghosttyKeys: [:], bindings: nil, machine: nil)]
        for m in messages {
            XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: m.json))
            XCTAssertEqual(m.json["machine"] as? String, "")
        }
    }

    func testTheIdIsTheOneTheDaemonWrote() throws {
        XCTAssertNil(SvallHome.machineId())
        try mint("abc")
        XCTAssertEqual(SvallHome.machineId(), "abc")
    }

    func testTheFolderIsTheDaemonsDefaultWithNoOverride() {
        unsetenv("SVALL_CONFIG_DIR")
        XCTAssertEqual(SvallHome.configDir, NSHomeDirectory() + "/.config/svall")
    }
}
