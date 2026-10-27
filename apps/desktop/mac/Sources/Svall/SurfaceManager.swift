import AppKit
import GhosttyKit

/// Whether an ssh master answers on its control socket. One that was killed leaves the file, which refuses a connect.
enum ControlSocket {
    static func answers(_ path: String) -> Bool {
        var addr = sockaddr_un()
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return false }
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes) }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        return withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        } == 0
    }
}

/// A route to another machine: the ssh master that reaches it.
struct RemoteRoute: Equatable {
    let destination: String, controlSocket: String
}

/// Where a terminal's tmux session runs: this Mac, or another machine over its master.
enum ConnectionRoute: Equatable {
    case local
    case remote(RemoteRoute)
}

/// The shell command a surface runs to attach to a robot's tmux session, here or on the machine it runs on.
enum AttachCommand {
    static func quote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// The robot's own route when it runs on another machine, else the window's.
    static func route(_ window: ConnectionRoute, _ attach: WebAttach) -> ConnectionRoute {
        attach.via.map { .remote(RemoteRoute(destination: $0.ssh, controlSocket: $0.controlSocket)) } ?? window
    }

    // libghostty runs the command through a shell, so each field is single-quoted; `=` matches the session's whole name.
    // nil while its master is gone: a session is attached only where the daemon says it lives
    static func build(route: ConnectionRoute, attach: WebAttach, tmux: String,
                      masterAnswers: (String) -> Bool = ControlSocket.answers) -> String? {
        let target = "=" + attach.session
        let session = "-S \(quote(attach.socket)) attach -t \(quote(target))"
        switch Self.route(route, attach) {
        case .local:
            return "\(quote(tmux)) \(session)"
        case .remote(let route):
            guard masterAnswers(route.controlSocket) else { return nil }
            // ssh joins the words after the destination into one line for the far login shell, which
            // splits it again, so the tmux, socket and session are quoted a second time for that shell
            let far = "\(attach.tmux.map { quote(quote($0)) } ?? "tmux") -S \(quote(quote(attach.socket))) attach -t \(quote(quote(target)))"
            // past sshd's MaxSessions on the master, ssh opens a login of its own, as the master did, without a prompt
            // ssh hands the far tmux its TERM, and Linux ships no xterm-ghostty terminfo. libghostty runs `exec -l <command>`,
            // which would take a bare TERM= for the program, so env sets it
            return "env TERM=xterm-256color ssh -S \(quote(route.controlSocket)) -o ControlMaster=no -o BatchMode=yes -tt -- \(quote(route.destination)) \(far)"
        }
    }
}

/// The shell command a terminal on another machine runs: an ssh of its own that asks nothing, forwards no agent and
/// joins no master, and that quits rather than open without the port forward a login's browser comes back on.
enum MachineCommand {
    static func build(_ machine: WebMachine) -> String? {
        guard machine.ssh.allowed(by: sshDestinationPattern) else { return nil }
        var forward = ""
        if let port = machine.forward {
            guard (1024...65535).contains(port) else { return nil }
            forward = " -o ExitOnForwardFailure=yes -L 127.0.0.1:\(port):localhost:\(port)"
        }
        // Linux ships no xterm-ghostty terminfo, as for an attach to a robot there
        return "env TERM=xterm-256color ssh -t -o BatchMode=yes -o ForwardAgent=no -o ControlPath=none -o ConnectTimeout=10\(forward) -- \(AttachCommand.quote(machine.ssh))"
    }

    /// Text that is typed and never run: one line, no control characters.
    static func typeable(_ text: String) -> Bool {
        !text.isEmpty && !text.unicodeScalars.contains { $0.properties.generalCategory == .control }
    }
}

/// A terminal on another machine coming up: up once it has shown something past login's banner and then nothing new
/// for `quiet` seconds, when the text to type goes in once; past `deadline` it counts as up and nothing is typed.
struct MachineStart {
    private let text: String?
    private let began: Date
    private let quiet: TimeInterval = 0.8, deadline: TimeInterval = 30
    private var last: String?
    private var since: Date?
    private(set) var up = false

    init(typing text: String?, at now: Date) {
        self.text = text.flatMap { MachineCommand.typeable($0) ? $0 : nil }
        began = now
    }

    /// What to type now that the screen reads `screen`.
    mutating func saw(_ screen: String, at now: Date) -> String? {
        guard !up else { return nil }
        if now.timeIntervalSince(began) >= deadline { up = true; return nil }
        guard screen == last, let since else { last = screen; since = now; return nil }
        guard SurfaceView.lastLine(of: screen) != nil, now.timeIntervalSince(since) >= quiet else { return nil }
        up = true
        return text
    }
}

/// Creates, positions, hides and frees one SurfaceView per robot id, above the webview.
final class SurfaceManager {
    private let makeView: (String, NSRect) -> SurfaceView?
    private let overlay: OverlayViews<SurfaceView>
    private var fontDelta = 0.0
    // false while the window is minimised, hidden or covered, when no surface need draw
    private var windowVisible = true
    var onExited: (String) -> Void = { _ in }
    var onFailed: (_ id: String, _ reason: String) -> Void = { _, _ in }
    var onFocused: (String) -> Void = { _ in }
    var onOpenURL: (String, String) -> Void = { _, _ in }

