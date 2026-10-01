// Stands in for agent-hook.mjs and claude-status.mjs, beside them in a fleet's hooks folder, without starting node:
//   svall-hook claude|codex <pid>    a Claude Code or Codex hook
//   svall-hook status [<command>]    the statusline wrapper
// The daemon gets the scripts' lines byte for byte, so JSON is read and written as JSON.parse and JSON.stringify do.
import Darwin

typealias Bytes = [UInt8]
/// A JS string: UTF-16 code units, which is what the scripts slice.
typealias Text = [UInt16]

func text(_ s: String) -> Text { Array(s.utf16) }

enum JSON {
    case null, bool(Bool), number(Double), string(Text), array([JSON]), object([(key: Text, value: JSON)])

    /// A member of an object; nil for anything else, as a JS property read on a primitive or an array finds none.
    subscript(_ key: String) -> JSON? {
        guard case .object(let members) = self else { return nil }
        let k = text(key)
        return members.first { $0.key == k }?.value
    }

    var string: Text? { if case .string(let s) = self { return s }; return nil }

    var truthy: Bool {
        switch self {
        case .null: return false
        case .bool(let b): return b
        case .number(let d): return d != 0 && !d.isNaN
        case .string(let s): return !s.isEmpty
        case .array, .object: return true
        }
    }
}

// MARK: JSON.parse

func appendScalar(_ cp: UInt32, _ out: inout Text) {
    if cp < 0x10000 { out.append(UInt16(cp)); return }
    out.append(UInt16(0xD800 + ((cp - 0x10000) >> 10)))
    out.append(UInt16(0xDC00 + ((cp - 0x10000) & 0x3FF)))
}

/// UTF-8 to UTF-16 the way node decodes it (WHATWG): each bad sequence becomes one U+FFFD.
func decodeUTF8(_ b: ArraySlice<UInt8>, _ out: inout Text) {
    var need = 0, seen = 0, cp: UInt32 = 0, lower: UInt8 = 0x80, upper: UInt8 = 0xBF
    var i = b.startIndex
    while i < b.endIndex {
        let c = b[i]
        if need == 0 {
            switch c {
            case 0x00...0x7F: out.append(UInt16(c))
            case 0xC2...0xDF: need = 1; cp = UInt32(c & 0x1F)
            case 0xE0...0xEF:
                if c == 0xE0 { lower = 0xA0 }
                if c == 0xED { upper = 0x9F }
                need = 2; cp = UInt32(c & 0x0F)
            case 0xF0...0xF4:
                if c == 0xF0 { lower = 0x90 }
                if c == 0xF4 { upper = 0x8F }
                need = 3; cp = UInt32(c & 0x07)
            default: out.append(0xFFFD)
            }
            i += 1
            continue
        }
        if c < lower || c > upper {
            // the byte that broke the sequence is read again on its own
            need = 0; seen = 0; cp = 0; lower = 0x80; upper = 0xBF
            out.append(0xFFFD)
            continue
        }
        lower = 0x80; upper = 0xBF
        cp = cp << 6 | UInt32(c & 0x3F)
        seen += 1
        i += 1
        if seen == need { appendScalar(cp, &out); need = 0; seen = 0; cp = 0 }
    }
    if need != 0 { out.append(0xFFFD) }
}

func hexDigit(_ c: UInt8) -> UInt16? {
    switch c {
    case 0x30...0x39: return UInt16(c - 0x30)
    case 0x41...0x46: return UInt16(c - 0x37)
    case 0x61...0x66: return UInt16(c - 0x57)
    default: return nil
    }
}

/// The integer a key names when JS lists it before the others: an array index, in canonical form.
func arrayIndex(_ k: Text) -> UInt64? {
    guard !k.isEmpty, k.count <= 10, k.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), k[0] != 0x30 || k.count == 1 else { return nil }
    let n = k.reduce(UInt64(0)) { $0 * 10 + UInt64($1 - 0x30) }
    return n <= 4_294_967_294 ? n : nil
}

struct Parser {
    let b: Bytes
    var i = 0
    var depth = 0

    static func parse(_ b: Bytes) -> JSON? {
        var p = Parser(b: b)
        guard let v = p.value() else { return nil }
        p.space()
        return p.i == b.count ? v : nil
    }

