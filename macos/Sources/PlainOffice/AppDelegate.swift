import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: MainWindowController?
    private var waiting: [URL] = []

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = MenuBuilder.build(target: self)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = MainWindowController()
        self.controller = controller
        controller.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        waiting.forEach { controller.web.open($0) }
        waiting = []
    }

    // Files opened from Finder ("Open With", double-click, dragging onto the Dock icon).
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let controller else { waiting += urls; return }
        urls.forEach { controller.web.open($0) }
        controller.window?.makeKeyAndOrderFront(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // ---------- Menu commands ----------

    @objc func command(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let controller else { return }
        switch id {
        case "close":
            // ⌘W closes the open document first, then the window.
            controller.web.command("close") { closed in if !closed { controller.window?.performClose(nil) } }
        case "rename":
            controller.chrome.rename()
        default:
            controller.web.command(id)
        }
    }

    @objc func openWebsite(_ sender: Any?) {
        NSWorkspace.shared.open(URL(string: "https://github.com/suhaankansra/plain-office")!)
    }
}

// The menu bar: the usual Mac menus, plus File and View commands for the app.
@MainActor
enum MenuBuilder {
    static func build(target: AppDelegate) -> NSMenu {
        let bar = NSMenu()
        let name = "Plain Office"

        func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let menu = NSMenu(title: title)
            items.forEach(menu.addItem)
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            holder.submenu = menu
            bar.addItem(holder)
            return menu
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, symbol: String? = nil) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = mods
            if let symbol, #available(macOS 26.0, *) { item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
            return item
        }
        func command(_ title: String, _ id: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, symbol: String? = nil) -> NSMenuItem {
            let item = item(title, #selector(AppDelegate.command(_:)), key, mods, symbol: symbol)
            item.target = target
            item.representedObject = id
            return item
        }

        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        services.submenu = NSMenu(title: "Services")
        NSApp.servicesMenu = services.submenu
        _ = menu(name, [
            item("About \(name)", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            services,
            .separator(),
            item("Hide \(name)", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit \(name)", #selector(NSApplication.terminate(_:)), "q"),
        ])

        _ = menu("File", [
            command("New…", "new", "n", symbol: "plus"),
            command("New Document", "doc", symbol: "doc.text"),
            command("New Spreadsheet", "sheet", symbol: "tablecells"),
            command("New Presentation", "slides", symbol: "play.rectangle"),
            command("New PDF…", "pdf", symbol: "doc.richtext"),
            .separator(),
            command("Open…", "open", "o", symbol: "folder"),
            .separator(),
            command("Close", "close", "w", symbol: "xmark"),
            command("Rename…", "rename", symbol: "pencil"),
        ])

        _ = menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            item("Delete", #selector(NSText.delete(_:))),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])

        _ = menu("View", [
            command("Home", "home", "1", symbol: "house"),
            command("Files", "files", "2", symbol: "folder"),
            command("Tools", "tools", "3", symbol: "square.grid.2x2"),
            command("Me", "me", "4", symbol: "person.crop.circle"),
            .separator(),
            item("Show Sidebar", #selector(NSSplitViewController.toggleSidebar(_:)), "s", [.command, .control], symbol: "sidebar.left"),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])

        NSApp.windowsMenu = menu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ])

        let website = item("Plain Office on GitHub", #selector(AppDelegate.openWebsite(_:)))
        website.target = target
        NSApp.helpMenu = menu("Help", [website])
        return bar
    }
}
