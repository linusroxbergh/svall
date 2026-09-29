import AppKit

/// A page's alert, confirm or prompt, drawn over its own tab. The page waits for the answer; the rest of the
/// shell, and every other tab, carries on.
final class BrowserDialog: NSView, NSTextFieldDelegate {
    private let field: NSTextField?
    private var answer: ((_ ok: Bool, _ text: String) -> Void)?

    init(message: String, origin: String, cancellable: Bool, text: String?, answer: @escaping (_ ok: Bool, _ text: String) -> Void) {
        self.field = text.map { NSTextField(string: $0) }
        self.answer = answer
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.withAlphaComponent(0.35).cgColor

        let title = NSTextField(wrappingLabelWithString: message)
        title.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
        title.maximumNumberOfLines = 12
        title.cell?.truncatesLastVisibleLine = true
        let site = NSTextField(labelWithString: origin)
        site.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        site.textColor = .secondaryLabelColor
        site.lineBreakMode = .byTruncatingMiddle
        site.isHidden = origin.isEmpty

        let ok = NSButton(title: "OK", target: self, action: #selector(accept))
        ok.bezelColor = .controlAccentColor
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancel.isHidden = !cancellable
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow - 1, for: .horizontal)
        let buttons = NSStackView(views: [spacer, cancel, ok])
        buttons.spacing = 8

        let rows: [NSView] = [title, site] + (field.map { [$0] } ?? []) + [buttons]
        let stack = NSStackView(views: rows)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.setCustomSpacing(14, after: rows[rows.count - 2])
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        field?.delegate = self

        let panel = NSVisualEffectView()
        panel.material = .popover
        panel.state = .active
        panel.wantsLayer = true
        panel.layer?.cornerRadius = 10
        panel.layer?.masksToBounds = true
        panel.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(stack)
        addSubview(panel)

        // as wide as a system alert, less in a tab too narrow to hold one
        let width = panel.widthAnchor.constraint(equalToConstant: 340)
        width.priority = .defaultHigh
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: panel.leadingAnchor), stack.trailingAnchor.constraint(equalTo: panel.trailingAnchor),
            stack.topAnchor.constraint(equalTo: panel.topAnchor), stack.bottomAnchor.constraint(equalTo: panel.bottomAnchor),
            panel.centerXAnchor.constraint(equalTo: centerXAnchor), panel.centerYAnchor.constraint(equalTo: centerYAnchor),
            panel.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -24), width,
        ] + rows.map { $0.trailingAnchor.constraint(equalTo: stack.trailingAnchor, constant: -16) })
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    override var acceptsFirstResponder: Bool { true }

    func takeKeys() {
        window?.makeFirstResponder(field ?? self)
        field?.selectText(nil)
    }

    @objc private func accept() { finish(true) }
    @objc func cancel() { finish(false) }

    // WebKit raises if a dialog's completion handler is dropped unanswered, or answered twice
    private func finish(_ ok: Bool) {
        guard let answer else { return }
        self.answer = nil
        let tab = superview
        let hadKeys = (window?.firstResponder as? NSView)?.isDescendant(of: self) ?? false
        removeFromSuperview()
        if hadKeys, let tab { tab.window?.makeFirstResponder(tab) }
        answer(ok, field?.stringValue ?? "")
    }

    // Return and Escape are read here rather than as key equivalents, which a window offers to every view
    // it holds, this one included while another pane has the keys
    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 36, 76: finish(true)
        case 53: finish(false)
        default: break
        }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.insertNewline(_:)): finish(true)
        case #selector(NSResponder.cancelOperation(_:)): finish(false)
        default: return false
        }
        return true
    }

    // the page underneath is waiting and must not take a click meant for nothing
    override func mouseDown(with event: NSEvent) { takeKeys() }
    override func mouseUp(with event: NSEvent) {}
    override func mouseDragged(with event: NSEvent) {}
    override func rightMouseDown(with event: NSEvent) {}
    override func otherMouseDown(with event: NSEvent) {}
    override func scrollWheel(with event: NSEvent) {}
}