    mutating func space() {
        while i < b.count, b[i] == 0x20 || b[i] == 0x0A || b[i] == 0x0D || b[i] == 0x09 { i += 1 }
    }

    func at(_ c: UInt8) -> Bool { i < b.count && b[i] == c }

    mutating func value() -> JSON? {
        space()
        guard i < b.count else { return nil }
        switch b[i] {
        case UInt8(ascii: "{"): return object()
        case UInt8(ascii: "["): return array()
        case UInt8(ascii: "\""): return string().map { .string($0) }
        case UInt8(ascii: "t"): return word("true", .bool(true))
        case UInt8(ascii: "f"): return word("false", .bool(false))
        case UInt8(ascii: "n"): return word("null", .null)
        default: return number()
        }
    }

    mutating func word(_ w: String, _ v: JSON) -> JSON? {
        let u = w.utf8
        guard b.count - i >= u.count, b[i..<i + u.count].elementsEqual(u) else { return nil }
        i += u.count
        return v
    }

    mutating func digits() -> Bool {
        let start = i
        while i < b.count, b[i] >= 0x30 && b[i] <= 0x39 { i += 1 }
        return i > start
    }

    mutating func number() -> JSON? {
        let start = i
        if at(UInt8(ascii: "-")) { i += 1 }
        if at(UInt8(ascii: "0")) { i += 1 } else if !digits() { return nil }
        if at(UInt8(ascii: ".")) { i += 1; guard digits() else { return nil } }
        if at(UInt8(ascii: "e")) || at(UInt8(ascii: "E")) {
            i += 1
            if at(UInt8(ascii: "+")) || at(UInt8(ascii: "-")) { i += 1 }
            guard digits() else { return nil }
        }
        let token = Array(b[start..<i]) + [0]
        return .number(token.withUnsafeBufferPointer { $0.withMemoryRebound(to: CChar.self) { strtod($0.baseAddress!, nil) } })
    }

    mutating func string() -> Text? {
        i += 1
        var out = Text()
        var run = i
        while i < b.count {
            let c = b[i]
            if c == UInt8(ascii: "\"") { decodeUTF8(b[run..<i], &out); i += 1; return out }
            if c < 0x20 { return nil }
            guard c == UInt8(ascii: "\\") else { i += 1; continue }
            decodeUTF8(b[run..<i], &out)
            i += 1
            guard i < b.count else { return nil }
            switch b[i] {
            case UInt8(ascii: "\""), UInt8(ascii: "\\"), UInt8(ascii: "/"): out.append(UInt16(b[i]))
            case UInt8(ascii: "b"): out.append(0x08)
            case UInt8(ascii: "f"): out.append(0x0C)
            case UInt8(ascii: "n"): out.append(0x0A)
            case UInt8(ascii: "r"): out.append(0x0D)
            case UInt8(ascii: "t"): out.append(0x09)
            case UInt8(ascii: "u"):
                guard i + 4 < b.count else { return nil }
                var unit: UInt16 = 0
                for k in 1...4 {
                    guard let d = hexDigit(b[i + k]) else { return nil }
                    unit = unit << 4 | d
                }
                out.append(unit)
                i += 4
            default: return nil
            }
            i += 1
            run = i
        }
        return nil
    }

    mutating func array() -> JSON? {
        i += 1
        depth += 1
        defer { depth -= 1 }
        guard depth <= 10_000 else { return nil }
        var items: [JSON] = []
        space()
        if at(UInt8(ascii: "]")) { i += 1; return .array(items) }
        while true {
            guard let v = value() else { return nil }
            items.append(v)
            space()
            if at(UInt8(ascii: ",")) { i += 1; continue }
            guard at(UInt8(ascii: "]")) else { return nil }
            i += 1
            return .array(items)
        }
    }