    convenience init(runtime: GhosttyRuntime, container: NSView, webView: NSView) {
        self.init(container: container, webView: webView) { SurfaceView(app: runtime.app, command: $0, frame: $1) }
    }

    init(container: NSView, webView: NSView, makeView: @escaping (String, NSRect) -> SurfaceView?) {
        self.makeView = makeView
        overlay = OverlayViews(container: container, webView: webView)
    }

    func setZoom(_ factor: Double, fontDelta: Double) {
        overlay.setZoom(factor)
        guard fontDelta != self.fontDelta else { return }
        self.fontDelta = fontDelta
        for view in overlay.views.values { view.setFontDelta(fontDelta) }
    }

    func setCutout(rects: [WebRect], passive: [WebRect]) {
        overlay.setCutout(rects: rects, passive: passive)
    }

    func show(id: String, rect: WebRect, attach: WebAttach?, machine: WebMachine? = nil, opacity: Double?) {
        if let view = overlay[id] {
            overlay.place(view, rect)
            view.isHidden = false
            view.setOccluded(!windowVisible)
            view.alphaValue = opacity ?? 1
            return
        }
        if let machine { return open(id: id, rect: rect, machine: machine, opacity: opacity) }
        guard let attach else { return }
        let route = AttachCommand.route(.local, attach)
        // a local attach runs this Mac's tmux, decided here; a remote one runs the far tmux the page names
        let binary = SvallHome.tmuxBinary
        // a robot's own master is gone: the page asks again, and the daemon answers once its link is back
        guard let command = AttachCommand.build(route: route, attach: attach, tmux: binary) else { return onExited(id) }
        let program = switch route { case .remote: "ssh"; default: binary }
        _ = make(id: id, command: command, program: program, rect: rect, opacity: opacity)
    }

    /// A terminal on another machine, with what the page asked for typed once its prompt is up. An ssh that ends before
    /// then failed, however long it took: login(1) passes on no exit status to tell.
    private func open(id: String, rect: WebRect, machine: WebMachine, opacity: Double?) {
        guard let command = MachineCommand.build(machine) else {
            return onFailed(id, "\(machine.ssh) is not an ssh destination a terminal opens to")
        }
        var start = MachineStart(typing: machine.type, at: Date())
        guard let view = make(id: id, command: command, program: "ssh", rect: rect, opacity: opacity,
                              failure: { _ in start.up ? nil : "ssh ended before the machine's prompt came up" }) else { return }
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self, weak view] timer in
            guard let self, let view, self.overlay[id] === view else { return timer.invalidate() }
            let text = start.saw(view.screenText() ?? "", at: Date())
            if start.up { timer.invalidate() }
            if let text { view.type(text) }
        }
    }

    /// A surface running `command`, which tells the page when it ends; `failure` names an end that failed, by default
    /// one within a second of starting.
    private func make(id: String, command: String, program: String, rect: WebRect, opacity: Double?,
                      failure: ((_ ms: UInt64) -> String?)? = nil) -> SurfaceView? {
        guard let view = makeView(command, overlay.frame(rect)) else {
            NSLog("ghostty_surface_new failed for %@", id)
            onFailed(id, "Ghostty could not open a terminal; see the app log")
            return nil
        }
        let gone: (_ failure: String?) -> Void = { [weak self, weak view] failure in
            guard let self, let view, self.overlay[id] === view else { return }
            self.close(id: id)
            if let failure { self.onFailed(id, failure) } else { self.onExited(id) }
        }
        let failed: (_ ms: UInt64) -> String? = failure ?? { $0 < 1000 ? "\(program) quit as soon as it started" : nil }
        // a tmux that ends as it starts could not attach, and shown again it would only end again; its last line says why
        view.onChildExited = { [weak view] ms in
            gone(failed(ms).map { $0 + (view?.lastLine().map { ": \($0)" } ?? "") })
        }
        view.onCloseRequested = { gone(nil) }
        view.onFocused = { [weak self] in self?.onFocused(id) }
        view.onOpenURL = { [weak self] url in self?.onOpenURL(id, url) }
        if fontDelta != 0 { view.setFontDelta(fontDelta) }
        overlay.add(view, as: id)
        overlay.mask(view)
        view.alphaValue = opacity ?? 1
        if !windowVisible { view.setOccluded(true) }
        return view
    }

    func move(id: String, rect: WebRect) {
        overlay.move(id, rect: rect)
    }

    func hide(id: String) {
        guard let view = overlay[id] else { return }
        overlay.hide(id)
        view.setOccluded(true)
    }

    func close(id: String) {
        overlay.close(id)
    }

    func setWindowVisible(_ visible: Bool) {
        windowVisible = visible
        for view in overlay.views.values where !view.isHidden { view.setOccluded(!visible) }
    }

    func focus(id: String?) {
        if let id, let view = overlay[id], !view.isHidden { view.window?.makeFirstResponder(view) }
        else { overlay.focusPage() }
    }

    func closeAll() {
        overlay.closeAll()
    }
}
