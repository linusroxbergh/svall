import Foundation

struct ShellError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
