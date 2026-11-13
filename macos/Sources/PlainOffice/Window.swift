import AppKit
import WebKit

// The main window: a glass sidebar (Home, Files, Tools, Me), a unified glass
// toolbar, and the page underneath it. On macOS 26+ AppKit draws all of this
// with Liquid Glass; older macOS gets the classic translucent look.
@MainActor
final class MainWindowController: NSWindowController, NSWindowDelegate {
    let web = WebHost()
    let chrome = Chrome()
    private let split = NSSplitViewController()
    private let sidebar = SidebarController()
    private let content: ContentController

    init() {
        content = ContentController(web: web)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.title = "Plain Office"
        window.minSize = NSSize(width: 640, height: 480)
        window.toolbarStyle = .unified
        window.titlebarAppearsTransparent = true // the page scrolls under the glass buttons
        window.tabbingMode = .disallowed
        super.init(window: window)

        let sideItem = NSSplitViewItem(sidebarWithViewController: sidebar)
        sideItem.minimumThickness = 190
        sideItem.maximumThickness = 280
        sideItem.canCollapse = true
        split.addSplitViewItem(sideItem)
        let contentItem = NSSplitViewItem(viewController: content)
        if #available(macOS 26.0, *) {
            // The sidebar floats over the content as a Liquid Glass panel.
            contentItem.automaticallyAdjustsSafeAreaInsets = true
        }
        split.addSplitViewItem(contentItem)
        window.contentViewController = split
        window.setContentSize(NSSize(width: 1180, height: 800))
        window.center()
        window.setFrameAutosaveName("PlainOfficeMain")
        window.delegate = self

        chrome.attach(window: window, web: web, sidebar: sidebar, sideItem: sideItem, content: content)
        web.addMessageHandler(chrome, name: "plainOfficeChrome")
        web.start()
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

// ---------- The page plus the floating formatting bar ----------

@MainActor
final class ContentController: NSViewController {
    let web: WebHost
    let bar = FormatBar()
    var onLayout: ((CGFloat) -> Void)?

    init(web: WebHost) {
        self.web = web
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 700))
        web.webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web.webView)
        // The page fills the window under the toolbar, beside the floating sidebar.
        NSLayoutConstraint.activate([
            web.webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            web.webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.webView.topAnchor.constraint(equalTo: view.topAnchor),
            web.webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.isHidden = true
        view.addSubview(bar)
        let fill = bar.widthAnchor.constraint(equalToConstant: 10)
        fill.priority = .defaultHigh // narrower than this only when the window is
        bar.preferredWidth = fill
        NSLayoutConstraint.activate([
            bar.centerXAnchor.constraint(equalTo: web.webView.centerXAnchor),
            bar.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -FormatBar.margin),
            bar.leadingAnchor.constraint(greaterThanOrEqualTo: web.webView.leadingAnchor, constant: FormatBar.margin),
            bar.heightAnchor.constraint(equalToConstant: FormatBar.height),
            fill,
        ])
        self.view = view
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        onLayout?(view.safeAreaInsets.top)
    }
}

// A capsule of formatting buttons floating over the bottom of the page
// (bold, italic, lists...), mirrored from the web app's .toolbar.
@MainActor
final class FormatBar: NSView {
    static let height: CGFloat = 46
    static let margin: CGFloat = 14
    var onTap: ((String) -> Void)?
    var preferredWidth: NSLayoutConstraint?
    private let stack = NSStackView()
    private let scroll = NSScrollView()
    private var ids: [String] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 2
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 10, bottom: 0, right: 10)
        stack.translatesAutoresizingMaskIntoConstraints = false

        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = false
        scroll.hasVerticalScroller = false
        scroll.verticalScrollElasticity = .none
        scroll.horizontalScrollElasticity = .allowed
        scroll.documentView = stack
        let clip = scroll.contentView
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            stack.topAnchor.constraint(equalTo: clip.topAnchor),
            stack.bottomAnchor.constraint(equalTo: clip.bottomAnchor),
        ])

        let material: NSView
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView()
            glass.cornerRadius = Self.height / 2
            glass.contentView = scroll
            material = glass
        } else {
            let blur = NSVisualEffectView()
            blur.material = .popover
            blur.blendingMode = .withinWindow
            blur.state = .active
            blur.wantsLayer = true
            blur.layer?.cornerRadius = Self.height / 2
            blur.layer?.masksToBounds = true
            scroll.frame = blur.bounds
            scroll.autoresizingMask = [.width, .height]
            blur.addSubview(scroll)
            material = blur
        }
        material.frame = bounds
        material.autoresizingMask = [.width, .height]
        addSubview(material)
        if #unavailable(macOS 26.0) {
            // Liquid Glass draws its own edge; the older material needs a soft shadow.
            shadow = NSShadow()
            wantsLayer = true
            layer?.shadowColor = NSColor.black.cgColor
            layer?.shadowOpacity = 0.12
            layer?.shadowRadius = 10
            layer?.shadowOffset = CGSize(width: 0, height: -2)
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(_ items: [[String: Any]], tint: NSColor) {
        let newIds = items.map { ($0["sep"] as? Bool == true) ? "|" : ($0["id"] as? String ?? "") }
        if newIds != ids {
            ids = newIds
            stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
            for item in items {
                if item["sep"] as? Bool == true {
                    let line = NSBox()
                    line.boxType = .separator
                    line.translatesAutoresizingMaskIntoConstraints = false
                    line.heightAnchor.constraint(equalToConstant: 22).isActive = true
                    stack.addArrangedSubview(line)
                    stack.setCustomSpacing(6, after: stack.arrangedSubviews[max(0, stack.arrangedSubviews.count - 2)])
                    stack.setCustomSpacing(6, after: line)
                } else {
                    let button = BarButton()
                    button.target = self
                    button.action = #selector(tapped(_:))
                    stack.addArrangedSubview(button)
                }
            }
        }
        var buttons = stack.arrangedSubviews.compactMap { $0 as? BarButton }.makeIterator()
        for item in items where item["sep"] as? Bool != true {
            buttons.next()?.configure(item, tint: tint)
        }
        // The bar is as wide as its buttons (it scrolls when the window is narrower).
        let views = stack.arrangedSubviews
        var width = stack.edgeInsets.left + stack.edgeInsets.right
        for (index, view) in views.enumerated() {
            width += view is NSBox ? 1 : max(36, view.fittingSize.width)
            if index < views.count - 1 {
                let custom = stack.customSpacing(after: view)
                width += custom == NSStackView.useDefaultSpacing ? stack.spacing : custom
            }
        }
        preferredWidth?.constant = width
    }

    @objc private func tapped(_ sender: BarButton) {
        onTap?(sender.itemId)
    }
}

