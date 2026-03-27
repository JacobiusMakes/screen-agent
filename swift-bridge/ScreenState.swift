#!/usr/bin/env swift

/**
 * ScreenState — Swift bridge for macOS screen understanding
 *
 * Extracts the accessibility tree, focused app/window info, and cursor position.
 * Outputs JSON to stdout for the Node.js process to consume.
 *
 * Requires: Accessibility permission (System Settings → Privacy → Accessibility)
 *
 * Usage:
 *   swift ScreenState.swift                    # One-shot state dump
 *   swift ScreenState.swift --watch            # Continuous mode (prints on change)
 *   swift ScreenState.swift --screenshot       # Capture screenshot as base64
 *   swift ScreenState.swift --screenshot-file  # Save screenshot to temp file, print path
 */

import Cocoa
import ApplicationServices
import Foundation

// MARK: - Data Types

struct ScreenElement: Codable {
    let role: String
    let text: String
    let bounds: [Int]  // [x, y, width, height]
    let state: String? // "disabled", "focused", "selected", etc.
}

struct ScreenState: Codable {
    let type: String   // "structural"
    let ts: Int64      // Unix ms
    let app: String
    let title: String
    let pid: Int32
    let cursor: [Int]
    let elements: [ScreenElement]
    let focused: ScreenElement?
    let screenSize: [Int]
}

struct AmbientState: Codable {
    let type: String   // "ambient"
    let ts: Int64
    let app: String
    let title: String
    let cursor: [Int]
}

// MARK: - Accessibility Helpers

func getAXValue<T>(_ element: AXUIElement, _ attribute: String) -> T? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success else { return nil }
    return value as? T
}

func getAXPosition(_ element: AXUIElement) -> CGPoint? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as String as CFString, &value)
    guard result == .success, let val = value else { return nil }
    var point = CGPoint.zero
    AXValueGetValue(val as! AXValue, .cgPoint, &point)
    return point
}

func getAXSize(_ element: AXUIElement) -> CGSize? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as String as CFString, &value)
    guard result == .success, let val = value else { return nil }
    var size = CGSize.zero
    AXValueGetValue(val as! AXValue, .cgSize, &size)
    return size
}

func getBounds(_ element: AXUIElement) -> [Int] {
    let pos = getAXPosition(element) ?? .zero
    let size = getAXSize(element) ?? .zero
    return [Int(pos.x), Int(pos.y), Int(size.width), Int(size.height)]
}

// MARK: - Tree Extraction

