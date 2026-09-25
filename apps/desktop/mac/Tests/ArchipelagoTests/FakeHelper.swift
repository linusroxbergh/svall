import XCTest

/// A stand-in for the bundled `archi connect --json`: it prints the given NDJSON lines and, like the
/// real helper, stays alive until its stdin reaches EOF.
extension XCTestCase {
    func fakeHelper(prints lines: [String], then tail: String = "exec cat > /dev/null") throws -> String {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("archi-helper-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let script = (["#!/bin/sh"] + lines.map { "printf '%s\\n' '\($0)'" } + [tail]).joined(separator: "\n") + "\n"
        let path = dir.appendingPathComponent("archi").path
        try script.write(toFile: path, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
        return path
    }
}
