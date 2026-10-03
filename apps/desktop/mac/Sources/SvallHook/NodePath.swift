import Darwin

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
