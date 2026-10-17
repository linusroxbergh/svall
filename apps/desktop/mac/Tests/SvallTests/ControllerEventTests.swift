import XCTest
@testable import Svall

final class ControllerEventTests: XCTestCase {
    func testConnectingCarriesTheOwner() {
        XCTAssertEqual(ControllerEvent.decode(#"{"type":"connecting","owner":"local"}"#), .connecting(owner: "local"))
        XCTAssertEqual(ControllerEvent.decode(#"{"type":"connecting","owner":"studio"}"#), .connecting(owner: "studio"))
    }

    func testOnlineForALocalOwnerHasNoRoute() {
        let line = #"{"type":"online","host":"127.0.0.1","port":8123,"token":"t0ken"}"#
        XCTAssertEqual(ControllerEvent.decode(line),
                       .online(connection: SvallConnection(host: "127.0.0.1", port: 8123, token: "t0ken"), remote: nil))
    }

    func testOnlineForARemoteOwnerCarriesTheRoute() {
        let line = #"{"type":"online","host":"127.0.0.1","port":49321,"token":"t0ken","remote":{"name":"studio","destination":"linus@studio","controlSocket":"/tmp/svall/studio.sock"}}"#
        XCTAssertEqual(ControllerEvent.decode(line),
                       .online(connection: SvallConnection(host: "127.0.0.1", port: 49321, token: "t0ken"),
                               remote: RemoteRoute(name: "studio", destination: "linus@studio", controlSocket: "/tmp/svall/studio.sock")))
    }

    func testErrorCarriesKindAndMessage() {
        let line = #"{"type":"error","kind":"unreachable","message":"no route to studio"}"#
        XCTAssertEqual(ControllerEvent.decode(line), .error(kind: "unreachable", message: "no route to studio"))
    }

    func testOwnerChangedCarriesTheNewOwner() {
        XCTAssertEqual(ControllerEvent.decode(#"{"type":"owner-changed","owner":"laptop"}"#), .ownerChanged(owner: "laptop"))
    }

    func testUnknownOrMalformedLinesAreIgnored() {
        XCTAssertNil(ControllerEvent.decode(#"{"type":"weather","sky":"clear"}"#))
        XCTAssertNil(ControllerEvent.decode("not json at all"))
        XCTAssertNil(ControllerEvent.decode(""))
        XCTAssertNil(ControllerEvent.decode(#"{"type":"online","host":"127.0.0.1"}"#))
        XCTAssertNil(ControllerEvent.decode(#"{"type":"connecting"}"#))
        XCTAssertNil(ControllerEvent.decode(#"{"type":"error","kind":"auth"}"#))
    }
}
