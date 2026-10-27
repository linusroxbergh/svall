import XCTest
@testable import Svall

final class KeepAwakeTests: XCTestCase {
    func testAHoldIsUpOnACAlone() {
        XCTAssertTrue(KeepAwake.holds(reason: "2 agents working", onBattery: false))
        XCTAssertFalse(KeepAwake.holds(reason: "2 agents working", onBattery: true))
        XCTAssertFalse(KeepAwake.holds(reason: nil, onBattery: false))
    }

    func testThePageAsksForAHoldByName() throws {
        let decode = { (json: String) in try JSONDecoder().decode(ToShell.self, from: Data(json.utf8)) }
        guard case .awake(let reason) = try decode(#"{"type":"awake","reason":"2 agents working"}"#) else {
            return XCTFail("awake did not decode")
        }
        XCTAssertEqual(reason, "2 agents working")
        guard case .awake(let none) = try decode(#"{"type":"awake"}"#) else { return XCTFail("a release did not decode") }
        XCTAssertNil(none)
    }
}