    mutating func object() -> JSON? {
        i += 1
        depth += 1
        defer { depth -= 1 }
        guard depth <= 10_000 else { return nil }
        var members: [(key: Text, value: JSON)] = []
        var index: [Text: Int] = [:]
        space()
        if at(UInt8(ascii: "}")) { i += 1; return .object(members) }
        while true {
            space()
            guard at(UInt8(ascii: "\"")), let key = string() else { return nil }
            space()
            guard at(UInt8(ascii: ":")) else { return nil }
            i += 1
            guard let v = value() else { return nil }
            // a repeated key keeps its first place and takes the last value
            if let n = index[key] { members[n].value = v } else { index[key] = members.count; members.append((key, v)) }
            space()
            if at(UInt8(ascii: ",")) { i += 1; continue }
            guard at(UInt8(ascii: "}")) else { return nil }
            i += 1
            break
        }
        // JS lists index keys first, in numeric order
        let indexed = members.compactMap { m in arrayIndex(m.key).map { ($0, m) } }
        if indexed.isEmpty { return .object(members) }
        return .object(indexed.sorted { $0.0 < $1.0 }.map { $0.1 } + members.filter { arrayIndex($0.key) == nil })
    }
}

// MARK: JSON.stringify

/// Number.prototype.toString. Swift's description holds the same shortest round-trip digits in another layout.
func jsNumber(_ d: Double) -> String {
    if d.isNaN { return "NaN" }
    if d == 0 { return "0" }
    if d < 0 { return "-" + jsNumber(-d) }
    if d.isInfinite { return "Infinity" }
    let s = Array(d.description.utf8)
    let e = s.firstIndex(of: UInt8(ascii: "e")) ?? s.count
    let mantissa = s[..<e]
    var digits = mantissa.filter { $0 != UInt8(ascii: ".") }
    var n = (mantissa.firstIndex(of: UInt8(ascii: ".")) ?? e) + (e < s.count ? Int(String(decoding: s[(e + 1)...], as: UTF8.self))! : 0)
    while digits.first == UInt8(ascii: "0") { digits.removeFirst(); n -= 1 }
    while digits.last == UInt8(ascii: "0") { digits.removeLast() }
    let k = digits.count
    let ds = String(decoding: digits, as: UTF8.self)
    if k <= n && n <= 21 { return ds + String(repeating: "0", count: n - k) }
    if 0 < n && n <= 21 { return String(ds.prefix(n)) + "." + String(ds.dropFirst(n)) }
    if -6 < n && n <= 0 { return "0." + String(repeating: "0", count: -n) + ds }
    return String(ds.prefix(1)) + (k > 1 ? "." + String(ds.dropFirst()) : "") + "e" + (n - 1 >= 0 ? "+" : "-") + String(abs(n - 1))
}

func put(_ s: String, _ out: inout Bytes) { out.append(contentsOf: s.utf8) }

func escape(_ c: UInt16, _ out: inout Bytes) {
    let hex = Array("0123456789abcdef".utf8)
    put("\\u", &out)
    for shift in stride(from: 12, through: 0, by: -4) { out.append(hex[Int(c >> UInt16(shift) & 0xF)]) }
}

func quote(_ s: Text, _ out: inout Bytes) {
    out.append(UInt8(ascii: "\""))
    var k = 0
    while k < s.count {
        let c = s[k]
        k += 1
        switch c {
        case 0x22: put("\\\"", &out)
        case 0x5C: put("\\\\", &out)
        case 0x08: put("\\b", &out)
        case 0x0C: put("\\f", &out)
        case 0x0A: put("\\n", &out)
        case 0x0D: put("\\r", &out)
        case 0x09: put("\\t", &out)
        case 0..<0x20: escape(c, &out)
        case 0x20..<0x80: out.append(UInt8(c))
        case 0x80..<0x800: out += [UInt8(0xC0 | c >> 6), UInt8(0x80 | c & 0x3F)]
        case 0xD800..<0xDC00 where k < s.count && (0xDC00..<0xE000).contains(s[k]):
            let cp = 0x10000 + (UInt32(c - 0xD800) << 10) + UInt32(s[k] - 0xDC00)
            k += 1
            out += [UInt8(0xF0 | cp >> 18), UInt8(0x80 | cp >> 12 & 0x3F), UInt8(0x80 | cp >> 6 & 0x3F), UInt8(0x80 | cp & 0x3F)]
        case 0xD800..<0xE000: escape(c, &out)
        default: out += [UInt8(0xE0 | c >> 12), UInt8(0x80 | c >> 6 & 0x3F), UInt8(0x80 | c & 0x3F)]
        }
    }
    out.append(UInt8(ascii: "\""))
}

