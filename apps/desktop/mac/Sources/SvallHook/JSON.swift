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
