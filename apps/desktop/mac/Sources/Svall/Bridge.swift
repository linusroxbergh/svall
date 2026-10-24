import Foundation
import WebKit

struct WebAttach: Decodable {
    let socket: String, session: String
}

/// A terminal on another machine: an ssh to `ssh`, `type` typed at its prompt, and `forward` a port of this Mac's
/// loopback that reaches the same port there.
struct WebMachine: Decodable, Equatable {
    let ssh: String
    var type: String?
    var forward: Int?
}

/// Messages from the webview. Mirrors ToShell in apps/desktop/web/src/bridge.ts.
enum ToShell: Decodable {
    case connection
    case termShow(id: String, rect: WebRect, attach: WebAttach?, machine: WebMachine?, opacity: Double?)
    case termMove(id: String, rect: WebRect)
    case termHide(id: String)
    case termClose(id: String)
    case termFocus(id: String?)
    case keysRegister(chords: [String])
    case keysCapture(on: Bool)
    case keysQuit(chord: String?)
    case openUrl(url: String)
    case openFolder(path: String)
    case reveal(path: String)
    case copy(text: String)
    case openConfig(which: String)
    case zoom(factor: Double, fontDelta: Double)
    case browserShow(tab: String, rect: WebRect, url: String?, focus: Bool?)
    case browserMove(tab: String, rect: WebRect)
    case browserHide(tab: String)
    case browserClose(tab: String)
    case browserLoad(tab: String, url: String)
    case browserGo(tab: String, action: String)
    case browserImportCookies
    case browserFill(tab: String)
    case browserFocus(tab: String)
    case shellCutout(rects: [WebRect], passive: [WebRect])
    case notifyPost(key: String, title: String, subtitle: String, body: String, sound: Bool, actions: Bool, promptId: String?)
    case notifyRemove(key: String)
    case notifyEnable
    case notifySettings
    case updateInstall
    case hostStart(op: HostOp, args: HostArgs)
    case hostCancel
    case hostList
    case handoverEnable(on: Bool)
    case handoverStart(to: String, choices: HandoverChoices?, check: Bool?)
    case handoverResume
    case handoverAbort
    case handoverAttach
    case handoverChoose(choices: HandoverChoices)
    case handoverCancel
    case handoverForget
    case quitAnswer(unsaved: [String], working: Int)
    case quitStopped(ok: Bool)
    case openFleet(home: String, quit: Bool?)
    case retitle
    case setupPlan
    case setupRun(agents: [String], found: [String], projects: String)
    case folderPick(start: String)
    case awake(reason: String?, battery: Bool?)
    case connectionRetry
    case connectionHere

