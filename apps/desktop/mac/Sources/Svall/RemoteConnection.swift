import Foundation

/// Where the daemon this window talks to runs. It is unknown while the helper is opening a route:
/// until it says online, nothing may be attached, because the fleet may be on another machine.
enum ConnectionRoute: Equatable {
    case local
    case pending
    case remote(RemoteRoute)
}

/// The window's connection to a fleet. The helper decides whether that fleet is on this Mac or on the
/// machine that owns it now, and keeps saying so; without a helper the local daemon's files still serve.
final class RemoteConnection {
    struct State {
        let state: String, owner: String
        let kind: String?, message: String?
    }

    private var helper: ControllerProcess?
    private let local: () -> SvallConnection?
    private let localOnly: () -> Bool
    private var owner = "local"
    private var rebuildWhenOnline = false
    private var saidOnline = false

    // what the helper said online with; only a remote owner's forward is kept from it
    private var online: SvallConnection?
    private(set) var route: ConnectionRoute = .local
    private(set) var state: State?

    /// Where the page reaches the fleet now. A named profile's daemon picks a new port each time it
    /// starts, so a fleet on this Mac is read afresh from its files; a remote one is the helper's forward.
    var connection: SvallConnection? {
        route == .local ? local() : online
    }

    var onConnection: (SvallConnection?) -> Void = { _ in }
    var onState: (State) -> Void = { _ in }
    /// Every surface is to be attached afresh: the route under them went, or the fleet moved.
    var onSurfaces: () -> Void = {}

    /// `localOnly` says whether the fleet's config names no gateway, so it can only be on this Mac.
    init(helper: ControllerProcess?, local: @escaping () -> SvallConnection?, localOnly: @escaping () -> Bool = { false }) {
        self.helper = helper
        self.local = local
        self.localOnly = localOnly
    }

    func start() {
        guard let helper else { return fallBack() }
        route = .pending
        saidOnline = false
        helper.onEvent = { [weak self] event in self?.handle(event) }
        helper.onExit = { [weak self] status in
            guard let self else { return }
            publish(State(state: "error", owner: owner, kind: "other", message: "the connection helper stopped (exit \(status))"))
            fallBackIfLocalOnly()
        }
        do { try helper.start() } catch {
            NSLog("svall: could not start the connection helper: %@", "\(error)")
            fallBack()
        }
    }

    func stop() {
        helper?.stop()
    }

    /// A handover moved the fleet: a fresh helper resolves its owner now, where the old one would find out only on its next tick.
    func reconnect(with next: ControllerProcess) {
        helper?.stop()
        helper = next
        online = nil
        start()
    }

    /// The window says which machine the fleet is on; a fleet on this Mac is just the fleet.
    static func windowTitle(base: String, owner: String) -> String {
        owner == "local" ? base : "\(base) — \(owner)"
    }

    /// A path the page names lives on the machine the fleet runs on; only a remote owner's is out of reach.
    /// While the route is still opening, the fleet is most often this Mac's, whose daemon may be what is down.
    func notice(forOpening path: String) -> String? {
        guard case .remote(let route) = route else { return nil }
        return "\(path) is on \(route.name); open it there"
    }

    /// The fleet's config is the running daemon's only on the machine it runs on; Ghostty's is this Mac's own.
    func notice(forConfig which: String, at path: String) -> String? {
        which == "ghostty" ? nil : notice(forOpening: path)
    }

    /// A build with no helper beside it keeps the local-only experience it had before.
    private func fallBack() {
        route = .local
        onConnection(connection)
    }

    /// A helper that failed before it said where the fleet is leaves a fleet with no gateway where it can only be.
    private func fallBackIfLocalOnly() {
        guard !saidOnline, route == .pending, localOnly() else { return }
        fallBack()
    }

    private func handle(_ event: ControllerEvent) {
        switch event {
        case .connecting(let owner):
            self.owner = owner
            publish(State(state: "connecting", owner: owner, kind: nil, message: nil))
        case .online(let connection, let remote):
            saidOnline = true
            owner = remote?.name ?? "local"
            route = remote.map { .remote($0) } ?? .local
            online = connection
            onConnection(connection)
            publish(State(state: "online", owner: owner, kind: nil, message: nil))
            // the route behind the old surfaces is gone, and anything the page asked for while it was
            // unknown was only remembered, so both are attached over the new one
            if rebuildWhenOnline { onSurfaces() }
            rebuildWhenOnline = true
        case .error(let kind, let message):
            publish(State(state: "error", owner: owner, kind: kind, message: message))
            fallBackIfLocalOnly()
        case .ownerChanged(let owner):
            self.owner = owner
            online = nil
            route = .pending
            onSurfaces()
            publish(State(state: "owner-changed", owner: owner, kind: nil, message: nil))
        }
    }

    private func publish(_ state: State) {
        self.state = state
        onState(state)
    }
}
