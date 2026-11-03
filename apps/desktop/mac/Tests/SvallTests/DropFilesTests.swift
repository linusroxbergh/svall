import AppKit
import WebKit
import XCTest
@testable import Svall

final class DropFilesTests: XCTestCase {
    private func folder() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    func testPathsAreTypedAsGhosttyTypesADrop() {
        XCTAssertEqual(ShellEscape.paths(["/tmp/svall-drop-501/aB3x/Screen Shot (1).png", "/tmp/a'b"]), #"/tmp/svall-drop-501/aB3x/Screen\ Shot\ \(1\).png /tmp/a\'b"#)
        // a newline would run what came before it
        XCTAssertEqual(ShellEscape.paths(["/tmp/a\nrm -rf ~", "/tmp/b"]), "/tmp/b")
    }

    /// A prepend character or a combining mark makes one grapheme with the metacharacter beside it, which a shell still reads.
    func testAMetacharacterInAGraphemeWithItsNeighbourIsStillEscaped() {
        XCTAssertEqual(ShellEscape.paths(["a\u{0D4E};id"]), "a\u{0D4E}\\;id")
        XCTAssertEqual(ShellEscape.paths(["a\u{0D4E}>out.txt"]), "a\u{0D4E}\\>out.txt")
        XCTAssertEqual(ShellEscape.paths([";\u{0301}rm"]), "\\;\u{0301}rm")
    }

    func testAFileIsReadPartByPartAndLetGoWithItsShortPart() throws {
        let dir = try folder()
        let file = dir.appendingPathComponent("notes.txt")
        try Data("hello".utf8).write(to: file)
        let drops = DropFiles()
        let held = drops.hold([file])[0]
        XCTAssertEqual(held.name, "notes.txt")
        XCTAssertEqual(held.bytes, 5)
        XCTAssertFalse(held.folder)
        XCTAssertEqual(drops.read(held.token, at: 0, size: 4), Data("hell".utf8))
        XCTAssertEqual(drops.read(held.token, at: 4, size: 4), Data("o".utf8))
        XCTAssertNil(drops.read(held.token, at: 0, size: 4))
        // an exact number of parts ends with an empty one
        let exact = drops.hold([file])[0]
        XCTAssertEqual(drops.read(exact.token, at: 0, size: 5), Data("hello".utf8))
        XCTAssertEqual(drops.read(exact.token, at: 5, size: 5), Data())
        XCTAssertNil(drops.read(exact.token, at: 5, size: 5))
        // a file gone since the drop has nothing to read
        let gone = drops.hold([file])[0]
        try FileManager.default.removeItem(at: file)
        XCTAssertNil(drops.read(gone.token, at: 0, size: 4))
        XCTAssertNil(drops.read(gone.token, at: 0, size: 4))
    }

    func testAFolderIsNamedAndNothingInItHeld() throws {
        let dir = try folder()
        XCTAssertEqual(DropFiles().hold([dir])[0], DroppedFile(token: "", name: dir.lastPathComponent, bytes: 0, folder: true))
    }

    func testALinkIsSizedAndReadAsWhatItNames() throws {
        let dir = try folder()
        let file = dir.appendingPathComponent("big.bin")
        try Data(repeating: 7, count: 3000).write(to: file)
        let toFile = dir.appendingPathComponent("link.bin"), toFolder = dir.appendingPathComponent("link-folder")
        try FileManager.default.createSymbolicLink(at: toFile, withDestinationURL: file)
        try FileManager.default.createSymbolicLink(at: toFolder, withDestinationURL: dir)
        let drops = DropFiles()
        let held = drops.hold([toFile, toFolder])
        XCTAssertEqual(held[0].name, "link.bin")
        XCTAssertEqual(held[0].bytes, 3000)
        XCTAssertEqual(drops.read(held[0].token, at: 0, size: 3000)?.count, 3000)
        XCTAssertEqual(held[1], DroppedFile(token: "", name: "link-folder", bytes: 0, folder: true))
    }

    /// A file's first read may wait out robot.drop for the one before it: ten minutes, and the client's half minute.
    func testEveryFileOfADropOutlivesTheUploadOfThoseBeforeIt() throws {
        let dir = try folder()
        let urls = try ["one", "two"].map { name in
            let file = dir.appendingPathComponent(name)
            try Data(name.utf8).write(to: file)
            return file
        }
        let drops = DropFiles()
        let now = Date()
        let held = drops.hold(urls, now: now)
        XCTAssertEqual(drops.read(held[0].token, at: 0, size: 4, now: now.addingTimeInterval(630)), Data("one".utf8))
        XCTAssertEqual(drops.read(held[1].token, at: 0, size: 4, now: now.addingTimeInterval(1260)), Data("two".utf8))
    }

    func testADropNoOneReadsGoesWhateverOtherDropsDo() {
        let drops = DropFiles()
        let now = Date()
        let refused = drops.hold(png: Data([1]), now: now), read = drops.hold(png: Data([2, 3]), now: now)
        XCTAssertEqual(drops.read(read.token, at: 0, size: 1, now: now.addingTimeInterval(600)), Data([2]))
        let later = drops.hold(png: Data([4]), now: now.addingTimeInterval(650))
        XCTAssertNil(drops.read(refused.token, at: 0, size: 2, now: now.addingTimeInterval(660)))
        XCTAssertEqual(drops.read(read.token, at: 1, size: 1, now: now.addingTimeInterval(660)), Data([3]))
        XCTAssertEqual(drops.read(later.token, at: 0, size: 2, now: now.addingTimeInterval(660)), Data([4]))
        // and one read last past the window is gone with the rest
        let last = drops.hold(png: Data([5, 6]), now: now)
        XCTAssertEqual(drops.read(last.token, at: 0, size: 1, now: now), Data([5]))
        XCTAssertNil(drops.read(last.token, at: 1, size: 1, now: now.addingTimeInterval(660)))
    }

    func testAPastedImageIsAPngNamedForWhenItWasPasted() throws {
        let drops = DropFiles()
        let held = drops.hold(png: Data([1, 2, 3]))
        XCTAssertNotNil(held.name.range(of: #"^pasted-image-\d{8}-\d{6}\.png$"#, options: .regularExpression))
        XCTAssertEqual(drops.read(held.token, at: 0, size: 4), Data([1, 2, 3]))
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

    func testTheImagePasteKeyIsControlVAlone() {
        func key(_ chars: String, _ mods: NSEvent.ModifierFlags, repeating: Bool = false) -> NSEvent {
            NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: 0, windowNumber: 0, context: nil,
                             characters: chars, charactersIgnoringModifiers: chars, isARepeat: repeating, keyCode: 9)!
        }
        XCTAssertTrue(SurfaceView.pastesImage(key("v", .control)))
        XCTAssertFalse(SurfaceView.pastesImage(key("v", .command)))
        XCTAssertFalse(SurfaceView.pastesImage(key("v", [.control, .shift])))
        XCTAssertFalse(SurfaceView.pastesImage(key("v", [.control, .option])))
        XCTAssertFalse(SurfaceView.pastesImage(key("v", [])))
        XCTAssertFalse(SurfaceView.pastesImage(key("c", .control)))
        XCTAssertFalse(SurfaceView.pastesImage(key("v", .control, repeating: true)))
    }

    func testThePageTypesWhereADropLandedAndIsToldOfWhatWasDropped() throws {
        let json = #"{"type":"term.type","id":"c_1","paths":["/tmp/a b"]}"#
        guard case .termType(let id, let paths) = try JSONDecoder().decode(ToShell.self, from: Data(json.utf8)) else {
            return XCTFail("not a term.type")
        }
        XCTAssertEqual(id, "c_1")
        XCTAssertEqual(paths, ["/tmp/a b"])
        let told = FromShell.termDrop(id: "c_1", files: [DroppedFile(token: "t", name: "a.png", bytes: 3, folder: false)]).json
        XCTAssertEqual(told["type"] as? String, "term.drop")
        XCTAssertEqual(told["id"] as? String, "c_1")
        let file = try XCTUnwrap((told["files"] as? [[String: Any]])?.first)
        XCTAssertEqual(file["token"] as? String, "t")
        XCTAssertEqual(file["name"] as? String, "a.png")
        XCTAssertEqual(file["bytes"] as? Int, 3)
        XCTAssertEqual(file["folder"] as? Bool, false)
    }
}

private final class FakeSchemeTask: NSObject, WKURLSchemeTask {
    let request: URLRequest
    var status: Int?, body = Data(), finished = false, failed = false
    init(_ url: String) { request = URLRequest(url: URL(string: url)!) }
    func didReceive(_ response: URLResponse) { status = (response as? HTTPURLResponse)?.statusCode }
    func didReceive(_ data: Data) { body.append(data) }
    func didFinish() { finished = true }
    func didFailWithError(_ error: Error) { failed = true }
}

final class WebAssetsDropTests: XCTestCase {
    private func start(_ url: String) -> FakeSchemeTask {
        let task = FakeSchemeTask(url)
        WebAssets(root: FileManager.default.temporaryDirectory).webView(WKWebView(), start: task)
        return task
    }

    func testTheDropRouteServesOnePartPerRequestAndFailsOnceItIsLetGo() {
        let token = DropFiles.shared.hold(png: Data([1, 2, 3])).token
        let first = start("svall://app/__drop/\(token)?at=0&size=2")
        XCTAssertEqual(first.status, 200)
        XCTAssertEqual(first.body, Data([1, 2]))
        XCTAssertTrue(first.finished)
        XCTAssertEqual(start("svall://app/__drop/\(token)?at=2&size=2").body, Data([3]))
        XCTAssertTrue(start("svall://app/__drop/\(token)?at=0&size=2").failed)
    }

    func testTheDropRouteFailsWithoutARange() {
        let token = DropFiles.shared.hold(png: Data([1])).token
        XCTAssertTrue(start("svall://app/__drop/\(token)").failed)
        XCTAssertTrue(start("svall://app/__drop/\(token)?at=-1&size=2").failed)
        XCTAssertTrue(start("svall://app/__drop/\(token)?at=0&size=0").failed)
    }

    func testAnEmptyPartFinishesWithNoBody() {
        let task = start("svall://app/__drop/\(DropFiles.shared.hold(png: Data()).token)?at=0&size=2")
        XCTAssertEqual(task.status, 200)
        XCTAssertEqual(task.body, Data())
        XCTAssertTrue(task.finished)
    }
}