    private enum Keys: String, CodingKey { case type, id, rect, rects, passive, attach, machine, opacity, chords, on, chord, url, path, text, which, factor, fontDelta, tab, focus, action, key, title, subtitle, body, sound, actions, promptId, unsaved, working, ok, home, quit, agents, found, projects, start, op, args, to, choices, check, reason, battery }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "connection": self = .connection
        case "term.show": self = .termShow(id: try c.decode(String.self, forKey: .id), rect: try c.decode(WebRect.self, forKey: .rect), attach: try c.decodeIfPresent(WebAttach.self, forKey: .attach), machine: try c.decodeIfPresent(WebMachine.self, forKey: .machine), opacity: try c.decodeIfPresent(Double.self, forKey: .opacity))
        case "term.move": self = .termMove(id: try c.decode(String.self, forKey: .id), rect: try c.decode(WebRect.self, forKey: .rect))
        case "term.hide": self = .termHide(id: try c.decode(String.self, forKey: .id))
        case "term.close": self = .termClose(id: try c.decode(String.self, forKey: .id))
        case "term.focus": self = .termFocus(id: try c.decodeIfPresent(String.self, forKey: .id))
        case "keys.register": self = .keysRegister(chords: try c.decode([String].self, forKey: .chords))
        case "keys.capture": self = .keysCapture(on: try c.decode(Bool.self, forKey: .on))
        case "keys.quit": self = .keysQuit(chord: try c.decodeIfPresent(String.self, forKey: .chord))
        case "openUrl": self = .openUrl(url: try c.decode(String.self, forKey: .url))
        case "openFolder": self = .openFolder(path: try c.decode(String.self, forKey: .path))
        case "reveal": self = .reveal(path: try c.decode(String.self, forKey: .path))
        case "copy": self = .copy(text: try c.decode(String.self, forKey: .text))
        case "openConfig": self = .openConfig(which: try c.decode(String.self, forKey: .which))
        case "zoom": self = .zoom(factor: try c.decode(Double.self, forKey: .factor), fontDelta: try c.decode(Double.self, forKey: .fontDelta))
        case "browser.show": self = .browserShow(tab: try c.decode(String.self, forKey: .tab), rect: try c.decode(WebRect.self, forKey: .rect), url: try c.decodeIfPresent(String.self, forKey: .url), focus: try c.decodeIfPresent(Bool.self, forKey: .focus))
        case "browser.move": self = .browserMove(tab: try c.decode(String.self, forKey: .tab), rect: try c.decode(WebRect.self, forKey: .rect))
        case "browser.hide": self = .browserHide(tab: try c.decode(String.self, forKey: .tab))
        case "browser.close": self = .browserClose(tab: try c.decode(String.self, forKey: .tab))
        case "browser.load": self = .browserLoad(tab: try c.decode(String.self, forKey: .tab), url: try c.decode(String.self, forKey: .url))
        case "browser.go": self = .browserGo(tab: try c.decode(String.self, forKey: .tab), action: try c.decode(String.self, forKey: .action))
        case "browser.importCookies": self = .browserImportCookies
        case "browser.fill": self = .browserFill(tab: try c.decode(String.self, forKey: .tab))
        case "browser.focus": self = .browserFocus(tab: try c.decode(String.self, forKey: .tab))
        case "shell.cutout": self = .shellCutout(rects: try c.decode([WebRect].self, forKey: .rects), passive: try c.decode([WebRect].self, forKey: .passive))
        case "notify.post": self = .notifyPost(key: try c.decode(String.self, forKey: .key), title: try c.decode(String.self, forKey: .title), subtitle: try c.decode(String.self, forKey: .subtitle), body: try c.decode(String.self, forKey: .body), sound: try c.decode(Bool.self, forKey: .sound), actions: try c.decode(Bool.self, forKey: .actions), promptId: try c.decodeIfPresent(String.self, forKey: .promptId))
        case "notify.remove": self = .notifyRemove(key: try c.decode(String.self, forKey: .key))
        case "notify.enable": self = .notifyEnable
        case "notify.settings": self = .notifySettings
        case "update.install": self = .updateInstall
        case "host.start": self = .hostStart(op: try c.decode(HostOp.self, forKey: .op), args: try c.decode(HostArgs.self, forKey: .args))
        case "host.cancel": self = .hostCancel
        case "host.list": self = .hostList
        case "handover.enable": self = .handoverEnable(on: try c.decode(Bool.self, forKey: .on))
        case "handover.start": self = .handoverStart(to: try c.decode(String.self, forKey: .to), choices: try c.decodeIfPresent(HandoverChoices.self, forKey: .choices), check: try c.decodeIfPresent(Bool.self, forKey: .check))
        case "handover.resume": self = .handoverResume
        case "handover.abort": self = .handoverAbort
        case "handover.attach": self = .handoverAttach
        case "handover.choose": self = .handoverChoose(choices: try c.decode(HandoverChoices.self, forKey: .choices))
        case "handover.cancel": self = .handoverCancel
        case "handover.forget": self = .handoverForget
        case "quit.answer": self = .quitAnswer(unsaved: try c.decode([String].self, forKey: .unsaved), working: try c.decode(Int.self, forKey: .working))
        case "quit.stopped": self = .quitStopped(ok: try c.decode(Bool.self, forKey: .ok))
        case "openFleet": self = .openFleet(home: try c.decode(String.self, forKey: .home), quit: try c.decodeIfPresent(Bool.self, forKey: .quit))
        case "retitle": self = .retitle
        case "setup.plan": self = .setupPlan
        case "setup.run": self = .setupRun(agents: try c.decode([String].self, forKey: .agents), found: try c.decode([String].self, forKey: .found), projects: try c.decode(String.self, forKey: .projects))
        case "folder.pick": self = .folderPick(start: try c.decode(String.self, forKey: .start))
        case "awake": self = .awake(reason: try c.decodeIfPresent(String.self, forKey: .reason), battery: try c.decodeIfPresent(Bool.self, forKey: .battery))
        case "connection.retry": self = .connectionRetry
        case "connection.here": self = .connectionHere
        case let other: throw ShellError("unknown bridge message \(other)")
        }
    }
}