func stringify(_ v: JSON, _ out: inout Bytes) {
    switch v {
    case .null: put("null", &out)
    case .bool(let b): put(b ? "true" : "false", &out)
    case .number(let d): put(d.isFinite ? jsNumber(d) : "null", &out)
    case .string(let s): quote(s, &out)
    case .array(let items):
        out.append(UInt8(ascii: "["))
        for (n, item) in items.enumerated() {
            if n > 0 { out.append(UInt8(ascii: ",")) }
            stringify(item, &out)
        }
        out.append(UInt8(ascii: "]"))
    case .object(let members):
        out.append(UInt8(ascii: "{"))
        for (n, m) in members.enumerated() {
            if n > 0 { out.append(UInt8(ascii: ",")) }
            quote(m.key, &out)
            out.append(UInt8(ascii: ":"))
            stringify(m.value, &out)
        }
        out.append(UInt8(ascii: "}"))
    }
}

func line(_ v: JSON) -> Bytes {
    var out = Bytes()
    stringify(v, &out)
    out.append(0x0A)
    return out
}

/// Array.prototype.join, which renders null as nothing and an element array joined by commas.
func join(_ items: [JSON], _ sep: String) -> Text {
    var out = Text()
    for (n, item) in items.enumerated() {
        if n > 0 { out += text(sep) }
        switch item {
        case .null: break
        case .bool(let b): out += text(b ? "true" : "false")
        case .number(let d): out += text(jsNumber(d))
        case .string(let s): out += s
        case .array(let inner): out += join(inner, ",")
        case .object: out += text("[object Object]")
        }
    }
    return out
}

// MARK: paths, as node's path module treats them

func cString<R>(_ b: Bytes, _ f: (UnsafePointer<CChar>) -> R) -> R {
    (b + [0]).withUnsafeBufferPointer { $0.withMemoryRebound(to: CChar.self) { f($0.baseAddress!) } }
}

func bytes(_ p: UnsafePointer<CChar>) -> Bytes {
    Array(UnsafeBufferPointer(start: UnsafeRawPointer(p).assumingMemoryBound(to: UInt8.self), count: strlen(p)))
}

func env(_ name: String) -> Bytes? { getenv(name).map { bytes($0) } }

func normalize(_ p: Bytes) -> Bytes {
    let absolute = p.first == UInt8(ascii: "/")
    var parts: [ArraySlice<UInt8>] = []
    for part in p.split(separator: UInt8(ascii: "/")) where part != [UInt8(ascii: ".")] {
        if part != [UInt8(ascii: "."), UInt8(ascii: ".")] { parts.append(part) }
        else if let last = parts.last, last != [UInt8(ascii: "."), UInt8(ascii: ".")] { parts.removeLast() }
        else if !absolute { parts.append(part) }
    }
    let joined = Array(parts.joined(separator: [UInt8(ascii: "/")]))
    return absolute ? [UInt8(ascii: "/")] + joined : joined.isEmpty ? [UInt8(ascii: ".")] : joined
}

func resolve(_ p: Bytes) -> Bytes {
    if p.first == UInt8(ascii: "/") { return normalize(p) }
    var cwd = Bytes(repeating: 0, count: Int(MAXPATHLEN))
    let here = cwd.withUnsafeMutableBufferPointer { $0.withMemoryRebound(to: CChar.self) { getcwd($0.baseAddress, $0.count).map { bytes($0) } } }
    return normalize((here ?? []) + [UInt8(ascii: "/")] + p)
}

func dirname(_ p: Bytes) -> Bytes {
    guard let slash = p.lastIndex(of: UInt8(ascii: "/")) else { return [UInt8(ascii: ".")] }
    return slash == 0 ? [UInt8(ascii: "/")] : Array(p[..<slash])
}

func basename(_ p: Bytes) -> Bytes {
    var end = p.count
    while end > 0 && p[end - 1] == UInt8(ascii: "/") { end -= 1 }
    let start = p[..<end].lastIndex(of: UInt8(ascii: "/")).map { $0 + 1 } ?? 0
    return Array(p[start..<end])
}