@MainActor
final class BarButton: NSButton {
    var itemId = ""

    convenience init() {
        self.init(frame: NSRect(x: 0, y: 0, width: 36, height: 34))
        isBordered = false
        bezelStyle = .regularSquare
        imagePosition = .imageOnly
        wantsLayer = true
        layer?.cornerRadius = 10
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 34).isActive = true
        widthAnchor.constraint(greaterThanOrEqualToConstant: 36).isActive = true
    }

    func configure(_ spec: [String: Any], tint: NSColor) {
        itemId = spec["id"] as? String ?? ""
        let label = spec["label"] as? String ?? ""
        toolTip = label
        setAccessibilityLabel(label)
        let config = NSImage.SymbolConfiguration(pointSize: 15, weight: .medium)
        if let symbol = spec["symbol"] as? String, let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)?.withSymbolConfiguration(config) {
            self.image = image
            title = ""
            imagePosition = .imageOnly
        } else {
            image = nil
            imagePosition = .noImage
            let text = (spec["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? label
            attributedTitle = NSAttributedString(string: "  \(text)  ", attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: NSColor.labelColor])
        }
        let on = spec["on"] as? Bool ?? false
        isEnabled = !(spec["disabled"] as? Bool ?? false)
        contentTintColor = on ? tint : .labelColor
        layer?.backgroundColor = on ? tint.withAlphaComponent(0.18).cgColor : NSColor.clear.cgColor
    }
}

// ---------- Sidebar: Home, Files, Tools, Me ----------

@MainActor
final class SidebarController: NSViewController, NSTableViewDataSource, NSTableViewDelegate {
    var onSelect: ((String) -> Void)?
    private var items: [[String: Any]] = []
    private let table = NSTableView()
    private var updating = false

    override func loadView() {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 220, height: 600))
        table.style = .sourceList
        table.headerView = nil
        table.rowSizeStyle = .large
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("tab")))
        table.dataSource = self
        table.delegate = self
        table.focusRingType = .none
        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        view = scroll
    }

    var isEnabled = true { didSet { table.isEnabled = isEnabled } }

    func set(items newItems: [[String: Any]], selected: String?) {
        let ids = { (list: [[String: Any]]) in list.map { $0["id"] as? String ?? "" } }
        updating = true
        if ids(newItems) != ids(items) || newItems.map({ $0["title"] as? String ?? "" }) != items.map({ $0["title"] as? String ?? "" }) {
            items = newItems
            table.reloadData()
        }
        if let index = items.firstIndex(where: { $0["id"] as? String == selected }), table.selectedRow != index {
            table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        }
        updating = false
    }

    func numberOfRows(in tableView: NSTableView) -> Int { items.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let item = items[row]
        let cell = NSTableCellView()
        let image = NSImageView(image: NSImage(systemSymbolName: item["symbol"] as? String ?? "circle", accessibilityDescription: nil) ?? NSImage())
        let text = NSTextField(labelWithString: item["title"] as? String ?? "")
        cell.imageView = image
        cell.textField = text
        for view in [image, text] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(view)
        }
        NSLayoutConstraint.activate([
            image.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4),
            image.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            image.widthAnchor.constraint(equalToConstant: 20),
            text.leadingAnchor.constraint(equalTo: image.trailingAnchor, constant: 8),
            text.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -4),
            text.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !updating, table.selectedRow >= 0, let id = items[table.selectedRow]["id"] as? String else { return }
        onSelect?(id)
    }
}
