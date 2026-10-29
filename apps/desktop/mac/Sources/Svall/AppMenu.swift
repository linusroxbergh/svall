import AppKit

/// What the page's menu titles follow. Mirrors MenuState in apps/desktop/web/src/bridge.ts.
struct MenuState: Decodable {
    let view: String
    let sides, sideCard, resources, browser, card: Bool
}

/// A fleet on this Mac, as svalld's fleets.list gives it.
struct MenuFleet: Decodable {
    let home, name: String
    let current, windowOpen: Bool
}

/// A menu of the page's commands: it shows each one's chord, but a Cmd chord reaches the page through KeyMonitor alone,
/// so one the monitor let through (a browser tab's own ⌘B, a key in a sheet) runs nothing here.
final class PageMenu: NSMenu {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        KeyMonitor.chord(for: event) == nil && super.performKeyEquivalent(with: event)
    }
}

/// The page's commands in the menu bar, each by its action's name in keys.ts, and the fleets on this Mac in File.
final class AppMenu: NSObject, NSMenuDelegate, NSMenuItemValidation {
    static let help = "https://github.com/linusroxbergh/svall#readme"

    var send: (FromShell) -> Void = { _ in }
    private var commands: [String: NSMenuItem] = [:]
    // a click before the page has said what to show, or after it left, would be sent into nothing
    private var ready = false
    private let file = PageMenu(title: "File")
    private let newFleet = NSMenuItem(title: "New Fleet…", action: #selector(run(_:)), keyEquivalent: "")
    private var fleetItems: [NSMenuItem] = []
    // a fleet is only made from a window svalld on this Mac answers
    private var canCreate = false

    func command(_ title: String, _ action: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(run(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = action
        commands[action] = item
        return item
    }

    lazy var fileItem: NSMenuItem = {
        file.delegate = self
        file.addItem(command("New Robot…", "newRobot"))
        file.addItem(.separator())
        file.addItem(.sectionHeader(title: "Fleets"))
        newFleet.target = self
        newFleet.representedObject = "newFleet"
        file.addItem(newFleet)
        file.addItem(.separator())
        file.addItem(command("Close Robot…", "closeRobot"))
        return Self.top(file)
    }()

    lazy var viewItem: NSMenuItem = {
        let view = PageMenu(title: "View")
        for (title, action) in [("Show Board", "toggleView"), ("Hide Sidebars", "toggleSides"), ("Show Side Card", "toggleSideCard"),
                                ("Browser on the Right", "toggleBrowser"), ("Show Resources", "toggleResources")] {
            view.addItem(command(title, action))
        }
        view.addItem(.separator())
        view.addItem(command("Actual Size", "zoomReset"))
        view.addItem(command("Zoom In", "zoomIn"))
        view.addItem(command("Zoom Out", "zoomOut"))
        view.addItem(.separator())
        let full = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        return Self.top(view)
    }()

    lazy var goItem: NSMenuItem = {
        let go = PageMenu(title: "Go")
        go.addItem(command("Mission Control…", "missionControl"))
        go.addItem(.separator())
        go.addItem(command("Previous Robot", "prevRobot"))
        go.addItem(command("Next Robot", "nextRobot"))
        go.addItem(command("Next Island", "nextIsland"))
        go.addItem(.separator())
        for (title, action) in [("Terminal", "paneTerminal"), ("Browser", "paneBrowser"), ("Files", "paneFiles"), ("Changes", "paneChanges")] {
            go.addItem(command(title, action))
        }
        return Self.top(go)
    }()

    lazy var helpItem: NSMenuItem = {
        let help = NSMenu(title: "Help")
        help.addItem(withTitle: "Svall Help", action: #selector(openHelp(_:)), keyEquivalent: "").target = self
        help.addItem(command("Keyboard Shortcuts", "shortcuts"))
        help.addItem(.separator())
        help.addItem(command("Send Feedback…", "feedback"))
        NSApp.helpMenu = help
        return Self.top(help)
    }()

    private static func top(_ menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem()
        item.submenu = menu
        return item
    }

    /// The chord the page has each action on, and the state the titles follow.
    func show(chords: [String: String], state: MenuState) {
        ready = true
        for (action, item) in commands {
            let (key, mods) = KeyMonitor.keyEquivalent(for: chords[action])
            item.keyEquivalent = key
            item.keyEquivalentModifierMask = mods
        }
        let titles = [
            "toggleView": state.view == "map" ? "Show Board" : "Show Map",
            "toggleSides": state.sides ? "Hide Sidebars" : "Show Sidebars",
            "toggleSideCard": state.sideCard ? "Hide Side Card" : "Show Side Card",
            "toggleResources": state.resources ? "Hide Resources" : "Show Resources",
            "closeRobot": state.card ? "Close Card" : "Close Robot…",
        ]
        for (action, title) in titles { commands[action]?.title = title }
        commands["toggleBrowser"]?.state = state.browser ? .on : .off
    }

    /// The fleets File lists, this window's checked, or the reason it lists none.
    func show(fleets: [MenuFleet], note: String?) {
        for item in fleetItems { file.removeItem(item) }
        fleetItems = note.map { [NSMenuItem(title: $0, action: nil, keyEquivalent: "")] } ?? fleets.map { fleet in
            let item = NSMenuItem(title: fleet.name, action: #selector(openFleet(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = fleet.current ? nil : fleet.home
            item.state = fleet.current ? .on : .off
            if !fleet.current, fleet.windowOpen { item.badge = NSMenuItemBadge(string: "open") }
            return item
        }
        let at = file.index(of: newFleet)
        for (i, item) in fleetItems.enumerated() { file.insertItem(item, at: at + i) }
        canCreate = !fleets.isEmpty
        file.update()
    }

    /// The page is gone, and the one loading says again what to show.
    func reset() {
        ready = false
        show(fleets: [], note: nil)
    }

    // the list may have changed in another window or at a terminal
    func menuWillOpen(_ menu: NSMenu) {
        if ready { send(.menuAsk) }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(openHelp(_:)) { return true }
        return ready && (item !== newFleet || canCreate)
    }

    @objc private func run(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? String else { return }
        send(.menuRun(action: action))
    }

    // this window's own fleet is already in front
    @objc private func openFleet(_ sender: NSMenuItem) {
        guard let home = sender.representedObject as? String else { return }
        send(.menuOpenFleet(home: home))
    }

    @objc private func openHelp(_ sender: Any?) { ExternalURL.open(Self.help) }
}
