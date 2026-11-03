import AppKit
import XCTest
@testable import Svall

final class DropFilesTests: XCTestCase {
    func testPathsAreTypedAsGhosttyTypesADrop() {
        XCTAssertEqual(ShellEscape.paths(["/tmp/svall-drop-501/aB3x/Screen Shot (1).png", "/tmp/a'b"]), #"/tmp/svall-drop-501/aB3x/Screen\ Shot\ \(1\).png /tmp/a\'b"#)
        // a newline would run what came before it
        XCTAssertEqual(ShellEscape.paths(["/tmp/a\nrm -rf ~", "/tmp/b"]), "/tmp/b")
    }

    func testAFileIsServedOnceWithinFiveMinutesAndAFolderNotAtAll() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("notes.txt")
        try Data("hello".utf8).write(to: file)
        let drops = DropFiles()
        let now = Date()
        let held = drops.hold([file, dir], now: now)
        XCTAssertEqual(held[0].name, "notes.txt")
        XCTAssertEqual(held[0].bytes, 5)
        XCTAssertFalse(held[0].folder)
        XCTAssertEqual(held[1], DroppedFile(token: "", name: dir.lastPathComponent, bytes: 0, folder: true))
        XCTAssertEqual(drops.take(held[0].token, now: now), Data("hello".utf8))
        XCTAssertNil(drops.take(held[0].token, now: now))
        let late = drops.hold([file], now: now)[0]
        XCTAssertNil(drops.take(late.token, now: now.addingTimeInterval(301)))
    }

    func testAPastedImageIsAPngNamedForWhenItWasPasted() {
        let drops = DropFiles()
        let at = Date(timeIntervalSince1970: 0)
        let held = drops.hold(png: Data([1, 2, 3]), now: at)
        XCTAssertEqual(held.name, DropFiles.pastedName(at: at))
        XCTAssertTrue(held.name.hasPrefix("pasted-image-") && held.name.hasSuffix(".png"))
        XCTAssertEqual(drops.take(held.token, now: at), Data([1, 2, 3]))
    }

    func testOnlyAPasteboardWithAnImageAndNoTextPastesAnImage() throws {
        let board = NSPasteboard(name: NSPasteboard.Name(UUID().uuidString))
        defer { board.releaseGlobally() }
        let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                     isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        board.clearContents()
        board.setData(image.tiffRepresentation, forType: .tiff)
        let png = try XCTUnwrap(DropFiles.pastedImage(board))
        XCTAssertEqual(Array(png.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
        board.setString("a caption", forType: .string)
        XCTAssertNil(DropFiles.pastedImage(board))
        board.clearContents()
        board.setString("text alone", forType: .string)
        XCTAssertNil(DropFiles.pastedImage(board))
    }

    func testTheImagePasteKeysAreCommandVAndControlVAlone() {
        func key(_ chars: String, _ mods: NSEvent.ModifierFlags, repeating: Bool = false) -> NSEvent {
            NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: 0, windowNumber: 0, context: nil,
                             characters: chars, charactersIgnoringModifiers: chars, isARepeat: repeating, keyCode: 9)!
        }
        XCTAssertTrue(SurfaceView.pastesImage(key("v", .command)))
        XCTAssertTrue(SurfaceView.pastesImage(key("v", .control)))
        XCTAssertFalse(SurfaceView.pastesImage(key("v", [.command, .shift])))
        XCTAssertFalse(SurfaceView.pastesImage(key("v", [.control, .option])))
        XCTAssertFalse(SurfaceView.pastesImage(key("v", [])))
        XCTAssertFalse(SurfaceView.pastesImage(key("c", .command)))
        XCTAssertFalse(SurfaceView.pastesImage(key("v", .command, repeating: true)))
    }
}
