// Real Liquid Glass for Plain Office on iPhone and iPad (iOS 26 and newer).
//
// The web app keeps drawing every screen, but on iOS its bars are shown with
// the system's own UIKit controls, so they get Apple's real Liquid Glass
// (refraction, the user's Clear/Tinted setting, iOS 27's prominent tab...):
//
//   ChromeController (UITabBarController)   Home / Files / Tools / Me + a prominent "New" tab
//     └ UINavigationController per tab      the top bar of the current screen
//         └ HostViewController              holds the web view (moved to whichever tab is selected)
//             └ GlassToolbar                the formatting bar, floating above the keyboard
//
// src/native-chrome.js mirrors the web app's hidden bars to these controls and
// clicks the matching web button when a native one is tapped. Action sheets
// and alerts are shown natively too. Older iOS versions keep the web bars.

import UIKit
import WebKit
import Capacitor

// MARK: - Bridge view controller (registers the plugin)

class MainBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeChromePlugin())
        // The app has its own formatting bar above the keyboard, so drop WebKit's
        // "up / down / Done" bar.
        if let webView { hideKeyboardAccessory(in: webView) }
    }
}

private final class NoAccessory: NSObject {
    @objc var inputAccessoryView: AnyObject? { nil }
}

private func hideKeyboardAccessory(in webView: WKWebView) {
    guard let content = webView.scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }),
          let baseClass = object_getClass(content) else { return }
    let name = "\(baseClass)_PlainOfficeNoAccessory"
    var subclass: AnyClass? = NSClassFromString(name)
    if subclass == nil, let made = objc_allocateClassPair(baseClass, name, 0),
       let method = class_getInstanceMethod(NoAccessory.self, #selector(getter: NoAccessory.inputAccessoryView)) {
        class_addMethod(made, #selector(getter: UIResponder.inputAccessoryView), method_getImplementation(method), method_getTypeEncoding(method))
        objc_registerClassPair(made)
        subclass = made
    }
    if let subclass { object_setClass(content, subclass) }
}

// MARK: - Plugin

@objc(NativeChromePlugin)
public class NativeChromePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeChromePlugin"
    public let jsName = "NativeChrome"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTopBar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTabBar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setToolbar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setOverlay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "actionSheet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "alert", returnType: CAPPluginReturnPromise),
    ]

    static weak var current: NativeChromePlugin?

    override public func load() {
        NativeChromePlugin.current = self
    }

    func emit(_ event: String, _ data: [String: Any]) {
        notifyListeners(event, data: data)
    }

    private func options(_ call: CAPPluginCall) -> [String: Any] {
        (call.options as? [String: Any]) ?? [:]
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if #available(iOS 26.0, *) {
                call.resolve(["available": ChromeController.shared != nil])
            } else {
                call.resolve(["available": false])
            }
        }
    }

    @objc func setTopBar(_ call: CAPPluginCall) {
        let opts = options(call)
        DispatchQueue.main.async {
            if #available(iOS 26.0, *) { ChromeController.shared?.setTopBar(opts) }
            call.resolve()
        }
    }

    @objc func setTabBar(_ call: CAPPluginCall) {
        let opts = options(call)
        DispatchQueue.main.async {
            if #available(iOS 26.0, *) { ChromeController.shared?.setTabBar(opts) }
            call.resolve()
        }
    }

    @objc func setToolbar(_ call: CAPPluginCall) {
        let opts = options(call)
        DispatchQueue.main.async {
            if #available(iOS 26.0, *) { ChromeController.shared?.setToolbar(opts) }
            call.resolve()
        }
    }

    @objc func setOverlay(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            if #available(iOS 26.0, *) { ChromeController.shared?.setOverlay(on) }
            call.resolve()
        }
    }

    @objc func actionSheet(_ call: CAPPluginCall) {
        let opts = options(call)
        DispatchQueue.main.async {
            guard #available(iOS 26.0, *), let chrome = ChromeController.shared else { return call.resolve(["index": -1]) }
            chrome.actionSheet(opts) { index in call.resolve(["index": index]) }
        }
    }

    @objc func alert(_ call: CAPPluginCall) {
        let opts = options(call)
        DispatchQueue.main.async {
            guard #available(iOS 26.0, *), let chrome = ChromeController.shared else { return call.resolve(["ok": false]) }
            chrome.alert(opts) { ok, text in call.resolve(["ok": ok, "value": text ?? ""]) }
        }
    }
}

