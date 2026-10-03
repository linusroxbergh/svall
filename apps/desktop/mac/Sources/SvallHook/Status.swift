import Darwin

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
    // a daemon that has stopped reading must not delay the statusline, nor a command that never reads its input the report
    if report, let parsed = Parser.parse(input), let out = statusLine(parsed, charId: charId, term: term) {
        let (fd, _) = connectTo(join(home, "hooks.sock"))
        if fd >= 0 {
            _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
            _ = writeAll(fd, out, deadline: now() + 1.5)
            close(fd)
        }
    }
    if let child {
        _ = writeAll(child.stdin, input)
        close(child.stdin)
    }
    guard wraps else { exit(0) }
    guard let child else { exit(1) }
    var st: Int32 = 0
    while waitpid(child.pid, &st, 0) < 0 && errno == EINTR {}
    // a command a signal ended passes on 0, as node reads its exit code as null
    exit(st & 0x7F == 0 ? (st >> 8) & 0xFF : 0)
}
