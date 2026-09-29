import AppKit
import UserNotifications

/// Posts the page's banners to Notification Center and carries clicks and answers back.
/// Every fleet runs its own instance of this app, so a response handed to another fleet's is passed on.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private static let blocked = "blocked"
    private static let forward = Notification.Name((Bundle.main.bundleIdentifier ?? "svall") + ".notice")
    private let center = UNUserNotificationCenter.current()
    private let home = SvallHome.path
    private var prefix: String { home + "#" }
    // what this process has up, so quitting can take it down without waiting on Notification Center's list
    private var posted = Set<String>()
    private var forwarded: NSObjectProtocol?

    var onPermission: (String) -> Void = { _ in }
    var onOpen: (String) -> Void = { _ in }
    // the question the banner showed goes back with its answer, so a stale one is refused; empty when it named none
    var onAction: (_ key: String, _ action: String, _ promptId: String) -> Void = { _, _, _ in }

    override init() {
        super.init()
        center.delegate = self
        let answers = [UNNotificationAction(identifier: "approve", title: "Approve", options: [.authenticationRequired]),
                       UNNotificationAction(identifier: "deny", title: "Deny", options: [.authenticationRequired])]
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.blocked, actions: answers, intentIdentifiers: [], options: [])])
        forwarded = DistributedNotificationCenter.default().addObserver(forName: Self.forward, object: home, queue: .main) { [weak self] note in
            guard let key = note.userInfo?["key"] as? String, let action = note.userInfo?["action"] as? String,
                  ["open", "approve", "deny"].contains(action) else { return }
            self?.deliver(key: key, action: action, promptId: note.userInfo?["promptId"] as? String ?? "")
        }
    }

    /// Tells the page what macOS allows.
    func refreshPermission() {
        center.getNotificationSettings { settings in
            let state: String
            switch settings.authorizationStatus {
            case .notDetermined: state = "unknown"
            case .denied: state = "denied"
            default: state = "granted"
            }
            DispatchQueue.main.async { self.onPermission(state) }
        }
    }

    func enable() {
        center.requestAuthorization(options: [.alert, .sound]) { _, error in
            if let error { NSLog("notifications: %@", "\(error)") }
            self.refreshPermission()
        }
    }

    func openSettings() {
        let id = Bundle.main.bundleIdentifier ?? ""
        guard let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)") else { return }
        NSWorkspace.shared.open(url)
    }

    // a key is a terminal surface key: a character's second terminal carries a -2 suffix
    private static func charId(_ key: String) -> String { key.hasSuffix("-2") ? String(key.dropLast(2)) : key }

    func post(key: String, title: String, subtitle: String, body: String, sound: Bool, actions: Bool, promptId: String?) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = [subtitle, SvallHome.fleetName ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
        content.body = body
        content.sound = sound ? .default : nil
        if actions { content.categoryIdentifier = Self.blocked }
        content.threadIdentifier = prefix + Self.charId(key)
        content.userInfo = ["home": home, "key": key, "promptId": promptId ?? ""]
        let id = prefix + key
        posted.insert(id)
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
            if let error { NSLog("notifications: %@", "\(error)") }
        }
    }

    func remove(key: String) {
        let id = prefix + key
        posted.remove(id)
        center.removePendingNotificationRequests(withIdentifiers: [id])
        center.removeDeliveredNotifications(withIdentifiers: [id])
    }

    /// Takes down this fleet's banners, including any an earlier process left behind.
    func clearAll() {
        center.removeDeliveredNotifications(withIdentifiers: Array(posted))
        posted.removeAll()
        let prefix = self.prefix
        center.getDeliveredNotifications { list in
            let ids = list.map(\.request.identifier).filter { $0.hasPrefix(prefix) }
            if !ids.isEmpty { self.center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    // the page already decided this banner belongs on screen, whether or not the app is in front
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }
        let info = response.notification.request.content.userInfo
        guard let owner = info["home"] as? String, let key = info["key"] as? String else { return }
        let promptId = info["promptId"] as? String ?? ""
        let action: String
        switch response.actionIdentifier {
        case "approve", "deny": action = response.actionIdentifier
        case UNNotificationDefaultActionIdentifier: action = "open"
        default: return
        }
        DispatchQueue.main.async {
            if owner == self.home { self.deliver(key: key, action: action, promptId: promptId); return }
            // another fleet's banner: its instance takes the click, and the front with it, once it's really that fleet's app
            if action == "open", let pid = SvallHome.appPid(of: owner), let app = NSRunningApplication(processIdentifier: pid),
               app.bundleIdentifier == Bundle.main.bundleIdentifier {
                NSApp.yieldActivation(to: app)
            }
            DistributedNotificationCenter.default().postNotificationName(Self.forward, object: owner, userInfo: ["key": key, "action": action, "promptId": promptId], deliverImmediately: true)
        }
    }

    private func deliver(key: String, action: String, promptId: String) {
        if action == "open" { onOpen(key) } else { onAction(key, action, promptId) }
    }
}
