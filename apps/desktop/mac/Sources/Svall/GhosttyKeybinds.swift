import Carbon
import Foundation

/// The chords the user has spent in their own Ghostty config, in the form KeyMonitor speaks.
/// Ghostty's own defaults are not read: shadowing those is what the app is for.
enum GhosttyKeybinds {
    private static let commandMods: Set<String> = ["cmd", "command", "super"]
    /// prefixes Ghostty allows in front of a trigger, none of which change which keys it covers
    private static let triggerPrefixes = ["global:", "all:", "unconsumed:", "performable:"]
    /// the key names Ghostty accepts for characters the app can claim
    private static let namedKeys: [String: String] = [
        "comma": ",", "period": ".", "slash": "/", "semicolon": ";", "apostrophe": "'", "quote": "'",
        "minus": "-", "equal": "=", "plus": "+", "grave_accent": "`", "backquote": "`", "backslash": "\\",
        "bracket_left": "[", "bracket_right": "]",
        "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
        "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    ]
    private static var cached: [String: String]?

    /// Read once: the config is only consulted to decide what the app may take, and that is settled at launch.
    static func userChords() -> [String: String] {
        if let cached { return cached }
        var out: [String: String] = [:]
        // the files as Ghostty loaded them; asking Ghostty for its config path would create one
        for path in GhosttyRuntime.defaultConfigFiles() {
            read(URL(fileURLWithPath: path), depth: 0, into: &out)
        }
        cached = out
        return out
    }

    private static func read(_ url: URL, depth: Int, into out: inout [String: String]) {
        guard depth < 4, let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let s = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !s.hasPrefix("#"), let eq = s.firstIndex(of: "=") else { continue }
            let key = s[s.startIndex..<eq].trimmingCharacters(in: .whitespacesAndNewlines)
            let value = s[s.index(after: eq)...].trimmingCharacters(in: .whitespacesAndNewlines)
            if key == "config-file" {
                read(expand(value, near: url), depth: depth + 1, into: &out)
            } else if key == "keybind" {
                // `clear`, and an empty value that goes back to Ghostty's defaults, drop every binding above it;
                // `unbind` hands one key back
                if value.isEmpty || value == "clear" { out = [:] }
                else if let (chord, action) = binding(value) { out[chord] = action == "unbind" ? nil : action }
            }
        }
    }

    private static func expand(_ path: String, near url: URL) -> URL {
        var p = path
        if p.hasPrefix("?") { p.removeFirst() }
        if p.hasPrefix("~") { return URL(fileURLWithPath: NSString(string: p).expandingTildeInPath) }
        if p.hasPrefix("/") { return URL(fileURLWithPath: p) }
        return url.deletingLastPathComponent().appendingPathComponent(p)
    }

    /// `cmd+shift+p=new_window` -> ("cmd+shift+p", "new_window")
    private static func binding(_ value: String) -> (String, String)? {
        guard let eq = separator(in: value) else { return nil }
        var trigger = String(value[value.startIndex..<eq]).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let action = String(value[value.index(after: eq)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        while let p = triggerPrefixes.first(where: { trigger.hasPrefix($0) }) { trigger.removeFirst(p.count) }
        // a sequence fires on more than one press, which the app has no way to swallow
        guard !trigger.contains(">"), !action.isEmpty else { return nil }
        guard let chord = chord(for: trigger) else { return nil }
        return (chord, action)
    }

    /// The `=` that parts trigger from action is the first one that is not itself the key, as in `cmd+==zoom`.
    private static func separator(in value: String) -> String.Index? {
        var i = value.startIndex
        while let eq = value[i...].firstIndex(of: "=") {
            let next = value.index(after: eq)
            if next == value.endIndex || (value[next] != "=" && value[next] != "+") { return eq }
            i = next
        }
        return nil
    }

    /// Only the shape KeyMonitor can claim: Command, optionally with Shift, on one key.
    private static func chord(for trigger: String) -> String? {
        // the key itself may be the plus sign, which leaves an empty piece between the separators
        var parts = trigger.components(separatedBy: "+")
        if parts.count >= 2, parts[parts.count - 1].isEmpty, parts[parts.count - 2].isEmpty {
            parts.removeLast()
            parts[parts.count - 1] = "+"
        }
        guard var key = parts.popLast(), !parts.isEmpty else { return nil }
        let mods = Set(parts)
        guard mods.subtracting(commandMods).subtracting(["shift"]).isEmpty else { return nil }
        guard !mods.intersection(commandMods).isEmpty else { return nil }
        for prefix in ["physical:", "digit_", "key_"] where key.hasPrefix(prefix) { key.removeFirst(prefix.count) }
        let shift = mods.contains("shift")
        if key == "enter" || key == "return" { return "cmd+" + (shift ? "shift+" : "") + "enter" }
        guard let k = namedKeys[key] ?? (key.count == 1 ? key : nil) else { return nil }
        return "cmd+" + (shift ? "shift+" + (shifted(k) ?? k) : k)
    }

    /// What KeyMonitor reads with Shift on the key the current layout types `key` with: `cmd+shift+1` is ⌘! on a US layout.
    private static func shifted(_ key: String) -> String? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let layout = Unmanaged<CFData>.fromOpaque(data).takeUnretainedValue() as Data
        return layout.withUnsafeBytes { raw -> String? in
            guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
            func type(_ code: UInt16, shift: Bool) -> String? {
                var dead: UInt32 = 0, length = 0
                var chars = [UniChar](repeating: 0, count: 4)
                guard UCKeyTranslate(layout, code, UInt16(kUCKeyActionDown), shift ? UInt32(shiftKey >> 8) : 0, UInt32(LMGetKbdType()),
                                     OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars) == noErr, length > 0 else { return nil }
                return String(utf16CodeUnits: chars, count: length)
            }
            guard let code = (0..<128).first(where: { type(UInt16($0), shift: false) == key }) else { return nil }
            return type(UInt16(code), shift: true)?.lowercased()
        }
    }
}