// MARK: - Tabs and bars

@available(iOS 26.0, *)
final class ChromeController: UITabBarController, UITabBarControllerDelegate {
    static weak var shared: ChromeController?

    private let bridgeVC: UIViewController
    private var navs: [String: UINavigationController] = [:]
    private var tabIds: [String] = []
    private var accessoryId: String?
    private var currentHost: HostViewController?
    private var topBar: [String: Any]?
    private var formatItems: [[String: Any]] = []
    private var toolbarVisible = false
    private var tint: UIColor = UIColor(red: 0.17, green: 0.44, blue: 0.86, alpha: 1)
    private var overlay = false
    // What the user tapped last, so a menu it opens can point at it.
    private var lastSource: (item: UIBarButtonItem?, view: UIView?, time: Date)?

    init(bridge: UIViewController) {
        bridgeVC = bridge
        super.init(nibName: nil, bundle: nil)
        delegate = self
        mode = .tabBar
        ChromeController.shared = self
        configureTabs([["id": "home", "title": "Home", "symbol": "house"]], accessory: nil)
        setTabBarHidden(true, animated: false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.tintColor = tint
    }

    // MARK: Tabs

    private func nav(for id: String) -> UINavigationController {
        if let nav = navs[id] { return nav }
        let host = HostViewController()
        host.onToolbarTap = { [weak self] id, view in self?.tapped(id, view: view) }
        host.onRename = { [weak self] in self?.renameTapped() }
        let nav = UINavigationController(rootViewController: host)
        nav.setNavigationBarHidden(true, animated: false)
        navs[id] = nav
        return nav
    }

    private func configureTabs(_ items: [[String: Any]], accessory: [String: Any]?) {
        var list: [UITab] = items.compactMap { item in
            guard let id = item["id"] as? String else { return nil }
            let tab = UITab(title: item["title"] as? String ?? id, image: UIImage(systemName: item["symbol"] as? String ?? "circle"), identifier: id) { [weak self] tab in
                self?.nav(for: tab.identifier) ?? UIViewController()
            }
            return tab
        }
        if let accessory, let id = accessory["id"] as? String {
            let tab = UITab(title: accessory["title"] as? String ?? "New", image: UIImage(systemName: accessory["symbol"] as? String ?? "plus"), identifier: id) { _ in UIViewController() }
            list.append(tab)
            accessoryId = id
        } else {
            accessoryId = nil
        }
        tabIds = list.map(\.identifier)
        let selectedId = selectedTab?.identifier
        // A view controller can belong to only one UITab, so new tabs get new screens.
        navs.removeAll()
        currentHost = nil
        setTabs(list, animated: false)
        if #available(iOS 27.0, *) { prominentTabIdentifier = accessoryId }
        if let selectedId, let tab = tabs.first(where: { $0.identifier == selectedId }) { selectedTab = tab }
        attachBridge(to: selectedTab?.identifier ?? tabIds.first ?? "home")
    }

    // The single web view moves into whichever tab is showing.
    private func attachBridge(to id: String) {
        guard let host = nav(for: id).viewControllers.first as? HostViewController else { return }
        if currentHost !== host {
            host.adopt(bridgeVC)
            currentHost = host
        }
        applyTopBar()
        applyToolbar()
    }

    func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
        if tab.identifier == accessoryId {
            NativeChromePlugin.current?.emit("tap", ["id": tab.identifier])
            return false
        }
        attachBridge(to: tab.identifier)
        return true
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelectTab selectedTab: UITab, previousTab: UITab?) {
        if selectedTab.identifier != previousTab?.identifier {
            NativeChromePlugin.current?.emit("tap", ["id": selectedTab.identifier])
        }
    }

