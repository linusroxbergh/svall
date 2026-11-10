import XCTest
@testable import Svall

final class BridgeTests: XCTestCase {
    func testTakesThePagesLogLine() throws {
        let message = try JSONDecoder().decode(ToShell.self, from: Data(#"{"type":"log","text":"toast error: studio is not reachable"}"#.utf8))
        guard case .log(let text) = message else { return XCTFail("decoded \(message)") }
        XCTAssertEqual(text, "toast error: studio is not reachable")
    }
}