func extractElements(_ element: AXUIElement, depth: Int = 0, maxDepth: Int = 6, maxElements: Int = 80) -> [ScreenElement] {
    guard depth < maxDepth else { return [] }

    var results: [ScreenElement] = []

    // Get this element's properties
    let role: String = getAXValue(element, kAXRoleAttribute as String) ?? "unknown"
    let roleDesc: String = getAXValue(element, kAXRoleDescriptionAttribute as String) ?? ""
    let title: String = getAXValue(element, kAXTitleAttribute as String) ?? ""
    let value: String = getAXValue(element, kAXValueAttribute as String) ?? ""
    let desc: String = getAXValue(element, kAXDescriptionAttribute as String) ?? ""

    // Build readable text from available properties
    let text = [title, value, desc].filter { !$0.isEmpty }.joined(separator: " — ")

    // Map AX roles to simpler names
    let simpleRole: String
    switch role {
    case "AXButton": simpleRole = "button"
    case "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField": simpleRole = "textbox"
    case "AXSecureTextField": simpleRole = "password"
    case "AXStaticText": simpleRole = "text"
    case "AXHeading": simpleRole = "heading"
    case "AXLink": simpleRole = "link"
    case "AXCheckBox": simpleRole = "checkbox"
    case "AXRadioButton": simpleRole = "radio"
    case "AXPopUpButton", "AXMenuButton": simpleRole = "dropdown"
    case "AXTabGroup": simpleRole = "tabgroup"
    case "AXTab": simpleRole = "tab"
    case "AXImage": simpleRole = "image"
    case "AXTable", "AXOutline": simpleRole = "table"
    case "AXRow": simpleRole = "row"
    case "AXCell": simpleRole = "cell"
    case "AXToolbar": simpleRole = "toolbar"
    case "AXMenuBar": simpleRole = "menubar"
    case "AXMenu": simpleRole = "menu"
    case "AXMenuItem": simpleRole = "menuitem"
    case "AXScrollArea": simpleRole = "scroll"
    case "AXWebArea": simpleRole = "webarea"
    case "AXGroup": simpleRole = "group"
    case "AXList": simpleRole = "list"
    default: simpleRole = roleDesc.isEmpty ? role.replacingOccurrences(of: "AX", with: "").lowercased() : roleDesc
    }

    // Only include elements with meaningful text or interactive roles
    let interactive = ["button", "textbox", "password", "link", "checkbox", "radio",
                       "dropdown", "tab", "menuitem"].contains(simpleRole)

    if !text.isEmpty || interactive {
        let bounds = getBounds(element)
        // Skip zero-size elements
        if bounds[2] > 0 && bounds[3] > 0 {
            // Check element state
            var stateStr: String? = nil
            let enabled: Bool = getAXValue(element, kAXEnabledAttribute as String) ?? true
            let focused: Bool = getAXValue(element, kAXFocusedAttribute as String) ?? false
            let selected: Bool = getAXValue(element, kAXSelectedAttribute as String) ?? false

            var states: [String] = []
            if !enabled { states.append("disabled") }
            if focused { states.append("focused") }
            if selected { states.append("selected") }
            if !states.isEmpty { stateStr = states.joined(separator: ",") }

            // Truncate long text
            let truncatedText = text.count > 120 ? String(text.prefix(120)) + "..." : text

            results.append(ScreenElement(
                role: simpleRole,
                text: truncatedText,
                bounds: bounds,
                state: stateStr
            ))
        }
    }

    // Recurse into children
    if results.count < maxElements {
        let children: [AXUIElement]? = getAXValue(element, kAXChildrenAttribute as String)
        for child in (children ?? []) {
            if results.count >= maxElements { break }
            results.append(contentsOf: extractElements(child, depth: depth + 1, maxDepth: maxDepth, maxElements: maxElements - results.count))
        }
    }

    return results
}

// MARK: - Focused Element

func getFocusedElement() -> ScreenElement? {
    let systemWide = AXUIElementCreateSystemWide()
    var focusedRef: AnyObject?
    let result = AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &focusedRef)
    guard result == .success, let focused = focusedRef else { return nil }

    let element = focused as! AXUIElement
    let role: String = getAXValue(element, kAXRoleAttribute as String) ?? "unknown"
    let title: String = getAXValue(element, kAXTitleAttribute as String) ?? ""
    let value: String = getAXValue(element, kAXValueAttribute as String) ?? ""
    let text = [title, value].filter { !$0.isEmpty }.joined(separator: " — ")
    let bounds = getBounds(element)

    return ScreenElement(role: role, text: String(text.prefix(200)), bounds: bounds, state: "focused")
}

// MARK: - Full State Capture

func captureState() -> ScreenState? {
    guard let frontApp = NSWorkspace.shared.frontmostApplication else { return nil }

    let appName = frontApp.localizedName ?? "Unknown"
    let pid = frontApp.processIdentifier
    let appRef = AXUIElementCreateApplication(pid)

    // Get window title
    var windowTitle = ""
    let windows: [AXUIElement]? = getAXValue(appRef, kAXWindowsAttribute as String)
    if let firstWindow = windows?.first {
        windowTitle = getAXValue(firstWindow, kAXTitleAttribute as String) ?? ""
    }

    // Cursor position
    let mouseLocation = NSEvent.mouseLocation
    let screenHeight = NSScreen.main?.frame.height ?? 0
    let cursor = [Int(mouseLocation.x), Int(screenHeight - mouseLocation.y)] // flip Y

    // Screen size
    let screenSize = [
        Int(NSScreen.main?.frame.width ?? 0),
        Int(NSScreen.main?.frame.height ?? 0)
    ]

    // Extract accessibility tree from focused window
    var elements: [ScreenElement] = []
    if let firstWindow = windows?.first {
        elements = extractElements(firstWindow, maxDepth: 6, maxElements: 60)
    }

    // Focused element
    let focused = getFocusedElement()

    return ScreenState(
        type: "structural",
        ts: Int64(Date().timeIntervalSince1970 * 1000),
        app: appName,
        title: windowTitle,
        pid: pid,
        cursor: cursor,
        elements: elements,
        focused: focused,
        screenSize: screenSize
    )
}