    func setTabBar(_ opts: [String: Any]) {
        let visible = opts["visible"] as? Bool ?? false
        if let items = opts["items"] as? [[String: Any]] {
            let accessory = (opts["accessory"] as? [String: Any])?["id"] as? String
            let ids = items.compactMap { $0["id"] as? String } + (accessory.map { [$0] } ?? [])
            if ids != tabIds { configureTabs(items, accessory: opts["accessory"] as? [String: Any]) }
        }
        if let selected = opts["selected"] as? String, selectedTab?.identifier != selected,
           let tab = tabs.first(where: { $0.identifier == selected }) {
            attachBridge(to: selected)
            selectedTab = tab
        }
        if isTabBarHidden == visible { setTabBarHidden(!visible, animated: true) }
    }

    // MARK: Top bar

    func setTopBar(_ opts: [String: Any]) {
        topBar = (opts["visible"] as? Bool ?? false) ? opts : nil
        if let hex = opts["tint"] as? String, let color = UIColor(hex: hex) { tint = color } else if topBar == nil { tint = UIColor(red: 0.17, green: 0.44, blue: 0.86, alpha: 1) }
        view.tintColor = tint
        applyTopBar()
    }

    private func applyTopBar() {
        guard let host = currentHost, let nav = host.navigationController else { return }
        guard let bar = topBar else {
            if !nav.isNavigationBarHidden { nav.setNavigationBarHidden(true, animated: true) }
            host.navigationItem.title = nil
            return
        }
        let item = host.navigationItem
        item.title = bar["title"] as? String
        item.subtitle = (bar["subtitle"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        item.largeTitleDisplayMode = .never
        if #available(iOS 27.2, *) { item.titleAlignment = .leading }
        if let back = bar["back"] as? [String: Any], let id = back["id"] as? String {
            let button = makeBarItem(["id": id, "symbol": back["symbol"] as? String ?? "chevron.backward", "label": back["label"] as? String ?? "Back"])
            item.leftBarButtonItems = [button]
        } else {
            item.leftBarButtonItems = []
        }
        // Document-editor bar (like Pages): the buttons are pinned so they never
        // fold into the overflow menu; a long title truncates instead.
        item.style = .editor
        let items = (bar["items"] as? [[String: Any]]) ?? []
        item.rightBarButtonItems = nil
        item.pinnedTrailingGroup = items.isEmpty ? nil : UIBarButtonItemGroup(barButtonItems: items.map { makeBarItem($0) }, representativeItem: nil)
        if let renameId = bar["renameId"] as? String {
            host.renameId = renameId
            item.titleMenuProvider = { [weak self] _ in
                UIMenu(children: [UIAction(title: "Rename", image: UIImage(systemName: "pencil")) { _ in self?.tapped(renameId, item: nil) }])
            }
        } else {
            item.titleMenuProvider = nil
        }
        nav.navigationBar.tintColor = tint
        if nav.isNavigationBarHidden { nav.setNavigationBarHidden(false, animated: true) }
    }

    private func makeBarItem(_ spec: [String: Any]) -> UIBarButtonItem {
        let id = spec["id"] as? String ?? ""
        let label = spec["label"] as? String ?? ""
        let button = UIBarButtonItem()
        if let symbol = spec["symbol"] as? String, let image = UIImage(systemName: symbol) {
            button.image = image
        } else {
            button.title = (spec["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? label
        }
        button.accessibilityLabel = label
        let on = spec["on"] as? Bool ?? false
        button.style = (on || spec["prominent"] as? Bool == true) ? .prominent : .plain
        button.isEnabled = !(spec["disabled"] as? Bool ?? false)
        button.primaryAction = UIAction(title: label, image: button.image) { [weak self, weak button] _ in
            self?.tapped(id, item: button)
        }
        if button.image == nil { button.title = (spec["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? label }
        return button
    }

    // MARK: Formatting bar

    func setToolbar(_ opts: [String: Any]) {
        toolbarVisible = opts["visible"] as? Bool ?? false
        formatItems = (opts["items"] as? [[String: Any]]) ?? []
        applyToolbar()
    }

    private func applyToolbar() {
        guard let host = currentHost else { return }
        host.setToolbar(visible: toolbarVisible && !overlay, items: formatItems, tint: tint)
    }

    // MARK: Web popups: fade the bars out so they don't cover web sheets

    func setOverlay(_ on: Bool) {
        overlay = on
        let alpha: CGFloat = on ? 0 : 1
        UIView.animate(withDuration: 0.2) {
            self.tabBar.alpha = alpha
            self.currentHost?.navigationController?.navigationBar.alpha = alpha
        }
        tabBar.isUserInteractionEnabled = !on
        currentHost?.navigationController?.navigationBar.isUserInteractionEnabled = !on
        applyToolbar()
    }

    // MARK: Taps

    private func tapped(_ id: String, item: UIBarButtonItem?) {
        lastSource = (item, nil, Date())
        NativeChromePlugin.current?.emit("tap", ["id": id])
    }

    private func tapped(_ id: String, view: UIView) {
        lastSource = (nil, view, Date())
        NativeChromePlugin.current?.emit("tap", ["id": id])
    }

    private func renameTapped() {
        if let id = currentHost?.renameId { tapped(id, item: nil) }
    }

    // MARK: Native action sheets and alerts

    private var topPresenter: UIViewController {
        var top: UIViewController = self
        while let next = top.presentedViewController { top = next }
        return top
    }

    func actionSheet(_ opts: [String: Any], done: @escaping (Int) -> Void) {
        let title = (opts["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let message = (opts["message"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let sheet = UIAlertController(title: title, message: message, preferredStyle: .actionSheet)
        for (index, item) in ((opts["items"] as? [[String: Any]]) ?? []).enumerated() {
            let action = UIAlertAction(title: item["title"] as? String ?? "", style: (item["destructive"] as? Bool ?? false) ? .destructive : .default) { _ in done(index) }
            if let symbol = item["symbol"] as? String, let image = UIImage(systemName: symbol) { action.setValue(image, forKey: "image") }
            sheet.addAction(action)
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done(-1) })
        if let popover = sheet.popoverPresentationController {
            if let source = lastSource, Date().timeIntervalSince(source.time) < 1.5, source.item != nil || source.view != nil {
                if let item = source.item { popover.sourceItem = item } else if let view = source.view { popover.sourceView = view; popover.sourceRect = view.bounds }
            } else {
                popover.sourceView = view
                popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
                popover.permittedArrowDirections = []
            }
        }
        topPresenter.present(sheet, animated: true)
    }

    func alert(_ opts: [String: Any], done: @escaping (Bool, String?) -> Void) {
        let alert = UIAlertController(title: opts["title"] as? String, message: (opts["message"] as? String).flatMap { $0.isEmpty ? nil : $0 }, preferredStyle: .alert)
        let input = opts["input"] as? [String: Any]
        if let input {
            alert.addTextField { field in
                field.text = input["value"] as? String
                field.placeholder = input["placeholder"] as? String
                field.clearButtonMode = .whileEditing
                field.autocapitalizationType = .sentences
            }
        }
        if opts["cancel"] as? String != "" {
            alert.addAction(UIAlertAction(title: opts["cancel"] as? String ?? "Cancel", style: .cancel) { _ in done(false, nil) })
        }
        let okStyle: UIAlertAction.Style = (opts["destructive"] as? Bool ?? false) ? .destructive : .default
        let ok = UIAlertAction(title: opts["ok"] as? String ?? "OK", style: okStyle) { [weak alert] _ in
            done(true, alert?.textFields?.first?.text)
        }
        alert.addAction(ok)
        alert.preferredAction = ok
        topPresenter.present(alert, animated: true) {
            alert.textFields?.first?.selectAll(nil)
        }
    }
}

// MARK: - The view controller that shows the web view

@available(iOS 26.0, *)
final class HostViewController: UIViewController {
    var onToolbarTap: ((String, UIView) -> Void)?
    var onRename: (() -> Void)?
    var renameId: String?
    private let toolbar = GlassToolbar()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        toolbar.isHidden = true
        toolbar.alpha = 0
        toolbar.onTap = { [weak self] id, view in self?.onToolbarTap?(id, view) }
        view.addSubview(toolbar)
        NSLayoutConstraint.activate([
            toolbar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            toolbar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            toolbar.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -8),
            toolbar.heightAnchor.constraint(equalToConstant: 52),
        ])
    }

    func adopt(_ child: UIViewController) {
        loadViewIfNeeded()
        if child.parent === self { return }
        child.willMove(toParent: nil)
        child.view.removeFromSuperview()
        child.removeFromParent()
        addChild(child)
        child.view.frame = view.bounds
        child.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.insertSubview(child.view, at: 0)
        child.didMove(toParent: self)
    }

    func setToolbar(visible: Bool, items: [[String: Any]], tint: UIColor) {
        loadViewIfNeeded()
        toolbar.tintColor = tint
        toolbar.setItems(items, tint: tint)
        view.bringSubviewToFront(toolbar)
        guard visible != !toolbar.isHidden else { return }
        if visible {
            toolbar.isHidden = false
            toolbar.transform = CGAffineTransform(translationX: 0, y: 20)
        }
        UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0.4) {
            self.toolbar.alpha = visible ? 1 : 0
            self.toolbar.transform = visible ? .identity : CGAffineTransform(translationX: 0, y: 20)
        } completion: { _ in
            if !visible { self.toolbar.isHidden = true }
        }
        // Tell the web page how much room the bar takes, so text isn't hidden under it.
        NativeChromePlugin.current?.emit("insets", ["toolbar": visible ? 60 : 0])
    }
}

// MARK: - A scrolling Liquid Glass bar of buttons

@available(iOS 26.0, *)
final class GlassToolbar: UIView {
    var onTap: ((String, UIView) -> Void)?
    private let glass = UIVisualEffectView(effect: {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = true
        return effect
    }())
    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private var signature = ""

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.translatesAutoresizingMaskIntoConstraints = false
        glass.cornerConfiguration = .capsule()
        addSubview(glass)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        glass.contentView.addSubview(scroll)
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            glass.leadingAnchor.constraint(equalTo: leadingAnchor),
            glass.trailingAnchor.constraint(equalTo: trailingAnchor),
            glass.topAnchor.constraint(equalTo: topAnchor),
            glass.bottomAnchor.constraint(equalTo: bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: glass.contentView.leadingAnchor, constant: 6),
            scroll.trailingAnchor.constraint(equalTo: glass.contentView.trailingAnchor, constant: -6),
            scroll.topAnchor.constraint(equalTo: glass.contentView.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: glass.contentView.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func setItems(_ items: [[String: Any]], tint: UIColor) {
        let sig = "\(items)"
        if sig == signature { return }
        signature = sig
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for item in items {
            if item["sep"] as? Bool == true {
                let line = UIView()
                line.backgroundColor = .separator
                line.translatesAutoresizingMaskIntoConstraints = false
                line.widthAnchor.constraint(equalToConstant: 1).isActive = true
                line.heightAnchor.constraint(equalToConstant: 22).isActive = true
                let wrap = UIView()
                wrap.addSubview(line)
                wrap.translatesAutoresizingMaskIntoConstraints = false
                wrap.widthAnchor.constraint(equalToConstant: 9).isActive = true
                line.centerXAnchor.constraint(equalTo: wrap.centerXAnchor).isActive = true
                line.centerYAnchor.constraint(equalTo: wrap.centerYAnchor).isActive = true
                stack.addArrangedSubview(wrap)
                continue
            }
            let id = item["id"] as? String ?? ""
            let on = item["on"] as? Bool ?? false
            var config = UIButton.Configuration.plain()
            if let symbol = item["symbol"] as? String, let image = UIImage(systemName: symbol) {
                config.image = image
                config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 17, weight: .medium)
            }
            if let title = item["title"] as? String, !title.isEmpty {
                config.title = title
                config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attrs in
                    var a = attrs
                    a.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
                    return a
                }
                config.imagePadding = 4
            }
            config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10)
            config.baseForegroundColor = on ? tint : .label
            config.background.cornerRadius = 12
            config.background.backgroundColor = on ? tint.withAlphaComponent(0.18) : .clear
            let button = UIButton(configuration: config)
            button.accessibilityLabel = item["label"] as? String
            button.isEnabled = !(item["disabled"] as? Bool ?? false)
            button.heightAnchor.constraint(equalToConstant: 40).isActive = true
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
            button.addAction(UIAction { [weak self, weak button] _ in
                guard let button else { return }
                self?.onTap?(id, button)
            }, for: .touchUpInside)
            stack.addArrangedSubview(button)
        }
    }
}

// MARK: - Helpers

extension UIColor {
    convenience init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
}
