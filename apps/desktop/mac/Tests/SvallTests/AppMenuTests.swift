import AppKit
import XCTest
@testable import Svall

final class AppMenuTests: XCTestCase {
    private final class Counter: NSObject {
        var runs = 0
        @objc func run(_ sender: Any?) { runs += 1 }
    }

    private func key(_ chars: String, _ mods: NSEvent.ModifierFlags) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: 0, windowNumber: 0, context: nil,
                         characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: 0)!
    }

    func testAPageMenuShowsThePagesChordsButLeavesTheirKeysToTheMonitor() {
        // a menu item's action is sent through the application
        _ = NSApplication.shared
        let counter = Counter()
        let main = NSMenu()
        let top = NSMenuItem()
        main.addItem(top)
        let view = PageMenu(title: "View")
        top.submenu = view
        let browser = view.addItem(withTitle: "Browser on the Right", action: #selector(Counter.run(_:)), keyEquivalent: "b")
        browser.target = counter
        let full = view.addItem(withTitle: "Enter Full Screen", action: #selector(Counter.run(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        full.target = counter
        let editItem = NSMenuItem()
        main.addItem(editItem)
        editItem.submenu = NSMenu(title: "Edit")
        editItem.submenu!.addItem(withTitle: "Copy", action: #selector(Counter.run(_:)), keyEquivalent: "c").target = counter

        XCTAssertFalse(main.performKeyEquivalent(with: key("b", .command)))
        XCTAssertEqual(counter.runs, 0)
        XCTAssertTrue(main.performKeyEquivalent(with: key("f", [.command, .control])))
        XCTAssertEqual(counter.runs, 1)
        XCTAssertTrue(main.performKeyEquivalent(with: key("c", .command)))
        XCTAssertEqual(counter.runs, 2)
    }

    func testThePageNamesTheChordsTheStateAndTheFleets() throws {
        let decode = { (json: String) in try JSONDecoder().decode(ToShell.self, from: Data(json.utf8)) }
        guard case .menuState(let chords, let state) = try decode(#"{"type":"menu.state","chords":{"zoomIn":"cmd++"},"state":{"view":"board","sides":true,"sideCard":false,"resources":false,"browser":true,"card":true}}"#) else {
            return XCTFail("menu.state did not decode")
        }
        XCTAssertEqual(chords, ["zoomIn": "cmd++"])
        XCTAssertEqual(state.view, "board")
        XCTAssertTrue(state.browser)
        guard case .menuFleets(let fleets, let note) = try decode(#"{"type":"menu.fleets","fleets":[{"home":"/u/.svall","name":"main","current":true,"windowOpen":true}]}"#) else {
            return XCTFail("menu.fleets did not decode")
        }
        XCTAssertEqual(fleets.map(\.name), ["main"])
        XCTAssertNil(note)
    }

    func testTheMenuShowsThePagesChordsAndTitlesAndWaitsForThePage() {
        _ = NSApplication.shared
        let menu = AppMenu()
        let view = menu.viewItem.submenu!
        let file = menu.fileItem.submenu!
        let item = { (menu: NSMenu, title: String) in menu.items.first { $0.title == title } }
        XCTAssertFalse(menu.validateMenuItem(item(view, "Zoom In")!))

        menu.show(chords: ["zoomIn": "cmd++", "toggleSides": "cmd+shift+s"], state: MenuState(view: "map", sides: false, sideCard: true, resources: false, browser: true, card: true))
        XCTAssertTrue(menu.validateMenuItem(item(view, "Zoom In")!))
        XCTAssertEqual(item(view, "Zoom In")?.keyEquivalent, "+")
        XCTAssertEqual(item(view, "Show Sidebars")?.keyEquivalentModifierMask, [.command, .shift])
        XCTAssertNotNil(item(view, "Show Board"))
        XCTAssertNotNil(item(view, "Hide Side Card"))
        XCTAssertEqual(item(view, "Browser on the Right")?.state, .on)
        XCTAssertNotNil(item(file, "Close Card"))
        XCTAssertEqual(item(view, "Actual Size")?.keyEquivalent, "")

        menu.reset()
        XCTAssertFalse(menu.validateMenuItem(item(view, "Zoom In")!))
    }

    func testFileListsTheFleetsThisWindowsCheckedOrSaysWhyItCannot() {
        _ = NSApplication.shared
        let menu = AppMenu()
        let file = menu.fileItem.submenu!
        menu.show(chords: [:], state: MenuState(view: "map", sides: true, sideCard: false, resources: false, browser: false, card: false))
        let newFleet = file.items.first { $0.title == "New Fleet…" }!
        XCTAssertFalse(menu.validateMenuItem(newFleet))

        menu.show(fleets: [MenuFleet(home: "/u/.svall", name: "main", current: true, windowOpen: true),
                           MenuFleet(home: "/u/.svall-work", name: "work", current: false, windowOpen: true),
                           MenuFleet(home: "/u/.svall-demo", name: "demo", current: false, windowOpen: false)], note: nil)
        let at = file.index(of: newFleet)
        let rows = Array(file.items[(at - 3)..<at])
        XCTAssertEqual(rows.map(\.title), ["main", "work", "demo"])
        XCTAssertEqual(rows.map(\.state), [.on, .off, .off])
        XCTAssertEqual(rows.map { $0.badge?.stringValue }, [nil, "open", nil])
        XCTAssertTrue(menu.validateMenuItem(newFleet))

        menu.show(fleets: [], note: "This fleet runs on trift")
        XCTAssertEqual(file.items[file.index(of: newFleet) - 1].title, "This fleet runs on trift")
        XCTAssertFalse(file.items.contains { $0.title == "work" })
        XCTAssertFalse(menu.validateMenuItem(newFleet))
    }
}
