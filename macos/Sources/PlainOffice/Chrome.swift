import AppKit
import WebKit

// Mirrors the web app's bars into native Mac controls (src/native-chrome.js
// sends their state; taps are sent back as "tap" events):
//   .topbar  -> the window toolbar (back, title, buttons) and window title
//   .tabbar  -> the sidebar, plus a "+" button in the toolbar
//   .toolbar -> the floating glass formatting bar
// Menus and alerts from the page become native menus and alerts too.
@MainActor
final class Chrome: NSObject, WKScriptMessageHandlerWithReply, NSToolbarDelegate {
    private weak var window: NSWindow?
    private weak var web: WebHost?
    private weak var sidebar: SidebarController?
    private weak var sideItem: NSSplitViewItem?
    private weak var content: ContentController?
    private let toolbar = NSToolbar(identifier: "PlainOfficeToolbar")

    private var topBar: [String: Any]?
    private var tabBar: [String: Any]?
    private var specs: [String: [String: Any]] = [:]
    private var currentIds: [NSToolbarItem.Identifier] = []
    private var tint = NSColor.controlAccentColor
    private var overlay = false
    private var barVisible = false
    private var autoCollapsed = false
    private var sentInsets: (CGFloat, CGFloat) = (-1, -1)

    func attach(window: NSWindow, web: WebHost, sidebar: SidebarController, sideItem: NSSplitViewItem, content: ContentController) {
        self.window = window
        self.web = web
        self.sidebar = sidebar
        self.sideItem = sideItem
        self.content = content
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar
        sidebar.onSelect = { [weak self] id in self?.emit("tap", ["id": id]) }
        content.bar.onTap = { [weak self] id in self?.emit("tap", ["id": id]) }
        content.onLayout = { [weak self] _ in self?.sendInsets() }
        refreshToolbar()
    }

