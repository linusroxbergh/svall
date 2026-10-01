import AppKit
import Sparkle

/// Sparkle's updater, in a build whose Info.plist names a feed (Svall Dev has none), run by the private fleet's window, or by
/// the fleet window it opened as it quit: every fleet's window is its own instance, and one updater per Mac is enough.
final class Updates: NSObject, SPUUpdaterDelegate {
    static let shared = Updates()
    static let handoff = "SVALL_UPDATER"
    private static let quitForUpdate = Notification.Name((Bundle.main.bundleIdentifier ?? "svall") + ".quit-for-update")
    private let me = String(ProcessInfo.processInfo.processIdentifier)
    private var controller: SPUStandardUpdaterController?

    private override init() {
        super.init()
        // the other fleets' windows run from the bundle an update replaces, so they quit before it is installed
        DistributedNotificationCenter.default().addObserver(forName: Self.quitForUpdate, object: nil, queue: .main) { [me] note in
            if note.object as? String != me { NSApp.terminate(nil) }
        }
        guard Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil,
              SvallHome.isPrivate || ProcessInfo.processInfo.environment[Self.handoff] != nil else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
    }

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        DistributedNotificationCenter.default().postNotificationName(Self.quitForUpdate, object: me, userInfo: nil, deliverImmediately: true)
    }

    var running: Bool { controller != nil }

    var menuItem: NSMenuItem? {
        guard let controller else { return nil }
        let item = NSMenuItem(title: "Check for Updates…", action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
        item.target = controller
        return item
    }
}
