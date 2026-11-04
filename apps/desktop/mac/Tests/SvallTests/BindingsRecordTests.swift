import XCTest
@testable import Svall

final class BindingsRecordTests: XCTestCase {
    private var dir: String!
    private var file: String { dir + "/config/svall/bindings.json" }

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try FileManager.default.removeItem(atPath: dir) }

    private func corrupt(_ text: String) throws {
        try FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try text.write(toFile: file, atomically: true, encoding: .utf8)
    }

    func testTheFileIsBesideTheRegistryAndFollowsTheConfigFolder() {
        XCTAssertEqual(BindingsRecord.file(environment: ["SVALL_CONFIG_DIR": "/x"]), "/x/bindings.json")
        XCTAssertEqual(BindingsRecord.file(environment: [:]), NSHomeDirectory() + "/.config/svall/bindings.json")
    }

    func testThereIsNoRecordUntilOneIsWritten() {
        XCTAssertNil(BindingsRecord.read(from: file))
    }

    func testAWriteMakesTheFolderAndReadsBackWithAnUnboundActionAsNull() throws {
        BindingsRecord.write(["newRobot": "cmd+n", "quit": nil], to: file)
        let record = try XCTUnwrap(BindingsRecord.read(from: file))
        XCTAssertEqual(record["newRobot"] as? String, "cmd+n")
        XCTAssertTrue(record["quit"] is NSNull)
        XCTAssertEqual(record.count, 2)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: (file as NSString).deletingLastPathComponent), ["bindings.json"])
    }

    func testAWriteReplacesTheFileWholeRatherThanWritingIntoIt() throws {
        BindingsRecord.write(["newRobot": "cmd+n"], to: file)
        let before = try FileManager.default.attributesOfItem(atPath: file)[.systemFileNumber] as? Int
        BindingsRecord.write(["newRobot": "cmd+t"], to: file)
        XCTAssertNotEqual(try FileManager.default.attributesOfItem(atPath: file)[.systemFileNumber] as? Int, before)
        XCTAssertEqual(BindingsRecord.read(from: file)?["newRobot"] as? String, "cmd+t")
    }

    func testAnEmptyRecordIsARecord() {
        BindingsRecord.write([:], to: file)
        XCTAssertNotNil(BindingsRecord.read(from: file))
    }

    func testACorruptFileReadsAsNoRecordAndTheNextWriteReplacesIt() throws {
        for text in ["{ \"newRobot\": ", "[]", "3", ""] {
            try corrupt(text)
            XCTAssertNil(BindingsRecord.read(from: file), text)
        }
        BindingsRecord.write(["newRobot": "cmd+t"], to: file)
        XCTAssertEqual(BindingsRecord.read(from: file)?["newRobot"] as? String, "cmd+t")
    }

    func testAWriteThatCannotHappenDoesNotThrowOrLeaveAFile() throws {
        // the folder's place is taken by a file
        try "".write(toFile: dir + "/config", atomically: true, encoding: .utf8)
        BindingsRecord.write(["newRobot": "cmd+t"], to: file)
        XCTAssertNil(BindingsRecord.read(from: file))
    }

    func testThePageSavesWholeRecordsThroughTheBridge() throws {
        let json = #"{"type":"keys.save","bindings":{"newRobot":"cmd+n","quit":null}}"#
        guard case .keysSave(let bindings) = try JSONDecoder().decode(ToShell.self, from: Data(json.utf8)) else {
            return XCTFail("keys.save did not decode")
        }
        BindingsRecord.write(bindings, to: file)
        let record = try XCTUnwrap(BindingsRecord.read(from: file))
        XCTAssertEqual(record["newRobot"] as? String, "cmd+n")
        XCTAssertTrue(record["quit"] is NSNull)
    }

    func testAReReadTellsTheWindowTheRecord() throws {
        BindingsRecord.write(["newRobot": "cmd+n", "quit": nil], to: file)
        let json = try XCTUnwrap(BindingsRecord.reread(from: file)).json
        XCTAssertEqual(json["type"] as? String, "keys.record")
        XCTAssertTrue(JSONSerialization.isValidJSONObject(json))
        let bindings = try XCTUnwrap(json["bindings"] as? [String: Any])
        XCTAssertEqual(bindings["newRobot"] as? String, "cmd+n")
        XCTAssertTrue(bindings["quit"] is NSNull)
    }

    func testAReReadOfAMissingOrCorruptFileTellsTheWindowNothing() throws {
        XCTAssertNil(BindingsRecord.reread(from: file))
        for text in ["{ \"newRobot\": ", "[]", "3", ""] {
            try corrupt(text)
            XCTAssertNil(BindingsRecord.reread(from: file), text)
        }
    }

    func testTheShellInfoCarriesARecordThatCanCrossAndOmitsOneThatIsNot() throws {
        BindingsRecord.write(["quit": nil], to: file)
        let info = FromShell.shellInfo(home: "/h", log: [], op: false, ghosttyKeys: [:], bindings: BindingsRecord.read(from: file), machine: nil)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(info.json))
        XCTAssertTrue((info.json["bindings"] as? [String: Any])?["quit"] is NSNull)
        let none = FromShell.shellInfo(home: "/h", log: [], op: false, ghosttyKeys: [:], bindings: nil, machine: nil)
        XCTAssertNil(none.json["bindings"])
    }
}
