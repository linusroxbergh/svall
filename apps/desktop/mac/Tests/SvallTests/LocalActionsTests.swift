import XCTest
@testable import Svall

final class LocalActionsTests: XCTestCase {
    private var ran: [String] = []
    private var refused: [[String: Any]] = []
    private let actions: [(type: String, field: String, name: String)] = [
        ("openFolder", "path", "folder"), ("reveal", "path", "reveal"), ("openFile", "path", "file"), ("folder.pick", "start", "pick"),
    ]

    private var local: LocalActions {
        LocalActions(refuse: { [unowned self] in refused.append($0.json) }, openFolder: { [unowned self] in ran.append("folder \($0)") },
                     reveal: { [unowned self] in ran.append("reveal \($0)") }, openFile: { [unowned self] in ran.append("file \($0)") },
                     pickFolder: { [unowned self] in ran.append("pick \($0)") })
    }

    private func message(_ type: String, _ field: String, machine: String?) throws -> ToShell {
        var body = ["type": type, field: "/home/ada/x"]
        if let machine { body["machine"] = machine }
        return try JSONDecoder().decode(ToShell.self, from: JSONSerialization.data(withJSONObject: body))
    }

    func testEachRunsForThisMachine() throws {
        for a in actions { local.run(try message(a.type, a.field, machine: "me"), me: "me") }
        XCTAssertEqual(ran, actions.map { "\($0.name) /home/ada/x" })
        XCTAssertTrue(refused.isEmpty)
    }

    func testEachIsRefusedForAnotherWithLocalUnavailable() throws {
        for a in actions { local.run(try message(a.type, a.field, machine: "studio"), me: "me") }
        XCTAssertEqual(ran, [])
        XCTAssertEqual(refused.map { $0["type"] as? String }, actions.map { _ in "local.unavailable" })
        XCTAssertEqual(refused.map { $0["action"] as? String }, actions.map(\.type))
        XCTAssertEqual(refused.map { $0["machine"] as? String }, actions.map { _ in "studio" })
    }

    func testAPageThatNamesAMachineToAShellWithNoIdIsRefused() throws {
        for a in actions { local.run(try message(a.type, a.field, machine: "studio"), me: nil) }
        XCTAssertEqual(ran, [])
        XCTAssertEqual(refused.count, actions.count)
    }

    func testAPageThatNamesNoneToAShellWithAnIdIsRefused() throws {
        for a in actions { local.run(try message(a.type, a.field, machine: nil), me: "me") }
        XCTAssertEqual(ran, [])
        XCTAssertEqual(refused.map { $0["machine"] as? String }, actions.map { _ in "" })
    }

    func testNeitherKnowingAnIdRunsAsOnAFirstRun() throws {
        for a in actions { local.run(try message(a.type, a.field, machine: nil), me: nil) }
        XCTAssertEqual(ran.count, actions.count)
        XCTAssertTrue(refused.isEmpty)
    }

    func testARefusalAndShellInfoReachThePageAsJSON() throws {
        let messages: [FromShell] = [.localUnavailable(action: "reveal", machine: nil), .shellInfo(home: "/h", log: [], op: false, ghosttyKeys: [:], bindings: nil, machine: nil)]
        for m in messages { XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: m.json)); XCTAssertEqual(m.json["machine"] as? String, "") }
    }

    func testTheIdIsTheOneTheDaemonWrote() throws {
        let dir = NSTemporaryDirectory() + "svall-machine-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir); unsetenv("SVALL_CONFIG_DIR") }
        setenv("SVALL_CONFIG_DIR", dir, 1)
        XCTAssertNil(SvallHome.machineId())
        try #"{"id":"abc","hardwareId":"h"}"#.write(toFile: dir + "/machine.json", atomically: true, encoding: .utf8)
        XCTAssertEqual(SvallHome.machineId(), "abc")
    }
}
