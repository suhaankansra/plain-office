// Opens Apple's own document scanner, the one in the Files and Notes apps
// (VisionKit). It finds the page edges, straightens and cleans up the pages on
// the phone, and hands back one picture per page, saved here as JPEGs in the
// app's temporary folder.

import UIKit
import VisionKit
import Capacitor

public class DocScannerPlugin: CAPPlugin, CAPBridgedPlugin, VNDocumentCameraViewControllerDelegate {
    public let identifier = "DocScannerPlugin"
    public let jsName = "DocScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
    ]

    private var pending: CAPPluginCall?

    private var folder: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("scans", isDirectory: true)
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        // Not available in the Simulator or on devices without a camera.
        call.resolve(["available": VNDocumentCameraViewController.isSupported])
    }

    @objc func scan(_ call: CAPPluginCall) {
        guard VNDocumentCameraViewController.isSupported else {
            call.reject("The phone's document scanner isn't available", "UNAVAILABLE")
            return
        }
        guard pending == nil else {
            call.reject("A scan is already open")
            return
        }
        DispatchQueue.main.async {
            guard let top = self.topViewController() else {
                call.reject("The phone's document scanner isn't available", "UNAVAILABLE")
                return
            }
            // Old scans from earlier sessions are no longer needed.
            try? FileManager.default.removeItem(at: self.folder)
            self.pending = call
            let camera = VNDocumentCameraViewController()
            camera.delegate = self
            top.present(camera, animated: true)
        }
    }

    private func topViewController() -> UIViewController? {
        var top = bridge?.viewController?.view.window?.rootViewController ?? bridge?.viewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    private func finish(_ controller: VNDocumentCameraViewController, _ result: () -> Void) {
        controller.dismiss(animated: true)
        result()
        pending = nil
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
        let call = pending
        finish(controller) {
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let stamp = Int(Date().timeIntervalSince1970 * 1000)
                var pages: [String] = []
                for i in 0..<scan.pageCount {
                    guard let data = scan.imageOfPage(at: i).jpegData(compressionQuality: 0.9) else { continue }
                    let url = folder.appendingPathComponent("scan-\(stamp)-\(i).jpg")
                    try data.write(to: url)
                    pages.append(url.absoluteString)
                }
                call?.resolve(["pages": pages])
            } catch {
                call?.reject("Could not save the scanned pages", nil, error)
            }
        }
    }

    public func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        let call = pending
        finish(controller) { call?.resolve(["pages": []]) }
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
        let call = pending
        finish(controller) { call?.reject("The scanner stopped: \(error.localizedDescription)", nil, error) }
    }
}
