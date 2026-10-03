import AppKit
import GhosttyKit

if let resources = Bundle.main.resourcePath.map({ $0 + "/ghostty" }), FileManager.default.fileExists(atPath: resources) {
    setenv("GHOSTTY_RESOURCES_DIR", resources, 1)
}
// an alert and a clean exit rather than a crash report, which would tell the user nothing
guard ghostty_init(UInt(CommandLine.argc), CommandLine.unsafeArgv) == GHOSTTY_SUCCESS else {
    NSApplication.shared.setActivationPolicy(.regular)
    NSAlert.tell("The terminal could not start", "Ghostty failed to initialise, so Svall cannot open.")
    exit(1)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