func captureAmbient() -> AmbientState? {
    guard let frontApp = NSWorkspace.shared.frontmostApplication else { return nil }
    let appRef = AXUIElementCreateApplication(frontApp.processIdentifier)
    let windows: [AXUIElement]? = getAXValue(appRef, kAXWindowsAttribute as String)
    let title: String = windows?.first.flatMap { getAXValue($0, kAXTitleAttribute as String) } ?? ""

    let mouseLocation = NSEvent.mouseLocation
    let screenHeight = NSScreen.main?.frame.height ?? 0

    return AmbientState(
        type: "ambient",
        ts: Int64(Date().timeIntervalSince1970 * 1000),
        app: frontApp.localizedName ?? "Unknown",
        title: title,
        cursor: [Int(mouseLocation.x), Int(screenHeight - mouseLocation.y)]
    )
}

// MARK: - Screenshot

func captureScreenshot() -> String? {
    guard let screen = NSScreen.main else { return nil }
    let rect = CGRect(origin: .zero, size: screen.frame.size)

    guard let image = CGWindowListCreateImage(rect, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]) else {
        return nil
    }

    let bitmap = NSBitmapImageRep(cgImage: image)
    // JPEG at quality 0.6 — good enough for AI, small size
    guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else {
        return nil
    }

    return jpeg.base64EncodedString()
}

func captureScreenshotToFile() -> String? {
    guard let screen = NSScreen.main else { return nil }
    let rect = CGRect(origin: .zero, size: screen.frame.size)

    guard let image = CGWindowListCreateImage(rect, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]) else {
        return nil
    }

    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else {
        return nil
    }

    let tempDir = NSTemporaryDirectory()
    let filename = "screenagent-\(Int(Date().timeIntervalSince1970)).jpg"
    let path = (tempDir as NSString).appendingPathComponent(filename)

    do {
        try jpeg.write(to: URL(fileURLWithPath: path))
        return path
    } catch {
        return nil
    }
}

// MARK: - Main

let encoder = JSONEncoder()
encoder.outputFormatting = .sortedKeys

let args = CommandLine.arguments

if args.contains("--screenshot") {
    // Output base64 screenshot
    if let b64 = captureScreenshot() {
        let obj: [String: Any] = [
            "type": "screenshot",
            "ts": Int64(Date().timeIntervalSince1970 * 1000),
            "format": "jpeg",
            "quality": 0.6,
            "image": b64
        ]
        if let data = try? JSONSerialization.data(withJSONObject: obj),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
    } else {
        fputs("Error: screenshot failed. Grant Screen Recording permission.\n", stderr)
        exit(1)
    }
} else if args.contains("--screenshot-file") {
    if let path = captureScreenshotToFile() {
        print(path)
    } else {
        fputs("Error: screenshot failed.\n", stderr)
        exit(1)
    }
} else if args.contains("--ambient") {
    // Lightweight ambient state
    if let state = captureAmbient(), let data = try? encoder.encode(state), let str = String(data: data, encoding: .utf8) {
        print(str)
    }
} else if args.contains("--watch") {
    // Continuous mode: print state every 2 seconds + on significant changes
    var lastApp = ""
    var lastTitle = ""

    while true {
        if let state = captureState(), let data = try? encoder.encode(state), let str = String(data: data, encoding: .utf8) {
            // Only print if something changed
            if state.app != lastApp || state.title != lastTitle {
                print(str)
                fflush(stdout)
                lastApp = state.app
                lastTitle = state.title
            }
        }
        Thread.sleep(forTimeInterval: 2.0)
    }
} else {
    // One-shot: capture and print full state
    if let state = captureState(), let data = try? encoder.encode(state), let str = String(data: data, encoding: .utf8) {
        print(str)
    } else {
        fputs("Error: could not capture screen state. Grant Accessibility permission.\n", stderr)
        exit(1)
    }
}
