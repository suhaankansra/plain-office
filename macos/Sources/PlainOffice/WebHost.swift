import AppKit
import UniformTypeIdentifiers
import WebKit

// The web view that runs the Plain Office web app. Its files come from inside
// the app bundle (Contents/Resources/web) through a private plainoffice://
// address, so nothing is ever loaded from the internet.
@MainActor
final class WebHost: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let webView: WKWebView
    private let files: AppFiles
    private var loaded = false
    private var pending: [URL] = []
    private var downloads: [ObjectIdentifier: URL] = [:]

    override init() {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        files = AppFiles(root: Bundle.main.resourceURL!.appendingPathComponent("web"))
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // documents are kept between launches
        config.setURLSchemeHandler(files, forURLScheme: AppFiles.scheme)
        // Tell the page it is in the Mac app before any of its code runs.
        config.userContentController.addUserScript(WKUserScript(
            source: "window.plainOfficeHost = Object.freeze({ os: 'macos', version: '\(version)' });",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        let debug = ProcessInfo.processInfo.environment["PLAIN_OFFICE_DEBUG"] != nil
        if #available(macOS 13.3, *) { webView.isInspectable = debug }
        // Debugging only: keep drawing while the window is covered (for screenshots in tests).
        let keepDrawing = Selector(("_setWindowOcclusionDetectionEnabled:"))
        if debug, webView.responds(to: keepDrawing) { webView.perform(keepDrawing, with: false) }
    }

    func addMessageHandler(_ handler: WKScriptMessageHandlerWithReply, name: String) {
        webView.configuration.userContentController.addScriptMessageHandler(handler, contentWorld: .page, name: name)
    }

    func start() {
        webView.load(URLRequest(url: URL(string: "\(AppFiles.scheme)://app/index.html")!))
    }

    // ---------- Talking to the page ----------

    func run(_ body: String, _ arguments: [String: Any] = [:], done: ((Any?) -> Void)? = nil) {
        webView.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { result in
            if case .success(let value) = result { done?(value) } else { done?(nil) }
        }
    }

    // A file from Finder: hand its bytes to the page (window.plainOffice in src/main.js).
    func open(_ url: URL) {
        guard loaded else { pending.append(url); return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            let alert = NSAlert()
            alert.messageText = "Could not open “\(url.lastPathComponent)”"
            alert.informativeText = "Plain Office doesn't have permission to read it, or it was moved."
            alert.runModal()
            return
        }
        run("window.plainOffice?.open(b64, name)", ["b64": data.base64EncodedString(), "name": url.lastPathComponent])
    }

    func command(_ id: String, done: ((Bool) -> Void)? = nil) {
        run("return (await window.plainOffice?.command(id)) === true", ["id": id]) { value in
            done?((value as? Bool) ?? (value as? NSNumber)?.boolValue ?? false)
        }
    }

    // ---------- Navigation: stay inside the app ----------

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        switch url.scheme {
        case AppFiles.scheme, "blob", "data", "about":
            decisionHandler(.allow)
        case "http", "https", "mailto":
            // Links inside documents open in the person's browser, never in the app.
            if action.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        default:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        let waiting = pending
        pending = []
        waiting.forEach(open)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loaded = false
        webView.reload()
    }

    // target="_blank" links: open web links in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    // ---------- Saving: "Save a copy" shows the Mac's Save dialog ----------

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        let ext = (suggestedFilename as NSString).pathExtension
        if !ext.isEmpty, let type = UTType(filenameExtension: ext) { panel.allowedContentTypes = [type]; panel.allowsOtherFileTypes = true }
        guard let window = webView.window else { return completionHandler(nil) }
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let url = panel.url else { return completionHandler(nil) }
            try? FileManager.default.removeItem(at: url) // the panel already asked about replacing it
            self.downloads[ObjectIdentifier(download)] = url
            completionHandler(url)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        run("window.plainOffice?.saved(name)", ["name": url.lastPathComponent])
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard let url = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let alert = NSAlert(error: error)
        alert.messageText = "Could not save “\(url.lastPathComponent)”"
        if let window = webView.window { alert.beginSheetModal(for: window) } else { alert.runModal() }
    }

    // ---------- Open dialog and simple alerts ----------

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        guard let window = webView.window else { return completionHandler(nil) }
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
}

// Serves the web app's files from the app bundle, and nothing else.
@MainActor
final class AppFiles: NSObject, WKURLSchemeHandler {
    static let scheme = "plainoffice"
    private let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!)
            task.didFinish()
            return
        }
        let headers = ["Content-Type": Self.mimeType(file.pathExtension), "Content-Length": String(data.count), "Cache-Control": "no-cache"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    static func mimeType(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "webmanifest": return "application/manifest+json"
        case "svg": return "image/svg+xml"
        case "wasm": return "application/wasm"
        default: return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
