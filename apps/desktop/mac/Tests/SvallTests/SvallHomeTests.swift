import XCTest
@testable import Svall

final class SvallHomeTests: XCTestCase {
    private var home: String!

    override func setUpWithError() throws {
        home = NSTemporaryDirectory() + "svall-home-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: home)
    }

    private func fleet(_ json: String, at file: String? = nil) throws {
        try json.write(toFile: file ?? home + "/fleet.json", atomically: true, encoding: .utf8)
    }

    private func read(_ file: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: file))) as? [String: Any])
    }

    func testTheSwitchSetsHandoverEnabledAndKeepsEveryOtherKey() throws {
        try fleet(#"{"id":"f1","name":"work","handover":{"exclude":["/tmp/"]},"mobile":{"logins":["ada"]}}"#)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: home + "/fleet.json")
        try SvallHome.setHandoverEnabled(true, at: home)
        XCTAssertTrue(SvallHome.handoverEnabled(at: home))
        let json = try read(home + "/fleet.json")
        XCTAssertEqual(json["id"] as? String, "f1")
        XCTAssertEqual(json["name"] as? String, "work")
        XCTAssertEqual((json["handover"] as? [String: Any])?["exclude"] as? [String], ["/tmp/"])
        XCTAssertEqual((json["mobile"] as? [String: Any])?["logins"] as? [String], ["ada"])
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: home + "/fleet.json")[.posixPermissions] as? Int, 0o600)

        try SvallHome.setHandoverEnabled(false, at: home)
        XCTAssertFalse(SvallHome.handoverEnabled(at: home))
    }

    func testALinkedFleetJsonIsWrittenWhereItPoints() throws {
        let real = home + "/dotfiles-fleet.json"
        try fleet(#"{"id":"f1"}"#, at: real)
        try FileManager.default.createSymbolicLink(atPath: home + "/fleet.json", withDestinationPath: real)
        try SvallHome.setHandoverEnabled(true, at: home)
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: home + "/fleet.json"), real)
        XCTAssertTrue(SvallHome.handoverEnabled(at: home))
    }

    func testAFleetJsonThatDoesNotParseIsRefusedAndLeftAsItWas() throws {
        try fleet("{ not json")
        XCTAssertThrowsError(try SvallHome.setHandoverEnabled(true, at: home))
        XCTAssertEqual(try String(contentsOfFile: home + "/fleet.json", encoding: .utf8), "{ not json")
        try FileManager.default.removeItem(atPath: home + "/fleet.json")
        XCTAssertThrowsError(try SvallHome.setHandoverEnabled(true, at: home))
    }
}