func join(_ dir: Bytes, _ name: String) -> Bytes {
    normalize(dir.isEmpty ? Array(name.utf8) : dir + [UInt8(ascii: "/")] + Array(name.utf8))
}

/// Which build a fleet home belongs to: the release's `.svall` and `.svall-<name>`, else Svall Dev, which answers test fleets too.
func isRelease(_ home: Bytes) -> Bool {
    let b = basename(home)
    let base = Array(".svall".utf8), dev = Array(".svall-dev".utf8)
    let named = b == base || (b.count > 7 && b.starts(with: base + [UInt8(ascii: "-")]) && (0x61...0x7A).contains(b[7])
        && b[8...].allSatisfy { (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) || $0 == UInt8(ascii: "-") })
    let isDev = b.starts(with: dev) && (b.count == dev.count || b[dev.count] == UInt8(ascii: "-"))
    return named && !isDev
}

// MARK: io

func now() -> Double {
    var t = timespec()
    clock_gettime(CLOCK_REALTIME, &t)
    return Double(t.tv_sec) + Double(t.tv_nsec) / 1e9
}

/// Ends the process with 0 once `seconds` pass; 0 disarms it.
func exitAfter(_ seconds: Double) {
    var t = itimerval(it_interval: timeval(), it_value: timeval(tv_sec: Int(seconds), tv_usec: Int32((seconds - Double(Int(seconds))) * 1e6)))
    setitimer(ITIMER_REAL, &t, nil)
}

func readAll(_ fd: Int32) -> Bytes {
    var out = Bytes()
    var chunk = Bytes(repeating: 0, count: 1 << 16)
    while true {
        let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
        if n > 0 { out += chunk[..<n]; continue }
        if n < 0 && errno == EINTR { continue }
        if n < 0 && errno == EAGAIN { var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0); _ = poll(&p, 1, -1); continue }
        return out
    }
}

/// Writes all of `b`, giving up at `deadline` when there is one.
func writeAll(_ fd: Int32, _ b: Bytes, deadline: Double? = nil) -> Bool {
    var off = 0
    while off < b.count {
        let n = b[off...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        if n >= 0 { off += n; continue }
        guard errno == EAGAIN || errno == EINTR else { return false }
        let wait = deadline.map { Int32(max(0, ($0 - now()) * 1000)) } ?? -1
        if wait == 0 { return false }
        var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        _ = poll(&p, 1, wait)
    }
    return true
}

/// A connected socket, or the errno its connect failed with.
func connectTo(_ path: Bytes) -> (fd: Int32, error: Int32) {
    var addr = sockaddr_un()
    // node refuses a path that leaves no room for the NUL
    guard path.count < MemoryLayout.size(ofValue: addr.sun_path) else { return (-1, EINVAL) }
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &addr.sun_path) { dst in for (n, c) in path.enumerated() { dst[n] = c } }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return (-1, errno) }
    let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    if ok == 0 { return (fd, 0) }
    let e = errno
    close(fd)
    return (-1, e)
}

// MARK: agent-hook.mjs

let KEEP = ["hook_event_name", "agent_id", "session_id", "transcript_path", "notification_type", "message", "background_tasks", "cwd", "model", "prompt", "prompt_id", "turn_id"]
let WAITS = [text("SessionStart"), text("UserPromptSubmit")]
let ONCE = [text("PreToolUse"), text("PostToolUse")]
let RETRIES = 8

/// a ?? b: b where a is null or missing.
func given(_ a: JSON?, _ b: @autoclosure () -> JSON?) -> JSON? {
    if case .null? = a { return b() }
    return a ?? b()
}

