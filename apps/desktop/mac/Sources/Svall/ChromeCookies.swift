import CommonCrypto
import CryptoKit
import Foundation
import Security
import SQLite3

/// Reads a Chrome profile's cookies, for a one-time copy into the fleet's browser store.
enum ChromeCookies {
    struct Profile { let dir: String, name: String }

    private static let root = NSHomeDirectory() + "/Library/Application Support/Google/Chrome"

    // Local State names every profile; a directory without a cookie file has nothing to give
    static func profiles() -> [Profile] {
        guard let data = FileManager.default.contents(atPath: root + "/Local State"),
              let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cache = (state["profile"] as? [String: Any])?["info_cache"] as? [String: Any] else { return [] }
        return cache.keys.sorted()
            .filter { FileManager.default.fileExists(atPath: "\(root)/\($0)/Cookies") }
            .map { Profile(dir: $0, name: ((cache[$0] as? [String: Any])?["name"] as? String) ?? $0) }
    }

    // macOS asks the user before handing over Chrome's key, so this blocks until they answer
    static func key() throws -> [UInt8] {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "Chrome Safe Storage",
                                      kSecAttrAccount: "Chrome", kSecReturnData: true]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        guard status == errSecSuccess, let password = out as? Data else {
            throw ShellError(status == errSecUserCanceled || status == errSecAuthFailed
                ? "access to Chrome Safe Storage was denied" : "Chrome Safe Storage is not in the keychain (\(status))")
        }
        return derive(password: password)
    }

    private static func derive(password: Data) -> [UInt8] {
        var key = [UInt8](repeating: 0, count: 16)
        let salt = Array("saltysalt".utf8)
        password.withUnsafeBytes { p in
            _ = CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), p.bindMemory(to: Int8.self).baseAddress, password.count,
                                     salt, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), 1003, &key, key.count)
        }
        return key
    }

    // "v10" + AES-128-CBC under sixteen spaces; newer profiles lead the plaintext with the host's SHA-256
    private static func decrypt(_ blob: Data, host: String, key: [UInt8]) -> String? {
        guard blob.count > 3, blob.prefix(3) == Data("v10".utf8) else { return nil }
        let body = [UInt8](blob.dropFirst(3))
        let iv = [UInt8](repeating: 0x20, count: 16)
        var plain = [UInt8](repeating: 0, count: body.count + 16)
        var length = 0
        let status = CCCrypt(CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                             key, key.count, iv, body, body.count, &plain, plain.count, &length)
        guard status == kCCSuccess else { return nil }
        var value = Data(plain.prefix(length))
        if value.count >= 32, value.prefix(32) == Data(SHA256.hash(data: Data(host.utf8))) { value = value.dropFirst(32) }
        return String(data: value, encoding: .utf8)
    }

    // the file is opened immutable, so a running Chrome neither blocks the read nor sees it; cut says why a read
    // stopped before the last row
    static func read(profile: Profile, key: [UInt8]) throws -> (cookies: [HTTPCookie], stuck: Int, cut: String?) {
        let uri = URL(fileURLWithPath: "\(root)/\(profile.dir)/Cookies").absoluteString + "?mode=ro&immutable=1"
        var db: OpaquePointer?
        guard sqlite3_open_v2(uri, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK else {
            sqlite3_close(db)
            throw ShellError("cannot open Chrome's cookies for \(profile.name)")
        }
        defer { sqlite3_close(db) }
        // a partitioned cookie belongs to one embedding site, which HTTPCookie cannot say
        let sql = """
            SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, has_expires, samesite
            FROM cookies WHERE top_frame_site_key = ''
            """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw ShellError("Chrome's cookie file is in a format this build cannot read")
        }
        defer { sqlite3_finalize(stmt) }

        let text = { (i: Int32) in sqlite3_column_text(stmt, i).map { String(cString: $0) } ?? "" }
        var cookies: [HTTPCookie] = []
        var stuck = 0
        var step = sqlite3_step(stmt)
        while step == SQLITE_ROW {
            defer { step = sqlite3_step(stmt) }
            let host = text(0)
            var value = text(2)
            let size = Int(sqlite3_column_bytes(stmt, 3))
            if size > 0, let bytes = sqlite3_column_blob(stmt, 3) {
                // a value this build cannot read is counted, so a wrong key does not pass for an empty profile
                guard let v = decrypt(Data(bytes: bytes, count: size), host: host, key: key) else { stuck += 1; continue }
                value = v
            }
            var props: [HTTPCookiePropertyKey: Any] = [.domain: host, .name: text(1), .value: value, .path: text(4)]
            if sqlite3_column_int(stmt, 8) != 0 {
                // Chrome counts microseconds from 1601
                let expires = Date(timeIntervalSince1970: Double(sqlite3_column_int64(stmt, 5)) / 1e6 - 11_644_473_600)
                if expires < Date() { continue }
                props[.expires] = expires
            }
            if sqlite3_column_int(stmt, 6) != 0 { props[.secure] = "TRUE" }
            if sqlite3_column_int(stmt, 7) != 0 { props[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
            switch sqlite3_column_int(stmt, 9) {
            case 1: props[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteLax.rawValue
            case 2: props[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict.rawValue
            default: break
            }
            if let cookie = HTTPCookie(properties: props) { cookies.append(cookie) }
        }
        return (cookies, stuck, step == SQLITE_DONE ? nil : String(cString: sqlite3_errmsg(db)))
    }
}
