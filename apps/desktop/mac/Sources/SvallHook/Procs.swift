import Darwin

// MARK: procs

private func decoded(_ b: ArraySlice<UInt8>) -> JSON {
    var t = Text()
    decodeUTF8(b, &t)
    return .string(t)
}

private let charPrefix = Array("SVALL_CHAR_ID=".utf8)
private let homePrefix = Array("SVALL_HOME=".utf8)

/// A process's argv joined by spaces, with the values of `SVALL_CHAR_ID` and `SVALL_HOME` from its environment.
private func argsAndMarks(_ pid: Int32, _ buf: inout Bytes) -> (args: ArraySlice<UInt8>, char: ArraySlice<UInt8>?, home: ArraySlice<UInt8>?)? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = buf.count
    guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > 4 else { return nil }
    let argc = buf.withUnsafeBytes { Int($0.load(as: Int32.self)) }
    var i = 4
    // the exec path comes first, padded with NULs
    while i < size && buf[i] != 0 { i += 1 }
    while i < size && buf[i] == 0 { i += 1 }
    var args = Bytes()
    // a buffer cut short ends the argv early
    for n in 0..<max(0, min(argc, size)) where i < size {
        let s = i
        while i < size && buf[i] != 0 { i += 1 }
        if n > 0 { args.append(0x20) }
        args += buf[s..<i]
        i += 1
    }
    var char: ArraySlice<UInt8>?, home: ArraySlice<UInt8>?
    while i < size && buf[i] != 0 {
        let s = i
        while i < size && buf[i] != 0 { i += 1 }
        let entry = buf[s..<i]
        if entry.starts(with: charPrefix) { char = entry.dropFirst(charPrefix.count) }
        if entry.starts(with: homePrefix) { home = entry.dropFirst(homePrefix.count) }
        i += 1
    }
    return (args[...], char, home)
}

private func find(_ hay: ArraySlice<UInt8>, _ needle: Bytes) -> Int? {
    guard hay.count >= needle.count else { return nil }
    return (hay.startIndex...(hay.endIndex - needle.count)).first { hay[$0..<($0 + needle.count)].elementsEqual(needle) }
}

private let appMark = Array(".app/".utf8)
private let frameworkMark = Array(".framework/".utf8)

/// Whether `path` lies in an app bundle; an app a framework bundles, as Python.framework's Python.app, is none.
private func isApp(_ path: ArraySlice<UInt8>) -> Bool {
    guard let app = find(path, appMark) else { return false }
    return find(path[..<app], frameworkMark) == nil
}

/// Prints `{"procs":[…]}`, one row per process of this user, for svalld to attribute load to robots.
func procs() -> Never {
    var timebase = mach_timebase_info_data_t()
    mach_timebase_info(&timebase)
    typealias Responsible = @convention(c) (Int32) -> Int32
    // the symbol is private; its absence only drops "resp"
    let responsible = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid")
        .map { unsafeBitCast($0, to: Responsible.self) }

    let capacity = Int(proc_listallpids(nil, 0)) + 64
    var pids = [Int32](repeating: 0, count: capacity)
    let count = Int(proc_listallpids(&pids, Int32(capacity * MemoryLayout<Int32>.size)))
    let uid = getuid()
    var argBuf = Bytes(repeating: 0, count: 1 << 20)
    var rows = [JSON]()
    for pid in pids.prefix(max(0, count)) where pid > 0 {
        var info = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size),
              info.pbi_uid == uid else { continue }
        var usage = rusage_info_v4()
        let ok = withUnsafeMutablePointer(to: &usage) {
            $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
        }
        if ok != 0 { usage = rusage_info_v4() }
        var path = Bytes(repeating: 0, count: 4096)
        let pathLen = max(0, Int(proc_pidpath(pid, &path, UInt32(path.count))))
        // svalld ignores the marks of apps and never reads their args, and reading them is the costliest step
        // a process whose arguments can't be read stays, so its descendants keep their place in the tree
        let marks = (isApp(path[..<pathLen]) ? nil : argsAndMarks(pid, &argBuf)) ?? (args: ArraySlice<UInt8>(), char: nil, home: nil)

        let ticks = Double(usage.ri_user_time &+ usage.ri_system_time)
        var row: [(key: Text, value: JSON)] = [
            (text("pid"), .number(Double(pid))),
            (text("ppid"), .number(Double(info.pbi_ppid))),
            (text("start"), .number(Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1e6)),
            (text("cpu"), .number((ticks * Double(timebase.numer) / Double(timebase.denom)).rounded())),
            (text("mem"), .number(Double(usage.ri_phys_footprint))),
        ]
        if let responsible { row.append((text("resp"), .number(Double(responsible(pid))))) }
        row.append((text("path"), decoded(path[..<pathLen])))
        row.append((text("args"), decoded(marks.args)))
        if let c = marks.char { row.append((text("char"), decoded(c))) }
        if let h = marks.home { row.append((text("home"), decoded(h))) }
        rows.append(.object(row))
    }
    _ = writeAll(1, line(.object([(text("procs"), .array(rows))])))
    exit(0)
}
