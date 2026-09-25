import AppKit
import GhosttyKit

if let resources = Bundle.main.resourcePath.map({ $0 + "/ghostty" }), FileManager.default.fileExists(atPath: resources) {
    setenv("GHOSTTY_RESOURCES_DIR", resources, 1)
}
guard ghostty_init(UInt(CommandLine.argc), CommandLine.unsafeArgv) == GHOSTTY_SUCCESS else {
    fatalError("ghostty_init failed")
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
