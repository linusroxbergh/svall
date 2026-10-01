// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Svall",
    platforms: [.macOS("15.0")],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0"),
    ],
    targets: [
        .binaryTarget(name: "GhosttyKit", path: "GhosttyKit.xcframework"),
        .executableTarget(
            name: "Svall",
            dependencies: ["GhosttyKit", .product(name: "Sparkle", package: "Sparkle")],
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
        // the hook and statusline helper svalld copies into every fleet's hooks folder
        .executableTarget(
            name: "svall-hook",
            path: "Sources/SvallHook",
            // the build links Foundation, which it never calls and which costs every launch a millisecond
            linkerSettings: [.unsafeFlags(["-Xlinker", "-dead_strip_dylibs"])]
        ),
    ]
)
