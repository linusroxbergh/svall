import Darwin

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
