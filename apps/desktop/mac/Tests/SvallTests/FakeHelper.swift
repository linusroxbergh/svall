import XCTest

/// A stand-in for the bundled `svall connect --json`: it prints the given NDJSON lines and, like the
/// real helper, stays alive until its stdin reaches EOF.
extension XCTestCase {
    func fakeHelper(prints lines: [String], then tail: String = "exec cat > /dev/null") throws -> String {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("svall-helper-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let script = (["#!/bin/sh"] + lines.map { "printf '%s\\n' '\($0)'" } + [tail]).joined(separator: "\n") + "\n"
        let path = dir.appendingPathComponent("svall").path
        try script.write(toFile: path, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
        return path
    }
}

/// Kills whatever still runs a fake helper's script, as a test that made one hold SIGTERM off leaves it.
func pkill(_ script: String) {
    let kill = Process()
    kill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
    kill.arguments = ["-9", "-f", script]
    try? kill.run()
    kill.waitUntilExit()
}

/// Whether any process still runs a fake helper's script.
func running(_ script: String) -> Bool {
    let find = Process()
    find.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    find.arguments = ["-f", script]
    find.standardOutput = FileHandle.nullDevice
    try? find.run()
    find.waitUntilExit()
    return find.terminationStatus == 0
}
