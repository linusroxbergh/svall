import AppKit

/// The copy dragged to Applications, which an app opened from its disk image (or from wherever macOS moved it to run it)
/// opens in its place.
enum InstalledCopy {
    private static let folders = [URL(fileURLWithPath: "/Applications"), FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")]

    /// Hands over to the copy in Applications when this app runs from a read-only volume, or asks for the drag when there is
    /// none yet, and quits either way; false when this app runs where it is.
    static func handOver() -> Bool {
        let me = Bundle.main.bundleURL
        guard (try? me.resourceValues(forKeys: [.volumeIsReadOnlyKey]))?.volumeIsReadOnly == true else { return false }
        if let copy = instead(of: me) { open(copy) } else { askForDrag() }
        return true
    }

    /// The copy to open instead of the app at `me`: one in `folders` under its name, with its bundle id, at least its build
    /// (an older install is not opened in place of the newer image), and signed as it is.
    private static func instead(of me: URL) -> URL? {
        guard let mine = Bundle(url: me) else { return nil }
        return folders.map { $0.appendingPathComponent(me.lastPathComponent) }.first { url in
            guard url.standardizedFileURL != me.standardizedFileURL, let copy = Bundle(url: url),
                  copy.bundleIdentifier == mine.bundleIdentifier, build(copy) >= build(mine) else { return false }
            return signedAlike(url, me)
        }
    }

    /// Opens `copy` and quits. The copy carries the download's quarantine, so macOS would ask again what the user just
    /// answered for this one; it is signed as this app is, so the quarantine is cleared first.
    private static func open(_ copy: URL) {
        releaseFromQuarantine(copy)
        NSWorkspace.shared.openApplication(at: copy, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            DispatchQueue.main.async {
                if let error {
                    NSAlert.tell("Svall could not open the copy in Applications", "\(error.localizedDescription) Open Svall from your Applications folder.")
                }
                NSApp.terminate(nil)
            }
        }
    }

    private static func askForDrag() {
        NSAlert.tell("Move Svall to Applications", "Drag Svall to the Applications folder, then open it from there.")
        NSApp.terminate(nil)
    }

    /// Whether `copy` passes the designated requirement of the app at `me` (the same team and bundle id, or for an ad-hoc
    /// build the same code) with every sealed file and nested bundle intact, as `codesign --verify --deep --strict` checks.
    private static func signedAlike(_ copy: URL, _ me: URL) -> Bool {
        var mine: SecStaticCode?, theirs: SecStaticCode?, requirement: SecRequirement?
        guard SecStaticCodeCreateWithPath(me as CFURL, [], &mine) == errSecSuccess, let mine,
              SecCodeCopyDesignatedRequirement(mine, [], &requirement) == errSecSuccess, let requirement,
              SecStaticCodeCreateWithPath(copy as CFURL, [], &theirs) == errSecSuccess, let theirs else { return false }
        return SecStaticCodeCheckValidity(theirs, SecCSFlags(rawValue: kSecCSCheckNestedCode | kSecCSStrictValidate), requirement) == errSecSuccess
    }

    private static func releaseFromQuarantine(_ bundle: URL) {
        removexattr(bundle.path, "com.apple.quarantine", XATTR_NOFOLLOW)
        guard let files = FileManager.default.enumerator(at: bundle, includingPropertiesForKeys: nil) else { return }
        for case let url as URL in files { removexattr(url.path, "com.apple.quarantine", XATTR_NOFOLLOW) }
    }

    private static func build(_ bundle: Bundle) -> Int {
        Int(bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
    }
}
