/// What acts on this machine's own disk, for a path the page says is on `machine`. The same path on another machine can name
/// something else here, so it runs only when the page's machine is this one, or neither knows an id yet, as on a first run.
struct LocalActions {
    let refuse: (FromShell) -> Void
    let pickFolder: (String) -> Void
    var openFolder: (String) -> Void = ExternalURL.openFolder
    var reveal: (String) -> Void = ExternalURL.reveal
    var openFile: (String) -> Void = ExternalURL.openFile
    var me: () -> String? = SvallHome.machineId

    func run(_ message: ToShell) {
        switch message {
        case .openFolder(let path, let machine): guarded(machine) { openFolder(path) }
        case .reveal(let path, let machine): guarded(machine) { reveal(path) }
        case .openFile(let path, let machine): guarded(machine) { openFile(path) }
        case .folderPick(let start, let machine): guarded(machine) { pickFolder(start) }
        default: break
        }
    }

    private func guarded(_ machine: String?, run: () -> Void) {
        if machine == me() { run() } else { refuse(.localUnavailable(machine: machine)) }
    }
}
