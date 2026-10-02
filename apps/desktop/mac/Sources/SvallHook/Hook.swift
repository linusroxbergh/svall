import Darwin

// MARK: agent-hook.mjs

let KEEP = ["hook_event_name", "agent_id", "session_id", "transcript_path", "notification_type", "message", "background_tasks", "cwd", "model", "prompt", "prompt_id", "turn_id", "tool_name"]
let WAITS = [text("SessionStart"), text("UserPromptSubmit")]
let ONCE = [text("PreToolUse"), text("PostToolUse"), text("PostToolUseFailure")]
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
