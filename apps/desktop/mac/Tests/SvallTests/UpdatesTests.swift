import XCTest
@testable import Svall

final class UpdatesTests: XCTestCase {
    func testAnUpdateWaitsWhileAnotherMachineRunsAFleetOfThisMac() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("svall-updates-\(UUID().uuidString)")
        let config = root.appendingPathComponent(".config/svall")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let write = { (file: String, text: String) in
            let url = root.appendingPathComponent(file)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try text.write(to: url, atomically: true, encoding: .utf8)
        }
        let me = "11111111-2222-3333-4444-555555555555", trift = "0b9d6c3e-1f2a-4b5c-8d7e-9f0a1b2c3d4e"
        let notice = { Updates.deferral(homeDirectory: root.path, configDir: config.path) }
        try write(".config/svall/machine.json", #"{"id":"\#(me)"}"#)
        // a fleet that names no gateway has only ever run here
        try write(".svall/fleet.json", #"{"id":"p"}"#)
        try write(".svall/owner.json", #"{"fleetId":"p","generation":0,"ownerMachineId":"\#(trift)"}"#)
        XCTAssertNil(notice())
        try write(".svall-work/fleet.json", #"{"id":"w","gatewayMachineId":"\#(trift)"}"#)
        try write(".svall-work/owner.json", #"{"fleetId":"w","generation":2,"ownerMachineId":"\#(me)"}"#)
        XCTAssertNil(notice())

        try write(".svall-work/owner.json", #"{"fleetId":"w","generation":3,"ownerMachineId":"\#(trift)"}"#)
        XCTAssertEqual(notice(), "work runs on \(trift), which this update leaves out of reach until svall host upgrade \(trift); svall -p work handover local brings it back first, and Check for Updates again installs it now")
        try write(".config/svall/machines.json", #"{"machines":{"\#(trift)":{"name":"trift","gateway":true}}}"#)
        try write(".svall-work/fleet.json", #"{"id":"w","name":"lab","gatewayMachineId":"\#(trift)"}"#)
        XCTAssertEqual(notice(), "lab runs on trift, which this update leaves out of reach until svall host upgrade trift; svall -p work handover local brings it back first, and Check for Updates again installs it now")

        // Svall Dev's fleets, and a copy of a fleet home under another name, are not this app's to wait on
        try write(".svall-work/owner.json", #"{"fleetId":"w","generation":4,"ownerMachineId":"\#(me)"}"#)
        for dir in [".svall-dev", ".svall-dev-work", ".svall-work.bak"] {
            try write("\(dir)/fleet.json", #"{"id":"d","gatewayMachineId":"\#(trift)"}"#)
            try write("\(dir)/owner.json", #"{"fleetId":"d","generation":1,"ownerMachineId":"\#(trift)"}"#)
        }
        XCTAssertNil(notice())
        // the selector Sparkle asks its delegate before each check
        XCTAssertTrue(Updates.instancesRespond(to: NSSelectorFromString("updater:mayPerformUpdateCheck:error:")))
    }

    func testAskingAgainInstallsTheUpdateItHeldBack() {
        XCTAssertEqual(Updates.shared.holdBack { "lab runs on trift" }, "lab runs on trift")
        XCTAssertNil(Updates.shared.holdBack { "lab runs on trift" })
    }
}
