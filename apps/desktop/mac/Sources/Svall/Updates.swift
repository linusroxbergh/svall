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
    /// The version the last probe of the feed found, until the user has looked at it in Sparkle's window.
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
        // Sparkle's own scheduled checks are off (SUEnableAutomaticChecks): one that finds an update holds it until the user acts,
        // so a later release never replaces it. A probe ends with its answer, and runs every SUScheduledCheckInterval
        guard let updater = controller?.updater else { return }
        probe()
        RunLoop.main.add(Timer(timeInterval: updater.updateCheckInterval, repeats: true) { [weak self] _ in self?.probe() }, forMode: .common)
    }

    private func probe() {
        guard let updater = controller?.updater, !updater.sessionInProgress else { return }
        updater.checkForUpdateInformation()
    }

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) { waiting = item.displayVersionString }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater) { waiting = nil }

    // Sparkle's agent relaunches whichever copy of the bundle LaunchServices finds running, so the install waits until the
    // other fleets' windows have quit; past a minute (a window asking about unsaved changes) it goes ahead anyway
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        guard !others.isEmpty else { return false }
        DistributedNotificationCenter.default().postNotificationName(Self.quitForUpdate, object: me, userInfo: nil, deliverImmediately: true)
        let deadline = Date().addingTimeInterval(60)
        let timer = Timer(timeInterval: 0.2, repeats: true) { [self] timer in
            guard others.isEmpty || Date() > deadline else { return }
            timer.invalidate()
            installHandler()
        }
        RunLoop.main.add(timer, forMode: .common)
        return true
    }

    private var others: [NSRunningApplication] {
        NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "").filter { $0.processIdentifier != getpid() }
    }

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        // Sparkle quits this window to install, after the user chose to
        NSApplication.quietQuit = true
    }

    var running: Bool { controller != nil }

    var menuItem: NSMenuItem? {
        guard let controller else { return nil }
        let item = NSMenuItem(title: "Check for Updates…", action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
        item.target = controller
        return item
    }

    /// Checks the feed again and brings up Sparkle's window for the newest version.
    func install() { controller?.checkForUpdates(nil) }

    func standardUserDriverDidReceiveUserAttention(forUpdate update: SUAppcastItem) { waiting = nil }
}
