// Stands in for agent-hook.mjs and claude-status.mjs, beside them in a fleet's hooks folder, without starting node:
//   svall-hook claude|codex <pid>    a Claude Code or Codex hook
//   svall-hook status [<command>]    the statusline wrapper
// The daemon gets the scripts' lines byte for byte, so JSON is read and written as JSON.parse and JSON.stringify do.
import Darwin

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
