import XCTest
@testable import Svall

final class KeepAwakeTests: XCTestCase {
    func testAHoldIsUpOnACAndOnBatteryOnlyWhenAskedFor() {
        XCTAssertTrue(KeepAwake.holds(reason: "2 agents working", battery: false, onBattery: false))
        XCTAssertFalse(KeepAwake.holds(reason: "2 agents working", battery: false, onBattery: true))
        XCTAssertTrue(KeepAwake.holds(reason: "handing the fleet over", battery: true, onBattery: true))
        XCTAssertFalse(KeepAwake.holds(reason: nil, battery: true, onBattery: false))
    }

    func testThePageAsksForAHoldOnBatteryByName() throws {
        let decode = { (json: String) in try JSONDecoder().decode(ToShell.self, from: Data(json.utf8)) }
        guard case .awake(let reason, let battery) = try decode(#"{"type":"awake","reason":"handing the fleet over","battery":true}"#) else {
            return XCTFail("awake did not decode")
        }
        XCTAssertEqual(reason, "handing the fleet over")
        XCTAssertEqual(battery, true)
        guard case .awake(let none, let unasked) = try decode(#"{"type":"awake"}"#) else { return XCTFail("a release did not decode") }
        XCTAssertNil(none)
        XCTAssertNil(unasked)
    }
}