/// Messages to the webview. Mirrors FromShell in bridge.ts.
enum FromShell {
    case connection(SvallConnection?)
    case connectionState(RemoteConnection.State)
    case notice(text: String)
    case hostStep(op: String, step: HostProcess.Step)
    case hostDone(op: String, code: Int32)
    case hostMachines(machines: [[String: Any]], error: String?)
    case handoverEvent([String: Any])
    case handoverReplay([[String: Any]])
    case handoverExit(code: Int32, error: String?)
    case shellInfo(home: String, log: [String], op: Bool, ghosttyKeys: [String: String], handoverEnabled: Bool, gateway: String?, profile: String?, copyHere: Bool)
    case key(chord: String)
    case termExited(id: String)
    case termFailed(id: String, reason: String)
    case termFocused(id: String)
    case termOpenUrl(id: String, url: String, x: Double, y: Double)
    case appActive(Bool)
    case ghosttyConfigErrors([String])
    case dragOver(x: Double, y: Double)
    case dragExit
    case dragDrop(paths: [String], x: Double, y: Double)
    case browserState(BrowserState)
    case browserOpened(from: String, tab: String, url: String)
    case browserClosed(tab: String)
    case pressedAway
    case notifyPermission(String)
    case updateAvailable(String?)
    case notifyOpen(key: String)
    case notifyAction(key: String, action: String, promptId: String)
    case quitAsk
    case quitStop
    case fleets
    case openFleetFailed(home: String, reason: String)
    case setupResult(step: String, ok: Bool, json: String)
    case folderPicked(path: String)
    case memoryHigh

