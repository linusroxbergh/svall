// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Svall",
    platforms: [.macOS("15.0")],
    targets: [
        .binaryTarget(name: "GhosttyKit", path: "GhosttyKit.xcframework"),
        .executableTarget(
            name: "Svall",
            dependencies: ["GhosttyKit"],
            path: "Sources/Svall",
            linkerSettings: [
                .linkedLibrary("c++"),
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("Carbon"),
                .linkedFramework("Metal"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("IOSurface"),
                .linkedFramework("UniformTypeIdentifiers"),
                .linkedFramework("UserNotifications"),
            ]
        ),
    ]
)
