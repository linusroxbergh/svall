import AppKit
import WebKit

/// Cookies imported from Chrome and logins filled from 1Password.
extension BrowserManager {
    func importChromeCookies() {
        let profiles = ChromeCookies.profiles()
        guard !profiles.isEmpty else { return NSAlert.tell("No Chrome profile found", "Chrome keeps its profiles in ~/Library/Application Support/Google/Chrome.") }
        let ask = NSAlert()
        ask.messageText = "Import cookies from Chrome"
        let purge = AppRuntime.cli == nil ? "‘svall-dev uninstall --purge’" : "Svall → Uninstall Svall… with “Also delete fleet data”"
        ask.informativeText = "This copies the profile’s cookies, so the browser is signed in wherever the profile is. macOS asks for the “Chrome Safe Storage” key to decrypt them. They are kept in this fleet’s browser data under ~/Library, where any program you run, the fleet’s agents included, can read them. \(purge) removes them again."
        let pick = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 260, height: 26))
        for p in profiles { pick.menu?.addItem(withTitle: p.name, action: nil, keyEquivalent: "") }
        ask.accessoryView = pick
        ask.addButton(withTitle: "Import"); ask.addButton(withTitle: "Cancel")
        guard ask.runModal() == .alertFirstButtonReturn else { return }
        let profile = profiles[pick.indexOfSelectedItem]

        work({ try ChromeCookies.read(profile: profile, key: try ChromeCookies.key()) }, "Nothing was imported") { [weak self] haul in
            guard let self else { return }
            let group = DispatchGroup()
            for cookie in haul.cookies {
                group.enter()
                self.store.httpCookieStore.setCookie(cookie) { group.leave() }
            }
            group.notify(queue: .main) {
                // all of them stuck means the key does not belong to this profile, which a bare zero would hide
                let stuck = haul.stuck > 0 ? " \(haul.stuck) could not be decrypted." : ""
                let cut = haul.cut.map { " Chrome’s cookie file could not be read to the end (\($0)); quit Chrome and import again for the rest." } ?? ""
                // WebKit keeps a cookie without an expiry date in memory only, so it goes when the app quits
                let session = haul.cookies.filter(\.isSessionOnly).count
                let lasting = session > 0 ? " \(session) of them are session cookies, which last until Svall quits." : ""
                NSAlert.tell("Imported \(haul.cookies.count) cookies from \(profile.name)\(haul.cut == nil ? "" : ", not all of them")",
                          "Reload an open tab for it to pick them up.\(stuck)\(cut)\(lasting)")
            }
        }
    }

    // MARK: logins from 1Password

    // http is a secure enough context for a login only when nothing leaves the machine
    private static let loopback = ["localhost", "127.0.0.1", "::1"]

    func fillLogin(tab: String) {
        guard let v = overlay[tab], let url = v.url, let host = url.host, let origin = OnePassword.origin(url) else {
            return NSAlert.tell("Nothing to fill", "This tab is not on a page yet.")
        }
        // a password typed into an http page travels in the clear, and an exact match would fill it unasked
        guard url.scheme == "https" || Self.loopback.contains(host) else {
            return NSAlert.tell("Not filling on an insecure page", "\(host) is served over plain http, so anything filled in would travel unencrypted.")
        }
        work({ try OnePassword.logins(for: host) }, "1Password did not answer") { [weak self] logins in
            guard let self, let login = self.choose(logins, for: host) else { return }
            self.work({ try OnePassword.secret(login) }, "1Password did not answer") { [weak self] secret in
                // the unlock can outlast the page: a closed tab is let go, and one that moved to another origin is not filled
                guard let self, let v = self.overlay[tab] else { return }
                guard v.url.flatMap(OnePassword.origin) == origin else {
                    return NSAlert.tell("Nothing was filled", "The tab left \(origin) while 1Password was asking.")
                }
                let args: [String: Any] = ["pageOrigin": origin, "username": secret.username ?? "", "password": secret.password ?? "", "otp": secret.otp ?? ""]
                v.callAsyncJavaScript(OnePassword.fill, arguments: args, in: nil, in: .defaultClient) { result in
                    switch result {
                    case .success(let what) where what as? String == "none":
                        NSAlert.tell("Nothing to fill", "\(host) shows no sign-in field that \(login.title) can fill.")
                    case .success(let what) where what as? String == "moved":
                        NSAlert.tell("Nothing was filled", "The tab left \(origin) while 1Password was asking.")
                    case .failure(let error):
                        NSAlert.tell("Nothing was filled", "\(error)")
                    default: break
                    }
                }
            }
        }
    }

    // op and the keychain both block their thread while the user is asked
    private func work<T>(_ job: @escaping () throws -> T, _ failure: String, then: @escaping (T) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try job() }
            DispatchQueue.main.async {
                switch result {
                case .success(let value): then(value)
                case .failure(let error): NSAlert.tell(failure, "\(error)")
                }
            }
        }
    }

    // one login saved for exactly this host fills unasked; a looser match is confirmed by eye
    private func choose(_ logins: [OnePassword.Login], for host: String) -> OnePassword.Login? {
        guard let first = logins.first else { NSAlert.tell("No login for \(host)", "1Password has no Login item with a website on this domain."); return nil }
        if logins.count == 1, OnePassword.exact(first, host) { return first }
        let ask = NSAlert()
        ask.messageText = "Fill a login on \(host)"
        let pick = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 320, height: 26))
        // two logins may share a title and a username, and addItems(withTitles:) folds equal titles into one
        for l in logins {
            var label = l.username.isEmpty ? l.title : "\(l.title) · \(l.username)"
            if let saved = OnePassword.savedFor(l, host) { label += " (saved for \(saved))" }
            pick.menu?.addItem(withTitle: label, action: nil, keyEquivalent: "")
        }
        ask.accessoryView = pick
        ask.addButton(withTitle: "Fill"); ask.addButton(withTitle: "Cancel")
        return ask.runModal() == .alertFirstButtonReturn ? logins[pick.indexOfSelectedItem] : nil
    }
}
