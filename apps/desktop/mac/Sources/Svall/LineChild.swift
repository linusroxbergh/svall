import Foundation

/// A child process whose stdout is NDJSON. Its lines reach main in order, and its end only after the last of them.
final class LineChild {
    private let process = Process()
    private let output = Pipe()
    private let errors: Pipe?
    private let input: Pipe?
    private let lock = NSLock()
    private var buffer = LineBuffer()
    private var stderr = StderrTail()
    // the exit, and the end of each pipe read: a line read after the exit still comes before the end
    private let ended = DispatchGroup()

    var onLine: (String) -> Void = { _ in }
    /// The exit status and the last lines of stderr, on main after every line.
    var onExit: (Int32, [String]) -> Void = { _, _ in }

    /// `stdin` gives the child a pipe whose end asks it to stop; without `captureStderr` it writes to the app's own.
    init(executable: String, arguments: [String], stdin: Bool, captureStderr: Bool = true) {
        input = stdin ? Pipe() : nil
        errors = captureStderr ? Pipe() : nil
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardInput = input ?? FileHandle.nullDevice
        process.standardOutput = output
        if let errors { process.standardError = errors }
    }

    var isRunning: Bool { process.isRunning }

    func start() throws {
        ended.enter(); ended.enter()
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return handle.readabilityHandler = nil }
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                let rest = lock.withLock { self.buffer.end() }
                for line in rest { DispatchQueue.main.async { self.onLine(line) } }
                return ended.leave()
            }
            for line in lock.withLock({ self.buffer.take(data) }) { DispatchQueue.main.async { self.onLine(line) } }
        }
        if let errors {
            ended.enter()
            errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard let self else { return handle.readabilityHandler = nil }
                guard !data.isEmpty else {
                    handle.readabilityHandler = nil
                    lock.withLock { self.stderr.end() }
                    return ended.leave()
                }
                lock.withLock { self.stderr.take(data) }
            }
        }
        process.terminationHandler = { [weak self] _ in self?.ended.leave() }
        if let input {
            // a child that went away turns a write into EPIPE, not a signal that ends the app
            _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        }
        do { try process.run() } catch {
            output.fileHandleForReading.readabilityHandler = nil
            errors?.fileHandleForReading.readabilityHandler = nil
            throw error
        }
        ended.notify(queue: .main) { [weak self] in
            guard let self else { return }
            let said = lock.withLock { self.stderr.lines }
            onExit(process.terminationStatus, said)
        }
    }

    func write(_ line: String) {
        guard let input, process.isRunning else { return }
        try? input.fileHandleForWriting.write(contentsOf: Data((line + "\n").utf8))
    }

    /// Ends the child within a bound: a second after its stdin closes, when it has one, then SIGTERM, then after two
    /// more SIGKILL. Its end still reaches `onExit`.
    func stop() {
        if let input {
            try? input.fileHandleForWriting.close()
            if exits(within: 1) { return }
        }
        guard process.isRunning else { return }
        process.terminate()
        if !exits(within: 2) { kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
    }

    private func exits(within seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while process.isRunning, Date() < deadline { usleep(10_000) }
        return !process.isRunning
    }
}
