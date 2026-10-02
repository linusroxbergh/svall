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
    /// The version a scheduled check found, until the user has looked at it in Sparkle's window or the session ended.
    private(set) var waiting: String? { didSet { onWaiting?(waiting) } }
    var onWaiting: ((String?) -> Void)?

    private override init() {
        super.init()
        // the other fleets' windows run from the bundle an update replaces, so they quit before it is installed.
        // anything local can post this, so the pid it names must be another running Svall's
        DistributedNotificationCenter.default().addObserver(forName: Self.quitForUpdate, object: nil, queue: .main) { [me] note in
            guard let from = note.object as? String, from != me, let pid = pid_t(from),
                  NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == Bundle.main.bundleIdentifier else { return }
            NSApp.terminateQuietly()
        }
        guard Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil,
              SvallHome.isPrivate || ProcessInfo.processInfo.environment[Self.handoff] != nil else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: self)
        // an update found before a relaunch shows again now rather than at the next daily check
        if let updater = controller?.updater, updater.automaticallyChecksForUpdates { updater.checkForUpdatesInBackground() }
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

    /// Brings up Sparkle's window for the update `waiting` names.
    func install() { controller?.checkForUpdates(nil) }

    var supportsGentleScheduledUpdateReminders: Bool { true }

    func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool) -> Bool { false }

    func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
        guard !handleShowingUpdate else { return }
        waiting = update.displayVersionString
    }

    func standardUserDriverDidReceiveUserAttention(forUpdate update: SUAppcastItem) { waiting = nil }

    func standardUserDriverWillFinishUpdateSession() { waiting = nil }
}
