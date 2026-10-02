import AppKit

/// The app's quit, from the page's answer through the user's yes to the fleet stopping.
final class QuitFlow {
    private let send: (FromShell) -> Void
    private let isListening: () -> Bool
    private let hideWindow: () -> Void
    // where the page's answer goes while a quit waits on it, and what quits anyway if it never comes
    private var quitAnswer: ((Bool) -> Void)?
    private var quitTimeout: DispatchWorkItem?
    // whether the quit waiting on the page also waits on the user's yes
    private var userQuit = false
    // while the question is up, the user's answer is the only one: a late reply or a reload waits on it
    private var confirming = false
    // once the fleet is being stopped for a quit, a page that loses the daemon must not start it again
    private(set) var stopping = false
    // whether the fleet is being ended from here, which the quit waits on
    private var killing = false

    init(send: @escaping (FromShell) -> Void, isListening: @escaping () -> Bool, hideWindow: @escaping () -> Void) {
        self.send = send
        self.isListening = isListening
        self.hideWindow = hideWindow
    }

    /// Whether a quit waits on the page, the user or the fleet.
    var pending: Bool { quitAnswer != nil }

    /// Asks the page to save its docs and name the files a quit would drop, then the user when `confirm` or a file would be lost,
    /// then stops the fleet: every character sleeps until it is opened again.
    func ask(confirm: Bool, answer: @escaping (Bool) -> Void) -> NSApplication.TerminateReply {
        guard quitAnswer == nil else { return .terminateNow }
        // a page that is not up has nothing to save and no daemon to ask
        guard isListening() else {
            guard !confirm || confirmQuit(unsaved: [], working: 0) else { return .terminateCancel }
            quitAnswer = answer
            fleetStopped(ok: false)
            return .terminateLater
        }
        // a page that is up names its unsaved files first, so the one question can name them too
        userQuit = confirm
        quitAnswer = answer
        // longer than the page gives its saves, so only a page that is stuck or gone runs it out
        let timeout = DispatchWorkItem { [weak self] in self?.answered(unsaved: [], working: 0) }
        quitTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: timeout)
        send(.quitAsk)
        return .terminateLater
    }

    /// The page's answer to `.quitAsk`: the files the quit would drop and the agents it would stop mid-task.
    func answered(unsaved: [String], working: Int) {
        guard quitAnswer != nil, !confirming, !stopping else { return }
        quitTimeout?.cancel()
        if userQuit || !unsaved.isEmpty {
            confirming = true
            let ok = confirmQuit(unsaved: unsaved, working: working)
            confirming = false
            guard ok else { return finishQuit(false) }
        }
        stopFleet()
    }

    /// The page's answer to `.quitStop`.
    func stopped(ok: Bool) {
        if stopping { fleetStopped(ok: ok) }
    }

    /// The page a quit was waiting on is gone with nothing of it left to save: the user still answers a quit of theirs,
    /// and the fleet is ended from here.
    func pageGone() {
        if quitAnswer != nil, !confirming {
            if stopping { fleetStopped(ok: false) } else { answered(unsaved: [], working: 0) }
        }
    }

    private func finishQuit(_ ok: Bool) {
        guard !confirming else { return }
        userQuit = false
        guard let answer = quitAnswer else { return }
        quitAnswer = nil
        quitTimeout?.cancel()
        quitTimeout = nil
        answer(ok)
    }

    // the page has the daemon put every character to sleep and exit; what it cannot reach is ended from here
    private func stopFleet() {
        guard isListening() else { return fleetStopped(ok: false) }
        stopping = true
        hideWindow()
        let timeout = DispatchWorkItem { [weak self] in self?.fleetStopped(ok: false) }
        quitTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: timeout)
        send(.quitStop)
    }

    private func fleetStopped(ok: Bool) {
        guard quitAnswer != nil, !killing else { return }
        stopping = true
        if ok { return finishQuit(true) }
        // the kill can take a couple of seconds, which the window should not sit through
        hideWindow()
        killing = true
        FleetDaemon.kill { [weak self] in self?.finishQuit(true) }
    }

    private func confirmQuit(unsaved: [String], working: Int) -> Bool {
        let alert = NSAlert()
        let busy = working == 0 ? "" : "\(working) \(working == 1 ? "character is" : "characters are") working and will stop."
        if unsaved.isEmpty {
            alert.messageText = "Quit Svall?"
            alert.informativeText = working == 0
                ? "Your characters stop and pick up where they left off when you open Svall again."
                : busy + " Everything picks up where it left off when you open Svall again."
        } else {
            alert.messageText = "Quit with unsaved changes?"
            let names = unsaved.count > 4 ? unsaved.prefix(3).joined(separator: ", ") + " and \(unsaved.count - 3) more" : ListFormatter.localizedString(byJoining: unsaved)
            alert.informativeText = "\(names) \(unsaved.count == 1 ? "has" : "have") changes that were not saved. Quitting drops them." + (busy.isEmpty ? "" : " " + busy)
        }
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate()
        return alert.runModal() == .alertFirstButtonReturn
    }
}
