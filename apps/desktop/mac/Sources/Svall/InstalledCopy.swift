import AppKit

/// The copy dragged to Applications, which an app opened from its disk image (or from wherever macOS moved it to run it)
/// opens in its place.
enum InstalledCopy {
    static let folders = [URL(fileURLWithPath: "/Applications"), FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")]

    /// The copy to open instead of the app at `me` when that runs from a read-only volume: one in `folders` under its name,
    /// with its bundle id and at least its build, so an older install is not opened in place of the newer image.
    static func instead(of me: URL, in folders: [URL] = folders) -> URL? {
        guard (try? me.resourceValues(forKeys: [.volumeIsReadOnlyKey]))?.volumeIsReadOnly == true, let mine = Bundle(url: me) else { return nil }
        return folders.map { $0.appendingPathComponent(me.lastPathComponent) }.first { url in
            guard url.standardizedFileURL != me.standardizedFileURL, let copy = Bundle(url: url) else { return false }
            return copy.bundleIdentifier == mine.bundleIdentifier && build(copy) >= build(mine)
        }
    }

    /// Opens `copy` and quits. The copy carries the download's quarantine, so macOS would ask again what the user just
    /// answered for this one; it is cleared first when the copy is signed as this app is.
    static func open(_ copy: URL) {
        DispatchQueue.global(qos: .userInitiated).async {
            if signedAlike(copy, Bundle.main.bundleURL) { releaseFromQuarantine(copy) }
            DispatchQueue.main.async {
                NSWorkspace.shared.openApplication(at: copy, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                    DispatchQueue.main.async {
                        if let error {
                            let alert = NSAlert()
                            alert.messageText = "Svall could not open the copy in Applications"
                            alert.informativeText = "\(error.localizedDescription) Open Svall from your Applications folder."
                            NSApp.activate()
                            alert.runModal()
                        }
                        NSApp.terminate(nil)
                    }
                }
            }
        }
    }

    /// Whether `copy` passes the designated requirement of the app at `me`: the same team and bundle id, or for an ad-hoc
    /// build the same code, with every sealed file intact.
    static func signedAlike(_ copy: URL, _ me: URL) -> Bool {
        var mine: SecStaticCode?, theirs: SecStaticCode?, requirement: SecRequirement?
        guard SecStaticCodeCreateWithPath(me as CFURL, [], &mine) == errSecSuccess, let mine,
              SecCodeCopyDesignatedRequirement(mine, [], &requirement) == errSecSuccess, let requirement,
              SecStaticCodeCreateWithPath(copy as CFURL, [], &theirs) == errSecSuccess, let theirs else { return false }
        return SecStaticCodeCheckValidity(theirs, [], requirement) == errSecSuccess
    }

    static func releaseFromQuarantine(_ bundle: URL) {
        removexattr(bundle.path, "com.apple.quarantine", XATTR_NOFOLLOW)
        guard let files = FileManager.default.enumerator(at: bundle, includingPropertiesForKeys: nil) else { return }
        for case let url as URL in files { removexattr(url.path, "com.apple.quarantine", XATTR_NOFOLLOW) }
    }

    private static func build(_ bundle: Bundle) -> Int {
        Int(bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
    }
}
