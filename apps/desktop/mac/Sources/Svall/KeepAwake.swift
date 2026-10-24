import Foundation
import IOKit.ps
import IOKit.pwr_mgt
import notify

/// Holds off the Mac's idle sleep while the page asks, on AC unless it asks for battery too, named so pmset and Activity Monitor say why.
/// The screen still dims and locks, and a closed lid still sleeps; the kernel drops the hold however the app ends.
final class KeepAwake {
    private var id = IOPMAssertionID(kIOPMNullAssertionID)
    // what the page last asked to hold for, kept across a spell on battery, and whether it holds there too
    private var reason: String?
    private var battery = false

    init() {
        var token: Int32 = 0
        notify_register_dispatch(kIOPSNotifyPowerSource, &token, .main) { [weak self] _ in self?.apply() }
    }

    /// Holds under `reason`, renaming a hold already up, and on battery too when `battery`; nil lets go.
    func hold(_ reason: String?, battery: Bool = false) {
        self.reason = reason
        self.battery = battery
        apply()
    }

    /// Whether a hold is up for what the page asked, on the power source the Mac draws from.
    static func holds(reason: String?, battery: Bool, onBattery: Bool) -> Bool {
        reason != nil && (battery || !onBattery)
    }

    func release() {
        hold(nil)
    }

    /// Takes, renames or lets go of the hold to match the reason asked, the power source and the fleet's name.
    func apply() {
        guard let reason, Self.holds(reason: reason, battery: battery, onBattery: Self.onBattery) else {
            if id != kIOPMNullAssertionID { IOPMAssertionRelease(id) }
            id = IOPMAssertionID(kIOPMNullAssertionID)
            return
        }
        // pmset garbles the middle dot the window title puts before a fleet's name
        let name = "\(SvallHome.appName)\(SvallHome.fleetName.map { " (\($0))" } ?? ""): \(reason)" as CFString
        if id != kIOPMNullAssertionID {
            IOPMAssertionSetProperty(id, kIOPMAssertionNameKey as CFString, name)
        } else if IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                                              IOPMAssertionLevel(kIOPMAssertionLevelOn), name, &id) != kIOReturnSuccess {
            NSLog("keep awake: no hold for %@", reason)
            id = IOPMAssertionID(kIOPMNullAssertionID)
        }
    }

    // a Mac with no battery draws from AC
    private static var onBattery: Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return false }
        return type as String != kIOPMACPowerKey
    }
}
