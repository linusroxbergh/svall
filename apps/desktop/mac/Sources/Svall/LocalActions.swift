/// What acts on this machine's own disk, for a path the page says is on `machine`. The same path on another machine can name
/// something else here, so it runs only when the page's machine is this one, or neither knows an id yet, as on a first run.
struct LocalActions {
    let refuse: (FromShell) -> Void
    let openFolder: (String) -> Void
    let reveal: (String) -> Void
    let openFile: (String) -> Void
    let pickFolder: (String) -> Void

    func run(_ message: ToShell, me: String?) {
        switch message {
        case .openFolder(let path, let machine): guarded("openFolder", machine, me) { openFolder(path) }
        case .reveal(let path, let machine): guarded("reveal", machine, me) { reveal(path) }
        case .openFile(let path, let machine): guarded("openFile", machine, me) { openFile(path) }
        case .folderPick(let start, let machine): guarded("folder.pick", machine, me) { pickFolder(start) }
        default: break
        }
    }

    private func guarded(_ action: String, _ machine: String?, _ me: String?, run: () -> Void) {
        if machine == me { run() } else { refuse(.localUnavailable(action: action, machine: machine)) }
    }
}
