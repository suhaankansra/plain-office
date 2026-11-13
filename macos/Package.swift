// swift-tools-version:5.10
// Plain Office for Mac: a native AppKit window (real Liquid Glass toolbar,
// sidebar and formatting bar on macOS 26+) around the Plain Office web app.
// Build the app bundle with ./build.sh (it builds the web app first).
import PackageDescription

let package = Package(
    name: "PlainOffice",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "PlainOffice", path: "Sources/PlainOffice"),
    ]
)
