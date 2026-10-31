import XCTest
@testable import Svall

final class GhosttyRuntimeTests: XCTestCase {
    func testAReadForTextGetsThePasteboardsText() {
        let read = GhosttyRuntime.serve("echo hi", wanted: ["text/plain"], list: false)
        XCTAssertEqual(read?.contents.map(\.mime), ["text/plain"])
        XCTAssertEqual(read?.contents.map(\.data), [Data("echo hi".utf8)])
        XCTAssertEqual(read?.available, [])
    }

    func testAReadGetsNothingWhenThePasteboardHoldsNoText() {
        XCTAssertNil(GhosttyRuntime.serve(nil, wanted: ["text/plain"], list: false))
    }

    func testAReadForAnotherTypeGetsNothing() {
        XCTAssertNil(GhosttyRuntime.serve("echo hi", wanted: ["image/png"], list: false))
    }

    func testAListingNamesTextWithoutReadingIt() {
        let read = GhosttyRuntime.serve("echo hi", wanted: [], list: true)
        XCTAssertEqual(read?.contents.count, 0)
        XCTAssertEqual(read?.available, ["text/plain"])
    }

    func testAListingOfAPasteboardWithoutTextIsEmpty() {
        let read = GhosttyRuntime.serve(nil, wanted: [], list: true)
        XCTAssertEqual(read?.contents.count, 0)
        XCTAssertEqual(read?.available, [])
    }
}