func hookLine(_ h: JSON, charId: Text, term: Bool, backend: String, pid: Double?) -> Bytes {
    let event = h["hook_event_name"]?.string
    var message = h["message"]
    // codex says what it asks permission for inside tool_input
    if event == text("PermissionRequest") && !(message?.truthy ?? false) {
        let input = h["tool_input"]
        let why = given(given(input?["description"], input?["command"]), h["tool_name"])
        var said = why?.string
        if case .array(let items)? = why { said = join(items, " ") }
        if let said, !said.isEmpty { message = .string(Array(said.prefix(500))) }
    }
    // Claude Code's StopFailure names the API error that ended the turn, and carries the text it showed for it
    if event == text("StopFailure") && !(message?.truthy ?? false) {
        let last = h["last_assistant_message"]
        if let said = ((last?.truthy ?? false) ? last : h["error"])?.string, !said.isEmpty { message = .string(Array(said.prefix(500))) }
    }
    var hook: [(key: Text, value: JSON)] = []
    for k in KEEP {
        guard var v = k == "message" ? message : h[k] else { continue }
        if k == "prompt", case .string(let s) = v { v = .string(Array(s.prefix(4000))) }
        hook.append((text(k), v))
    }
    var out: [(key: Text, value: JSON)] = [(text("charId"), .string(charId))]
    if term { out.append((text("term"), .number(2))) }
    out.append((text("backend"), .string(text(backend))))
    if let pid { out.append((text("pid"), .number(pid))) }
    out.append((text("hook"), .object(hook)))
    return line(.object(out))
}

func gaveUpLately(_ down: Bytes) -> Bool {
    var st = stat()
    guard cString(down, { stat($0, &st) }) == 0 else { return false }
    let mtime = Double(st.st_mtimespec.tv_sec) * 1000 + Double(st.st_mtimespec.tv_nsec) / 1e6
    return (now() * 1000).rounded(.down) - mtime < 60_000
}

/// Hands the line over and, for the events the daemon answers, prints its answer.
func talk(_ fd: Int32, _ out: Bytes, _ event: Text?) -> Never {
    guard writeAll(fd, out), let event, WAITS.contains(event) else { exit(0) }
    var buf = Bytes()
    var chunk = Bytes(repeating: 0, count: 1 << 16)
    while true {
        let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { exit(0) }
        let from = buf.count
        buf += chunk[..<n]
        guard let nl = buf[from...].firstIndex(of: 0x0A) else { continue }
        // the reply is in hand: stop racing the safety timer against a large write
        exitAfter(0)
        close(fd)
        if let context = Parser.parse(Array(buf[..<nl]))?["additionalContext"], context.truthy {
            var reply = Bytes()
            stringify(.object([(text("hookSpecificOutput"), .object([(text("hookEventName"), .string(event)), (text("additionalContext"), context)]))]), &reply)
            _ = writeAll(1, reply)
        }
        exit(0)
    }
}

func hook(home: Bytes, charId: Text, term: Bool, backend: String, pid: Double?) -> Never {
    exitAfter(1.5)
    let h = Parser.parse(readAll(0)) ?? .object([])
    // the script throws on a payload of null before it writes anything
    if case .null = h { exit(0) }
    let event = h["hook_event_name"]?.string
    let out = hookLine(h, charId: charId, term: term, backend: backend, pid: pid)
    let sock = join(home, "hooks.sock"), down = join(home, "hooks.down")
    // a daemon restarting has no socket for a second or two, so a refused connect is tried again, for up to 2 s;
    // a tool call is not, nor any event within a minute of one giving up
    var tries = 0
    while true {
        let (fd, error) = connectTo(sock)
        if fd >= 0 { talk(fd, out, event) }
        if tries >= RETRIES {
            let fd = cString(down) { open($0, O_WRONLY | O_CREAT | O_TRUNC, 0o666) }
            if fd >= 0 { close(fd) }
        }
        if tries >= RETRIES || event.map(ONCE.contains) == true || (error != ENOENT && error != ECONNREFUSED) || gaveUpLately(down) { exit(0) }
        exitAfter(1.5)
        // usleep oversleeps by about a quarter here; poll keeps to the 250 ms
        _ = poll(nil, 0, 250)
        tries += 1
    }
}

// MARK: claude-status.mjs

func statusLine(_ s: JSON, charId: Text, term: Bool) -> Bytes? {
    guard case .number(let pct)? = s["context_window"]?["used_percentage"] else { return nil }
    var status: [(key: Text, value: JSON)] = []
    if let id = s["session_id"]?.string { status.append((text("sessionId"), .string(id))) }
    status.append((text("contextPct"), .number(pct)))
    if let model = s["model"]?["id"]?.string { status.append((text("model"), .string(model))) }
    var out: [(key: Text, value: JSON)] = [(text("charId"), .string(charId))]
    if term { out.append((text("term"), .number(2))) }
    out.append((text("status"), .object(status)))
    return line(.object(out))
}

