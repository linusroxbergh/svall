import Foundation
import IOKit.ps
import IOKit.pwr_mgt
import notify

/// Holds off the Mac's idle sleep while the page asks, named so pmset and Activity Monitor say why. The screen still dims and
/// locks, and a closed lid still sleeps; the kernel drops the hold however the app ends.
final class KeepAwake {
    private var id = IOPMAssertionID(kIOPMNullAssertionID)
    private var token: Int32 = 0

    /// Holds under `reason`, renaming a hold already up; nil lets go.
    func hold(_ reason: String?) {
        guard let reason else { return release() }
        // pmset garbles the middle dot the window title puts before a fleet's name
        let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "Svall"
        let name = "\(app)\(SvallHome.fleetName.map { " (\($0))" } ?? ""): \(reason)" as CFString
        if id != kIOPMNullAssertionID {
            IOPMAssertionSetProperty(id, kIOPMAssertionNameKey as CFString, name)
        } else if IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                                              IOPMAssertionLevel(kIOPMAssertionLevelOn), name, &id) != kIOReturnSuccess {
            NSLog("keep awake: no hold for %@", reason)
            id = IOPMAssertionID(kIOPMNullAssertionID)
        }
    }

    func release() {
        guard id != kIOPMNullAssertionID else { return }
        IOPMAssertionRelease(id)
        id = IOPMAssertionID(kIOPMNullAssertionID)
    }

    // a Mac with no battery draws from AC
    static var onBattery: Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return false }
        return type as String != kIOPMACPowerKey
    }

    /// Calls `changed` on main each time the Mac moves between AC and battery.
    func watchPower(_ changed: @escaping (Bool) -> Void) {
        notify_register_dispatch(kIOPSNotifyPowerSource, &token, .main) { _ in changed(Self.onBattery) }
    }
}
