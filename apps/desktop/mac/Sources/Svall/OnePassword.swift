import Foundation

/// Logins from the 1Password CLI, which unlocks through the 1Password app.
enum OnePassword {
    struct Login { let id, account, title, username: String; let hosts: [String] }
    struct Secret { let username, password, otp: String? }

    static let path = ["/opt/homebrew/bin/op", "/usr/local/bin/op"].first { FileManager.default.isExecutableFile(atPath: $0) }

    private static func run(_ args: [String]) throws -> Data {
        guard let path else { throw ShellError("the 1Password CLI is not installed") }
        let p = Process(), out = Pipe(), err = Pipe()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args + ["--format", "json"]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = out
        p.standardError = err
        try p.run()
        // a stderr larger than its pipe would wedge op while stdout is being read, so both are drained at once
        var complaint = Data()
        let draining = DispatchGroup()
        DispatchQueue.global(qos: .userInitiated).async(group: draining) { complaint = err.fileHandleForReading.readDataToEndOfFile() }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        draining.wait()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            let said = String(decoding: complaint, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw ShellError(said.isEmpty ? "op \(args.first ?? "") exited with \(p.terminationStatus)" : said)
        }
        return data
    }

    private static func bare(_ host: String) -> String {
        let h = host.lowercased()
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }

    // accounts.google.com and google.com are one login; a lone label like "com" matches nothing
    static func matches(_ item: String, _ page: String) -> Bool {
        let a = bare(item), b = bare(page)
        if a == b { return true }
        let (short, long) = a.count < b.count ? (a, b) : (b, a)
        return short.contains(".") && long.hasSuffix("." + short)
    }

    // scheme, host and port, spelled as the page's location.origin spells them
    static func origin(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        return "\(scheme)://\(host.contains(":") ? "[\(host)]" : host)" + (url.port.map { ":\($0)" } ?? "")
    }

    static func exact(_ login: Login, _ page: String) -> Bool { login.hosts.contains { bare($0) == bare(page) } }

    // the host an item was saved for, when that is not the page itself: what makes a parent-domain match visible
    static func savedFor(_ login: Login, _ page: String) -> String? {
        exact(login, page) ? nil : login.hosts.first { matches($0, page) }
    }

    static func logins(for host: String) throws -> [Login] {
        let accounts = try JSONSerialization.jsonObject(with: run(["account", "list"])) as? [[String: Any]] ?? []
        guard !accounts.isEmpty else { throw ShellError("1Password has no account for its CLI: turn on “Integrate with 1Password CLI” in 1Password’s Developer settings") }
        // an account that is locked or signed out is passed over, so the others still answer
        return accounts.compactMap { $0["user_uuid"] as? String }.flatMap { account -> [Login] in
            let listed = try? run(["item", "list", "--categories", "Login", "--account", account])
            let items = listed.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]] ?? []
            return items.compactMap { item -> Login? in
                let hosts = (item["urls"] as? [[String: Any]] ?? []).compactMap { url -> String? in
                    guard let href = url["href"] as? String else { return nil }
                    return URL(string: href)?.host ?? URL(string: "https://" + href)?.host
                }
                guard let id = item["id"] as? String, hosts.contains(where: { matches($0, host) }) else { return nil }
                return Login(id: id, account: account, title: item["title"] as? String ?? "", username: item["additional_information"] as? String ?? "", hosts: hosts)
            }
        }
    }

    static func secret(_ login: Login) throws -> Secret {
        let item = try JSONSerialization.jsonObject(with: run(["item", "get", login.id, "--account", login.account, "--reveal"])) as? [String: Any]
        let fields = item?["fields"] as? [[String: Any]] ?? []
        let value = { (purpose: String) in fields.first { $0["purpose"] as? String == purpose }?["value"] as? String }
        return Secret(username: value("USERNAME"), password: value("PASSWORD"),
                      otp: fields.first { $0["type"] as? String == "OTP" }?["totp"] as? String)
    }

    // runs apart from the page's own scripts; React only notices a value set through the native setter and an input event
    static let fill = """
        // the page can navigate while 1Password is asking, so the origin is checked where the writing happens
        if (location.origin !== pageOrigin) return 'moved';
        // a field hidden or parked off-screen is a hint to a password manager, not a field to fill
        const visible = (e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0
            && e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !e.disabled && !e.readOnly;
        };
        const put = (e, v) => {
          e.focus();
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, v);
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const inputs = [...document.querySelectorAll('input')].filter(visible);
        const texty = (e) => ['text', 'email', 'tel'].includes(e.type);
        const named = (e, re) => re.test(`${e.autocomplete} ${e.name} ${e.id}`);
        const pass = inputs.find((e) => e.type === 'password');
        if (pass && password) {
          const user = inputs.slice(0, inputs.indexOf(pass)).filter(texty).pop();
          if (user && username) put(user, username);
          put(pass, password);
          return 'password';
        }
        const code = inputs.find((e) => named(e, /one-time-code|otp|totp|2fa|verif/i));
        if (code && otp) { put(code, otp); return 'code'; }
        const user = inputs.find((e) => e.type === 'email' || (texty(e) && named(e, /user|email|login|identifier/i)));
        if (user && username) { put(user, username); return 'username'; }
        return 'none';
        """
}
