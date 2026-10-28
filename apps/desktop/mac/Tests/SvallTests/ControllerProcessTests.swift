import XCTest
@testable import Svall

final class ControllerProcessTests: XCTestCase {
    func testTheHelperIsTakenFromTheEnvironmentBeforeTheBundle() throws {
        let helper = try fakeHelper(prints: [])
        let bundle = try fakeHelper(prints: [])
        let resources = (bundle as NSString).deletingLastPathComponent
        let bundled = resources + "/release/bin/svall"
        try FileManager.default.createDirectory(atPath: (bundled as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try FileManager.default.copyItem(atPath: bundle, toPath: bundled)

        XCTAssertEqual(BundledSvall.locate(environment: ["SVALL_HELPER": helper], resourcePath: resources), helper)
        XCTAssertEqual(BundledSvall.locate(environment: [:], resourcePath: resources), bundled)
        XCTAssertNil(BundledSvall.locate(environment: [:], resourcePath: nil))
        XCTAssertNil(BundledSvall.locate(environment: ["SVALL_HELPER": "/nonexistent/svall"], resourcePath: nil))
    }
}
