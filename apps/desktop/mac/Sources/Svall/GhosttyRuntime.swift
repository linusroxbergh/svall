import AppKit
import GhosttyKit

/// Owns the libghostty app: config, runtime callbacks and action dispatch.
final class GhosttyRuntime {
    private(set) static var shared: GhosttyRuntime?

    let app: ghostty_app_t
    let configErrors: [String]

    /// The config file Ghostty reads first, created empty when there is none, as Ghostty's own Open Config does.
    static func configPath() -> String? {
        let s = ghostty_config_open_path()
        defer { ghostty_string_free(s) }
        guard let ptr = s.ptr, s.len > 0 else { return nil }
        return String(decoding: UnsafeRawBufferPointer(start: ptr, count: Int(s.len)), as: UTF8.self)
    }

    /// The config files Ghostty loads by default that exist, in the order it loads them: XDG, then Application Support.
    static func defaultConfigFiles() -> [String] {
        let env = ProcessInfo.processInfo.environment
        let home = env["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
        let xdg = (env["XDG_CONFIG_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? home + "/.config") + "/ghostty"
        let support = (FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.path
            ?? home + "/Library/Application Support") + "/com.mitchellh.ghostty"
        return [xdg + "/config", xdg + "/config.ghostty", support + "/config", support + "/config.ghostty"]
            .filter { FileManager.default.fileExists(atPath: $0) }
    }

    static func surfaceView(_ userdata: UnsafeMutableRawPointer?) -> SurfaceView? {
        guard let userdata else { return nil }
        return Unmanaged<SurfaceView>.fromOpaque(userdata).takeUnretainedValue()
    }

    init() throws {
        guard let cfg = ghostty_config_new() else { throw ShellError("ghostty_config_new failed") }
        if let defaults = Bundle.main.path(forResource: "ghostty-defaults", ofType: nil) { ghostty_config_load_file(cfg, defaults) }
        // with no config of the user's to load, Ghostty's loader would write a template one into their home
        if !Self.defaultConfigFiles().isEmpty { ghostty_config_load_default_files(cfg) }
        ghostty_config_load_recursive_files(cfg)
        // the terminal is one of the page's surfaces: its ground and ink follow the page, the font and palette stay the user's
        if let theme = Bundle.main.path(forResource: "ghostty-theme", ofType: nil) { ghostty_config_load_file(cfg, theme) }
        ghostty_config_finalize(cfg)
        var errors: [String] = []
        for i in 0..<ghostty_config_diagnostics_count(cfg) {
            errors.append(String(cString: ghostty_config_get_diagnostic(cfg, i).message))
        }
        configErrors = errors

        var runtime = ghostty_runtime_config_s(
            userdata: nil,
            supports_selection_clipboard: false,
            wakeup_cb: { _ in DispatchQueue.main.async { GhosttyRuntime.shared.map { ghostty_app_tick($0.app) } } },
            action_cb: { _, target, action in GhosttyRuntime.action(target, action) },
            read_clipboard_cb: { userdata, location, state, mimes, count, list in
                GhosttyRuntime.readClipboard(userdata, location, state, mimes, count, list)
            },
            confirm_read_clipboard_cb: { userdata, confirm, state, request in GhosttyRuntime.confirmReadClipboard(userdata, confirm, state, request) },
            write_clipboard_cb: { userdata, location, content, len, confirm in GhosttyRuntime.writeClipboard(userdata, location, content, len, confirm) },
            close_surface_cb: { userdata, _ in GhosttyRuntime.closeSurface(userdata) }
        )
        guard let app = ghostty_app_new(&runtime, cfg) else { throw ShellError("ghostty_app_new failed") }
        self.app = app
        GhosttyRuntime.shared = self

        ghostty_app_set_focus(app, NSApp.isActive)
        let center = NotificationCenter.default
        center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in ghostty_app_set_focus(app, true) }
        center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in ghostty_app_set_focus(app, false) }
        center.addObserver(forName: NSTextInputContext.keyboardSelectionDidChangeNotification, object: nil, queue: .main) { _ in ghostty_app_keyboard_changed(app) }
    }

    private static func action(_ target: ghostty_target_s, _ action: ghostty_action_s) -> Bool {
        // on the main thread, from ghostty_app_tick or a view's input; the surface pointer is resolved now, while it exists
        var view: SurfaceView?
        if target.tag == GHOSTTY_TARGET_SURFACE, let surface = target.target.surface {
            view = surfaceView(ghostty_surface_userdata(surface))
        }
        switch action.tag {
        case GHOSTTY_ACTION_MOUSE_SHAPE:
            let shape = action.action.mouse_shape
            // at once, as a click reads it right after stating its position
            view?.overLink = shape == GHOSTTY_MOUSE_SHAPE_POINTER
            DispatchQueue.main.async { view?.setCursorShape(shape) }
            return true
        case GHOSTTY_ACTION_MOUSE_VISIBILITY:
            let hidden = action.action.mouse_visibility == GHOSTTY_MOUSE_HIDDEN
            DispatchQueue.main.async { NSCursor.setHiddenUntilMouseMoves(hidden) }
            return true
        case GHOSTTY_ACTION_SHOW_CHILD_EXITED:
            let ms = action.action.child_exited.timetime_ms
            DispatchQueue.main.async { view?.onChildExited?(ms) }
            return true
        // Ghostty's own ⌃⌘F, which a focused terminal takes before View's Enter Full Screen sees it
        case GHOSTTY_ACTION_TOGGLE_FULLSCREEN:
            DispatchQueue.main.async { view?.window?.toggleFullScreen(nil) }
            return true
        case GHOSTTY_ACTION_OPEN_URL:
            let raw = action.action.open_url
            let text = String(decoding: UnsafeRawBufferPointer(start: raw.url, count: Int(raw.len)), as: UTF8.self)
            DispatchQueue.main.async {
                if let open = view?.onOpenURL { open(text) } else { ExternalURL.open(text) }
            }
            return true
        default:
            return false
        }
    }

    private typealias Content = (mime: String, data: Data)

    private static func readClipboard(_ userdata: UnsafeMutableRawPointer?, _ location: ghostty_clipboard_e, _ state: UnsafeMutableRawPointer?,
                                      _ mimes: UnsafePointer<UnsafePointer<CChar>?>?, _ count: Int, _ list: Bool) -> ghostty_clipboard_read_result_e {
        // on the main thread: a paste comes from a view's input, an OSC 52 read from ghostty_app_tick
        guard location == GHOSTTY_CLIPBOARD_STANDARD, let surface = surfaceView(userdata)?.surface else { return GHOSTTY_CLIPBOARD_READ_UNSUPPORTED }
        // the pasteboard is served as text alone
        let text = NSPasteboard.general.string(forType: .string)
        let wantsText = (0..<count).contains { i in mimes?[i].map { String(cString: $0) } == "text/plain" }
        let contents: [Content] = wantsText ? text.map { [("text/plain", Data($0.utf8))] } ?? [] : []
        guard !contents.isEmpty || list else { return GHOSTTY_CLIPBOARD_READ_UNAVAILABLE }
        complete(surface, state, contents, available: list && text != nil ? ["text/plain"] : [])
        return GHOSTTY_CLIPBOARD_READ_STARTED
    }

    /// Completes a started read with `contents`, which Ghostty borrows only for this call.
    private static func complete(_ surface: ghostty_surface_t, _ state: UnsafeMutableRawPointer?, _ contents: [Content],
                                 available: [String], confirmed: Bool = false) {
        let strings = (contents.map(\.mime) + available).map { strdup($0) }
        // never null, as Ghostty reads each representation's bytes through a non-optional pointer
        let bytes = contents.map { item in
            let buf = UnsafeMutableRawPointer.allocate(byteCount: max(item.data.count, 1), alignment: 1)
            item.data.copyBytes(to: buf.assumingMemoryBound(to: UInt8.self), count: item.data.count)
            return buf
        }
        defer {
            strings.forEach { free($0) }
            bytes.forEach { $0.deallocate() }
        }
        let items = contents.indices.map {
            ghostty_clipboard_content_s(mime: strings[$0], data: bytes[$0].assumingMemoryBound(to: CChar.self), len: contents[$0].data.count)
        }
        let names = strings[contents.count...].map { UnsafePointer($0) }
        items.withUnsafeBufferPointer { c in
            names.withUnsafeBufferPointer { a in
                var complete = ghostty_clipboard_complete_s(contents: c.baseAddress, contents_len: c.count, available: a.baseAddress,
                                                            available_len: a.count, confirmed: confirmed, remember: false)
                ghostty_surface_complete_clipboard_request(surface, &complete, state)
            }
        }
    }

    /// Ghostty's paste protection, OSC 52 authorization and clipboard-write = ask: the user confirms or denies in a sheet.
    private static func ask(_ request: ghostty_clipboard_request_e, on view: SurfaceView, then: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        switch request {
        case GHOSTTY_CLIPBOARD_REQUEST_PASTE:
            alert.messageText = "Warning: Potentially Unsafe Paste"
            alert.informativeText = "This text looks like it contains commands, and pasting it into the terminal may run them."
            alert.addButton(withTitle: "Paste")
            alert.addButton(withTitle: "Cancel")
        case GHOSTTY_CLIPBOARD_REQUEST_OSC_52_READ, GHOSTTY_CLIPBOARD_REQUEST_KITTY_READ, GHOSTTY_CLIPBOARD_REQUEST_LIST:
            alert.messageText = "Authorize Clipboard Access"
            alert.informativeText = "A program in the terminal wants to read the clipboard."
            alert.addButton(withTitle: "Allow")
            alert.addButton(withTitle: "Deny")
        default:
            alert.messageText = "Authorize Clipboard Access"
            alert.informativeText = "A program in the terminal wants to write to the clipboard."
            alert.addButton(withTitle: "Allow")
            alert.addButton(withTitle: "Deny")
        }
        let answer = { (response: NSApplication.ModalResponse) in then(response == .alertFirstButtonReturn) }
        if let window = view.window { alert.beginSheetModal(for: window, completionHandler: answer) } else { answer(alert.runModal()) }
    }

    private static func confirmReadClipboard(_ userdata: UnsafeMutableRawPointer?, _ confirm: UnsafePointer<ghostty_clipboard_confirm_s>?,
                                             _ state: UnsafeMutableRawPointer?, _ request: ghostty_clipboard_request_e) {
        guard let view = surfaceView(userdata), let surface = view.surface else { return }
        guard let c = confirm?.pointee else { ghostty_surface_deny_clipboard_request(surface, state); return }
        // copied now, as Ghostty lends them only for this call; an approval completes with exactly these
        let contents: [Content] = (0..<c.contents_len).compactMap { i in
            guard let item = c.contents?[i], let mime = item.mime else { return nil }
            return (String(cString: mime), item.data.map { Data(bytes: $0, count: item.len) } ?? Data())
        }
        let available = (0..<c.available_len).compactMap { i in c.available?[i].map { String(cString: $0) } }
        DispatchQueue.main.async {
            ask(request, on: view) { ok in
                guard let surface = view.surface else { return }
                if ok { complete(surface, state, contents, available: available, confirmed: true) } else { ghostty_surface_deny_clipboard_request(surface, state) }
            }
        }
    }

    private static func writeClipboard(_ userdata: UnsafeMutableRawPointer?, _ location: ghostty_clipboard_e, _ content: UnsafePointer<ghostty_clipboard_content_s>?, _ len: Int, _ confirm: Bool) {
        guard location == GHOSTTY_CLIPBOARD_STANDARD, let content, len > 0 else { return }
        let view = surfaceView(userdata)
        for i in 0..<len {
            guard let mime = content[i].mime, let data = content[i].data, String(cString: mime) == "text/plain" else { continue }
            let text = String(decoding: UnsafeRawBufferPointer(start: data, count: content[i].len), as: UTF8.self)
            DispatchQueue.main.async {
                let write = {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                }
                if !confirm { write() } else if let view { ask(GHOSTTY_CLIPBOARD_REQUEST_OSC_52_WRITE, on: view) { if $0 { write() } } }
            }
        }
    }

    private static func closeSurface(_ userdata: UnsafeMutableRawPointer?) {
        let view = surfaceView(userdata)
        DispatchQueue.main.async { view?.onCloseRequested?() }
    }
}
