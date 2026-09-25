// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Archipelago",
    platforms: [.macOS("15.0")],
    targets: [
        .binaryTarget(name: "GhosttyKit", path: "GhosttyKit.xcframework"),
        .executableTarget(
            name: "Archipelago",
            dependencies: ["GhosttyKit"],
            path: "Sources/Archipelago",
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
        .testTarget(name: "ArchipelagoTests", dependencies: ["Archipelago"], path: "Tests/ArchipelagoTests"),
    ]
)