    var json: [String: Any] {
        switch self {
        case .connection(let c): return ["type": "connection", "host": c?.host ?? "", "port": c?.port ?? 0, "token": c?.token ?? ""]
        case .connectionState(let s):
            var json: [String: Any] = ["type": "connection.state", "state": s.state, "owner": s.owner]
            if let kind = s.kind { json["kind"] = kind }
            if let message = s.message { json["message"] = message }
            if let machine = s.machine { json["machine"] = machine }
            if let destination = s.destination { json["destination"] = destination }
            return json
        case .notice(let text): return ["type": "notice", "text": text]
        case .hostStep(let op, let step):
            var event: [String: Any] = ["step": step.step, "status": step.status]
            if let detail = step.detail { event["detail"] = detail }
            if let action = step.action { event["action"] = action }
            if let run = step.run { event["run"] = run }
            return ["type": "host.step", "op": op, "event": event]
        case .hostDone(let op, let code): return ["type": "host.done", "op": op, "code": Int(code)]
        case .hostMachines(let machines, let error):
            var json: [String: Any] = ["type": "host.machines", "machines": machines]
            if let error { json["error"] = error }
            return json
        case .handoverEvent(let event): return ["type": "handover.event", "event": event]
        case .handoverReplay(let events): return ["type": "handover.replay", "events": events]
        case .handoverExit(let code, let error):
            var json: [String: Any] = ["type": "handover.exit", "code": Int(code)]
            if let error { json["error"] = error }
            return json
        case .shellInfo(let home, let log, let op, let ghosttyKeys, let handoverEnabled, let gateway, let profile, let copyHere):
            var json: [String: Any] = ["type": "shell.info", "home": home, "log": log, "op": op, "ghosttyKeys": ghosttyKeys, "handoverEnabled": handoverEnabled, "copyHere": copyHere]
            if let gateway { json["gateway"] = gateway }
            if let profile { json["profile"] = profile }
            return json
        case .key(let chord): return ["type": "key", "chord": chord]
        case .termExited(let id): return ["type": "term.exited", "id": id]
        case .termFailed(let id, let reason): return ["type": "term.failed", "id": id, "reason": reason]
        case .termFocused(let id): return ["type": "term.focused", "id": id]
        case .termOpenUrl(let id, let url, let x, let y): return ["type": "term.openUrl", "id": id, "url": url, "x": x, "y": y]
        case .appActive(let active): return ["type": "app.active", "active": active]
        case .ghosttyConfigErrors(let errors): return ["type": "ghostty.configErrors", "errors": errors]
        case .dragOver(let x, let y): return ["type": "drag.over", "x": x, "y": y]
        case .dragExit: return ["type": "drag.exit"]
        case .dragDrop(let paths, let x, let y): return ["type": "drag.drop", "paths": paths, "x": x, "y": y]
        case .browserState(let s): return ["type": "browser.state", "tab": s.tab, "url": s.url, "title": s.title, "loading": s.loading, "canGoBack": s.canGoBack, "canGoForward": s.canGoForward, "error": s.error ?? ""]
        case .browserOpened(let from, let tab, let url): return ["type": "browser.opened", "from": from, "tab": tab, "url": url]
        case .browserClosed(let tab): return ["type": "browser.closed", "tab": tab]
        case .pressedAway: return ["type": "shell.pressedAway"]
        case .notifyPermission(let state): return ["type": "notify.permission", "state": state]
        case .updateAvailable(let version): return ["type": "update.available", "version": version ?? ""]
        case .notifyOpen(let key): return ["type": "notify.open", "key": key]
        case .notifyAction(let key, let action, let promptId): return ["type": "notify.action", "key": key, "action": action, "promptId": promptId]
        case .quitAsk: return ["type": "quit.ask"]
        case .quitStop: return ["type": "quit.stop"]
        case .fleets: return ["type": "fleets"]
        case .openFleetFailed(let home, let reason): return ["type": "openFleet.failed", "home": home, "reason": reason]
        case .setupResult(let step, let ok, let json): return ["type": "setup.result", "step": step, "ok": ok, "json": json]
        case .folderPicked(let path): return ["type": "folder.picked", "path": path]
        case .memoryHigh: return ["type": "memory.high"]
        }
    }
}

final class Bridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "svall"
    weak var webView: WKWebView?
    var onMessage: (ToShell) -> Void = { _ in }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let text = message.body as? String, let data = text.data(using: .utf8) else { return }
        do { onMessage(try JSONDecoder().decode(ToShell.self, from: data)) } catch {
            // the type alone: a message can carry a url with a sign-in code, or a file's text
            let type = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["type"] as? String ?? "?"
            NSLog("bridge: %@ in a %@ message", "\(error)", type)
        }
    }

    func send(_ message: FromShell) {
        guard let data = try? JSONSerialization.data(withJSONObject: message.json) else { return }
        let text = String(decoding: data, as: UTF8.self)
        webView?.callAsyncJavaScript("window.__svall && window.__svall.receive(json)", arguments: ["json": text], in: nil, in: .page) { result in
            // the type alone: a connection message carries the daemon token
            if case .failure(let error) = result { NSLog("bridge: %@ delivering %@", "\(error)", "\(message.json["type"] ?? "?")") }
        }
    }
}
