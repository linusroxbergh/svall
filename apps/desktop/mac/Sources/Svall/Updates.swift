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
    // the router's quit, which leaves a quit already under way to finish
    var onQuit: () -> Void = { NSApp.terminateQuietly() }

    private override init() {
        super.init()
        // the other fleets' windows run from the bundle an update replaces, so they quit before it is installed.
        // anything local can post this, so the pid it names must be another running Svall's
        DistributedNotificationCenter.default().addObserver(forName: Self.quitForUpdate, object: nil, queue: .main) { [weak self, me] note in
            guard let from = note.object as? String, from != me, let pid = pid_t(from),
                  NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == Bundle.main.bundleIdentifier else { return }
            self?.onQuit()
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

    // an update can change the protocol, leaving a fleet another machine runs out of this Mac's reach until that machine runs the
    // same release, and the appcast does not say whether it does, so the first check the user asks for meanwhile shows why instead;
    // the banner's probe runs on
    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        guard updateCheck != .updateInformation, let notice = holdBack() else { return }
        throw NSError(domain: "Svall", code: 1, userInfo: [NSLocalizedDescriptionKey: notice])
    }

    private var heldBack = false

    /// The notice for the first update asked for while another machine runs a fleet of this Mac; nil once shown, so asking again installs it.
    func holdBack(_ deferral: () -> String? = { Updates.deferral() }) -> String? {
        guard !heldBack, let notice = deferral() else { return nil }
        heldBack = true
        return notice
    }

    /// Why an update waits: a fleet home here whose fleet.json names a gateway and whose owner.json names another machine
    /// than this one, read from files alone; nil while this Mac runs every fleet it has.
    static func deferral(homeDirectory: String = NSHomeDirectory(), configDir: String = SvallHome.configDir) -> String? {
        guard let me = SvallHome.machineId(in: configDir) else { return nil }
        for name in ((try? FileManager.default.contentsOfDirectory(atPath: homeDirectory)) ?? []).sorted() {
            let home = homeDirectory + "/" + name
            // the profiles svall names fleets by, which leave out Svall Dev's
            guard let profile = SvallHome.fleetProfile(of: home, in: homeDirectory),
                  profile.range(of: #"^(?!dev(-|$))[a-z][a-z0-9-]*$"#, options: .regularExpression) != nil,
                  let fleet = readJSON(home + "/fleet.json"), fleet["gatewayMachineId"] is String,
                  let owner = readJSON(home + "/owner.json")?["ownerMachineId"] as? String, owner != me else { continue }
            let machine = SvallHome.machineName(owner, in: configDir) ?? owner
            let named = (fleet["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? profile
            let svall = profile == "private" ? "svall" : "svall -p \(profile)"
            return "\(named) runs on \(machine), which an update that changes Svall's protocol leaves out of reach until svall host upgrade \(machine); \(svall) handover local brings it back first, and Check for Updates again installs it now"
        }
        return nil
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

    /// The notes hold a heading per release, newest first; the dialog shows the releases above the installed version.
    func standardUserDriverWillShowReleaseNotesText(_ notes: NSAttributedString, forUpdate update: SUAppcastItem, withBundleDisplayVersion installed: String, bundleVersion: String) -> NSAttributedString? {
        let text = notes.string as NSString
        var end = 0
        text.enumerateSubstrings(in: NSRange(location: 0, length: text.length), options: .byLines) { line, range, _, stop in
            guard let line, line.range(of: #"^\d+(\.\d+)+$"#, options: .regularExpression) != nil,
                  SUStandardVersionComparator.default.compareVersion(installed, toVersion: line) != .orderedAscending else { return }
            end = range.location
            stop.pointee = true
        }
        // a heading starts its own line, after the newline that ends the release above it
        return end > 0 ? notes.attributedSubstring(from: NSRange(location: 0, length: end - 1)) : nil
    }
}
