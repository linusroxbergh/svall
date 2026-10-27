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

    func testAFleetHomeIsNamedByItsProfile() {
        XCTAssertNil(SvallHome.profileName(of: "/Users/x/.svall", in: "/Users/x"))
        XCTAssertEqual(SvallHome.profileName(of: "/Users/x/.svall-work", in: "/Users/x"), "work")
        XCTAssertNil(SvallHome.profileName(of: "/tmp/somewhere", in: "/Users/x"))
    }
}
