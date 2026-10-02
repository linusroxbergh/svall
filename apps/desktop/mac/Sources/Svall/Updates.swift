import AppKit
import Sparkle

/// Sparkle's updater, in a build whose Info.plist names a feed (Svall Dev has none), run by the private fleet's window, or by
/// the fleet window it opened as it quit: every fleet's window is its own instance, and one updater per Mac is enough.
final class Updates: NSObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
    static let shared = Updates()
    static let handoff = "SVALL_UPDATER"
    private static let quitForUpdate = Notification.Name((Bundle.main.bundleIdentifier ?? "svall") + ".quit-for-update")
    private let me = String(ProcessInfo.processInfo.processIdentifier)
    private var controller: SPUStandardUpdaterController?
    // a scheduled check's find shows as this pill in the title bar rather than as Sparkle's window
    private var pill: UpdatePill?

    private override init() {
        super.init()
        // the other fleets' windows run from the bundle an update replaces, so they quit before it is installed
        DistributedNotificationCenter.default().addObserver(forName: Self.quitForUpdate, object: nil, queue: .main) { [me] note in
            if note.object as? String != me { NSApp.terminateQuietly() }
        }
        guard Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil,
              SvallHome.isPrivate || ProcessInfo.processInfo.environment[Self.handoff] != nil else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: self)
    }

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        // Sparkle quits this window to install, after the user chose to
        NSApplication.quietQuit = true
        DistributedNotificationCenter.default().postNotificationName(Self.quitForUpdate, object: me, userInfo: nil, deliverImmediately: true)
    }

    var running: Bool { controller != nil }

    var menuItem: NSMenuItem? {
        guard let controller else { return nil }
        let item = NSMenuItem(title: "Check for Updates…", action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
        item.target = controller
        return item
    }

    /// Puts the pill in the window's title bar; a click brings up Sparkle's window for the update it stands for.
    func attach(to window: NSWindow) {
        guard let controller else { return }
        let pill = UpdatePill(target: controller, action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)))
        window.addTitlebarAccessoryViewController(pill)
        self.pill = pill
    }

    var supportsGentleScheduledUpdateReminders: Bool { true }

    func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool) -> Bool { false }

    func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
        guard !handleShowingUpdate else { return }
        pill?.show(version: update.displayVersionString)
    }

    func standardUserDriverDidReceiveUserAttention(forUpdate update: SUAppcastItem) { pill?.isHidden = true }

    func standardUserDriverWillFinishUpdateSession() { pill?.isHidden = true }
}
