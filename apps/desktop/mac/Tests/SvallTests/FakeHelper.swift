import XCTest

extension XCTestCase {
    /// A new directory in the temporary one, removed when the test ends.
    func temporaryDirectory(_ prefix: String) throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("\(prefix)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    /// A stand-in for the bundled svall: it prints the given NDJSON lines, then runs `tail`.
    func fakeHelper(prints lines: [String], then tail: String = "exec cat > /dev/null") throws -> String {
        let dir = try temporaryDirectory("svall-helper")
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