/// Spawns `/bin/sh -c command` reading from a pipe, as node's spawn with a shell does.
func spawnShell(_ command: UnsafeMutablePointer<CChar>) -> (pid: pid_t, stdin: Int32)? {
    var fds: [Int32] = [0, 0]
    guard pipe(&fds) == 0 else { return nil }
    for fd in fds { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    posix_spawn_file_actions_adddup2(&actions, fds[0], 0)
    posix_spawn_file_actions_addinherit_np(&actions, 1)
    posix_spawn_file_actions_addinherit_np(&actions, 2)
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    var all = sigset_t(), none = sigset_t()
    sigfillset(&all)
    sigemptyset(&none)
    posix_spawnattr_setsigdefault(&attr, &all)
    posix_spawnattr_setsigmask(&attr, &none)
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_CLOEXEC_DEFAULT))
    var pid: pid_t = 0
    let sh = strdup("/bin/sh"), c = strdup("-c")
    var argv: [UnsafeMutablePointer<CChar>?] = [sh, c, command, nil]
    let ok = posix_spawn(&pid, "/bin/sh", &actions, &attr, &argv, environ)
    close(fds[0])
    guard ok == 0 else { close(fds[1]); return nil }
    return (pid, fds[1])
}

func status(home: Bytes, report: Bool, charId: Text, term: Bool, command: UnsafeMutablePointer<CChar>?) -> Never {
    // stdin that never closes must not hold Claude Code's statusline pipe open
    exitAfter(5)
    let input = readAll(0)
    exitAfter(0)
    let wraps = command.map { $0[0] != 0 } ?? false
    let child = wraps ? spawnShell(command!) : nil
    if let child {
        _ = writeAll(child.stdin, input)
        close(child.stdin)
    }
    // a daemon that has stopped reading must not delay the statusline
    if report, let parsed = Parser.parse(input), let out = statusLine(parsed, charId: charId, term: term) {
        let (fd, _) = connectTo(join(home, "hooks.sock"))
        if fd >= 0 {
            _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
            _ = writeAll(fd, out, deadline: now() + 1.5)
            close(fd)
        }
    }
    guard wraps else { exit(0) }
    guard let child else { exit(1) }
    var st: Int32 = 0
    while waitpid(child.pid, &st, 0) < 0 && errno == EINTR {}
    // a command a signal ended passes on 0, as node reads its exit code as null
    exit(st & 0x7F == 0 ? (st >> 8) & 0xFF : 0)
}

// MARK: main

signal(SIGPIPE, SIG_IGN)
signal(SIGALRM) { _ in _exit(0) }

let argv = CommandLine.unsafeArgv
func arg(_ n: Int) -> UnsafeMutablePointer<CChar>? { n < Int(CommandLine.argc) ? argv[n] : nil }

var charId = Text()
decodeUTF8(env("SVALL_CHAR_ID")?[...] ?? [], &charId)
let term = env("SVALL_TERM") == Array("2".utf8)
let home = env("SVALL_HOME") ?? join(env("HOME") ?? getpwuid(getuid()).map { bytes($0.pointee.pw_dir) } ?? [], ".svall")
// the release's and Svall Dev's hooks both run for every agent, so each acts only for its own variant's homes.
// argv[0], as the shell passed it, keeps the name of a home that is a symlink
let mine = isRelease(dirname(dirname(resolve(arg(0).map { bytes($0) } ?? [])))) == isRelease(home)

if let mode = arg(1), bytes(mode) == Array("status".utf8) {
    status(home: home, report: !charId.isEmpty && mine, charId: charId, term: term, command: arg(2))
}
guard !charId.isEmpty && mine else { exit(0) }
let backend = arg(1).map { bytes($0) } == Array("codex".utf8) ? "codex" : "claude"
// the agent's pid, which the shell passes as $PPID
let pid: Double? = arg(2).flatMap { p in
    let b = bytes(p)
    return !b.isEmpty && b.allSatisfy({ (0x30...0x39).contains($0) }) ? strtod(p, nil) : nil
}
hook(home: home, charId: charId, term: term, backend: backend, pid: pid == 0 ? nil : pid)