    // ---------- Messages from the page ----------

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            return replyHandler(nil, "Bad message")
        }
        let args = body["args"] as? [String: Any] ?? [:]
        switch method {
        case "isAvailable":
            replyHandler(["available": true], nil)
            sendInsets(force: true)
        case "setTopBar":
            topBar = (args["visible"] as? Bool ?? false) ? args : nil
            if let hex = args["tint"] as? String, let color = NSColor(hex: hex) { tint = color } else { tint = .controlAccentColor }
            refreshToolbar()
            replyHandler([:], nil)
        case "setTabBar":
            tabBar = (args["visible"] as? Bool ?? false) ? args : nil
            applyTabBar()
            refreshToolbar()
            replyHandler([:], nil)
        case "setToolbar":
            applyFormatBar(args)
            replyHandler([:], nil)
        case "setOverlay":
            overlay = args["on"] as? Bool ?? false
            applyOverlay()
            replyHandler([:], nil)
        case "actionSheet":
            showMenu(args) { replyHandler(["index": $0], nil) }
        case "alert":
            showAlert(args) { ok, value in replyHandler(["ok": ok, "value": value], nil) }
        default:
            replyHandler([:], nil)
        }
    }

    private func emit(_ event: String, _ data: [String: Any]) {
        web?.run("window.__plainOfficeChrome?.emit(event, data)", ["event": event, "data": data])
    }

    func rename() {
        if let id = topBar?["renameId"] as? String { emit("tap", ["id": id]) }
    }

    // The page needs to know how tall the toolbar is (it scrolls under it)
    // and how much room the formatting bar takes at the bottom.
    private func sendInsets(force: Bool = false) {
        guard let view = content?.view else { return }
        let insets = (view.safeAreaInsets.top, barVisible ? FormatBar.height + FormatBar.margin : 0)
        if !force && insets == sentInsets { return }
        sentInsets = insets
        emit("insets", ["top": insets.0, "toolbar": insets.1])
    }

    // ---------- Toolbar ----------

    private func refreshToolbar() {
        guard let window else { return }
        var ids: [NSToolbarItem.Identifier] = []
        specs = [:]
        if let bar = topBar {
            // In a document: back, the title (drawn by the window), then the buttons.
            if let back = bar["back"] as? [String: Any], let id = back["id"] as? String {
                specs["back:" + id] = back.merging(["symbol": "chevron.backward"]) { _, new in new }
                ids.append(NSToolbarItem.Identifier("back:" + id))
            }
            ids.append(.flexibleSpace)
            for item in bar["items"] as? [[String: Any]] ?? [] {
                guard let id = item["id"] as? String else { continue }
                specs[id] = item
                ids.append(NSToolbarItem.Identifier(id))
            }
            window.title = (bar["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Plain Office"
            window.subtitle = bar["subtitle"] as? String ?? ""
        } else {
            ids = [.toggleSidebar, .sidebarTrackingSeparator, .flexibleSpace]
            if let accessory = tabBar?["accessory"] as? [String: Any], let id = accessory["id"] as? String {
                specs["add:" + id] = accessory.merging(["prominent": true, "label": "New"]) { _, new in new }
                ids.append(NSToolbarItem.Identifier("add:" + id))
            }
            window.title = "Plain Office"
            let selected = tabBar?["selected"] as? String
            let items = tabBar?["items"] as? [[String: Any]] ?? []
            window.subtitle = items.first { $0["id"] as? String == selected }?["title"] as? String ?? ""
        }

        if ids == currentIds {
            for item in toolbar.items {
                if let spec = specs[item.itemIdentifier.rawValue] { configure(item, spec) }
            }
            return
        }
        currentIds = ids
        while !toolbar.items.isEmpty { toolbar.removeItem(at: 0) }
        for (index, id) in ids.enumerated() { toolbar.insertItem(withItemIdentifier: id, at: index) }
    }

    private func configure(_ item: NSToolbarItem, _ spec: [String: Any]) {
        let label = (spec["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? spec["title"] as? String ?? ""
        item.label = label
        item.toolTip = label
        if let symbol = spec["symbol"] as? String, let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label) {
            item.image = image
            item.title = ""
        } else {
            item.image = nil
            item.title = (spec["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? label
        }
        item.isBordered = true
        item.isNavigational = item.itemIdentifier.rawValue.hasPrefix("back:") // left of the title, like Pages
        item.target = self
        item.action = #selector(toolbarTapped(_:))
        item.autovalidates = false
        item.isEnabled = !overlay && !(spec["disabled"] as? Bool ?? false)
        if #available(macOS 26.0, *) {
            let prominent = spec["on"] as? Bool == true || spec["prominent"] as? Bool == true
            item.style = prominent ? .prominent : .plain
            item.backgroundTintColor = prominent ? tint : nil
        }
    }

    @objc private func toolbarTapped(_ sender: NSToolbarItem) {
        var id = sender.itemIdentifier.rawValue
        for prefix in ["back:", "add:"] where id.hasPrefix(prefix) { id = String(id.dropFirst(prefix.count)) }
        emit("tap", ["id": id])
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard let spec = specs[id.rawValue] else { return nil }
        let item = NSToolbarItem(itemIdentifier: id)
        configure(item, spec)
        return item
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { currentIds }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        currentIds + [.toggleSidebar, .sidebarTrackingSeparator, .flexibleSpace, .space]
    }

    // ---------- Sidebar ----------

    private func applyTabBar() {
        guard let sideItem else { return }
        if let bar = tabBar {
            sidebar?.set(items: bar["items"] as? [[String: Any]] ?? [], selected: bar["selected"] as? String)
            if autoCollapsed && sideItem.isCollapsed { sideItem.animator().isCollapsed = false }
            autoCollapsed = false
        } else if !sideItem.isCollapsed {
            // A document is open: give it the whole window, like Pages.
            sideItem.animator().isCollapsed = true
            autoCollapsed = true
        }
    }

    // ---------- Formatting bar ----------

    private func applyFormatBar(_ args: [String: Any]) {
        guard let bar = content?.bar else { return }
        let items = args["items"] as? [[String: Any]] ?? []
        let visible = (args["visible"] as? Bool ?? false) && !items.isEmpty
        if visible { bar.update(items, tint: tint) }
        if visible != barVisible {
            barVisible = visible
            if visible { bar.alphaValue = 0; bar.isHidden = overlay }
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = 0.2
                bar.animator().alphaValue = visible ? 1 : 0
            }, completionHandler: { [weak self] in
                MainActor.assumeIsolated { if !(self?.barVisible ?? false) { bar.isHidden = true } }
            })
        }
        sendInsets()
    }

    // While the page shows its own sheet or presents slides, the bars step back.
    private func applyOverlay() {
        for item in toolbar.items { if let spec = specs[item.itemIdentifier.rawValue] { configure(item, spec) } }
        sidebar?.isEnabled = !overlay
        if let bar = content?.bar, barVisible { bar.isHidden = overlay }
    }

    // ---------- Menus and alerts ----------

    private func showMenu(_ opts: [String: Any], done: @escaping (Int) -> Void) {
        guard let window, let view = window.contentView else { return done(-1) }
        let menu = NSMenu()
        menu.autoenablesItems = false
        if let title = opts["title"] as? String, !title.isEmpty {
            if #available(macOS 14.0, *) {
                menu.addItem(.sectionHeader(title: title))
            } else {
                let header = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                header.isEnabled = false
                menu.addItem(header)
            }
        }
        let picker = MenuPicker()
        for (index, item) in (opts["items"] as? [[String: Any]] ?? []).enumerated() {
            let title = item["title"] as? String ?? ""
            let entry = NSMenuItem(title: title, action: #selector(MenuPicker.pick(_:)), keyEquivalent: "")
            entry.target = picker
            entry.tag = index
            if let symbol = item["symbol"] as? String { entry.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
            if item["destructive"] as? Bool == true {
                entry.attributedTitle = NSAttributedString(string: title, attributes: [.foregroundColor: NSColor.systemRed, .font: NSFont.menuFont(ofSize: 0)])
            }
            menu.addItem(entry)
        }
        // Open the menu where the person just clicked.
        let point = view.convert(window.mouseLocationOutsideOfEventStream, from: nil)
        menu.popUp(positioning: nil, at: point, in: view)
        DispatchQueue.main.async { done(picker.chosen) }
    }

    private func showAlert(_ opts: [String: Any], done: @escaping (Bool, String) -> Void) {
        let alert = NSAlert()
        alert.messageText = opts["title"] as? String ?? ""
        alert.informativeText = opts["message"] as? String ?? ""
        let ok = alert.addButton(withTitle: (opts["ok"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "OK")
        if opts["destructive"] as? Bool == true { ok.hasDestructiveAction = true }
        if opts["cancel"] as? String != "" {
            let cancel = alert.addButton(withTitle: opts["cancel"] as? String ?? "Cancel")
            cancel.keyEquivalent = "\u{1b}"
        }
        var field: NSTextField?
        if let input = opts["input"] as? [String: Any] {
            let text = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
            text.stringValue = input["value"] as? String ?? ""
            text.placeholderString = input["placeholder"] as? String
            alert.accessoryView = text
            alert.window.initialFirstResponder = text
            field = text
        }
        guard let window else {
            return done(alert.runModal() == .alertFirstButtonReturn, field?.stringValue ?? "")
        }
        alert.beginSheetModal(for: window) { response in
            done(response == .alertFirstButtonReturn, field?.stringValue ?? "")
        }
    }
}

@MainActor
private final class MenuPicker: NSObject {
    var chosen = -1
    @objc func pick(_ sender: NSMenuItem) { chosen = sender.tag }
}

extension NSColor {
    convenience init?(hex: String) {
        var value: UInt64 = 0
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count == 6, Scanner(string: digits).scanHexInt64(&value) else { return nil }
        self.init(srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }
}
