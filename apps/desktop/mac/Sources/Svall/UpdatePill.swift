import AppKit

/// The pill at the right end of the title bar that stands for an update a scheduled check found, hidden until then.
final class UpdatePill: NSTitlebarAccessoryViewController {
    private let button = NSButton()

    init(target: AnyObject, action: Selector) {
        super.init(nibName: nil, bundle: nil)
        let cream = NSColor(srgbRed: 0xF0 / 255, green: 0xE6 / 255, blue: 0xCE / 255, alpha: 1)
        let sand = NSColor(srgbRed: 0xE6 / 255, green: 0xD8 / 255, blue: 0xB8 / 255, alpha: 1)
        button.target = target
        button.action = action
        button.isBordered = false
        // the dot is text rather than an image, which AppKit would grey in an inactive window while the title kept its colour
        let title = NSMutableAttributedString(string: "●", attributes: [.font: NSFont.systemFont(ofSize: 7), .foregroundColor: sand, .baselineOffset: 1.5])
        title.append(NSAttributedString(string: " Update available", attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .medium), .foregroundColor: sand]))
        button.attributedTitle = title
        button.setAccessibilityLabel("Update available")
        button.wantsLayer = true
        button.layer?.cornerRadius = 9
        button.layer?.borderWidth = 1
        button.layer?.borderColor = cream.withAlphaComponent(0.13).cgColor
        button.layer?.backgroundColor = cream.withAlphaComponent(0.10).cgColor
        button.translatesAutoresizingMaskIntoConstraints = false
        let width = button.intrinsicContentSize.width + 16
        let box = NSView(frame: NSRect(x: 0, y: 0, width: width + 10, height: 28))
        box.addSubview(button)
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: width),
            button.heightAnchor.constraint(equalToConstant: 18),
            button.centerYAnchor.constraint(equalTo: box.centerYAnchor),
            button.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -10),
        ])
        view = box
        layoutAttribute = .trailing
        isHidden = true
    }

    required init?(coder: NSCoder) { fatalError("UpdatePill is made in code") }

    func show(version: String) {
        button.toolTip = "Svall \(version) is out"
        isHidden = false
    }
}
