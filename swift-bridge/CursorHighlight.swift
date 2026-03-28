#!/usr/bin/env swift

/**
 * CursorHighlight — Transparent overlay for cursor visual effects
 *
 * Long-running process that draws subtle animations at cursor positions
 * when the screen agent moves/clicks. Controlled via JSON-line stdin.
 *
 * Commands (one JSON object per line on stdin):
 *   {"action":"move","from":[x1,y1],"to":[x2,y2]}
 *   {"action":"click","at":[x,y],"button":"left"}
 *   {"action":"click","at":[x,y],"button":"right"}
 *   {"action":"click","at":[x,y],"button":"double"}
 *   {"action":"hide"}
 *   {"action":"quit"}
 *
 * Visual effects:
 *   - Move: soft glow at origin + thin arc trail to destination
 *   - Click: concentric ripple expanding outward
 *   - Double-click: two rapid ripples
 *   - Right-click: blue-tinted ripple
 */

import Cocoa
import QuartzCore

// MARK: - Colors

struct HighlightColors {
    static let amber = NSColor(red: 1.0, green: 0.75, blue: 0.2, alpha: 1.0)
    static let amberGlow = NSColor(red: 1.0, green: 0.75, blue: 0.2, alpha: 0.4)
    static let blue = NSColor(red: 0.4, green: 0.6, blue: 1.0, alpha: 1.0)
    static let blueGlow = NSColor(red: 0.4, green: 0.6, blue: 1.0, alpha: 0.35)
}

// MARK: - Overlay Window

class OverlayWindow: NSWindow {
    init() {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        super.init(
            contentRect: screen.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        self.level = .screenSaver
        self.backgroundColor = .clear
        self.isOpaque = false
        self.hasShadow = false
        self.ignoresMouseEvents = true
        self.collectionBehavior = [.canJoinAllSpaces, .stationary]

        let view = NSView(frame: screen.frame)
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.clear.cgColor
        self.contentView = view
    }
}

// MARK: - Effect Renderer

class EffectRenderer {
    let rootLayer: CALayer
    let screenHeight: CGFloat

    init(layer: CALayer) {
        self.rootLayer = layer
        self.screenHeight = NSScreen.main?.frame.height ?? 900
    }

    /// Convert top-left origin (screen coords) to bottom-left origin (Cocoa coords)
    func cocoaPoint(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        return CGPoint(x: x, y: screenHeight - y)
    }

    // ── Ripple Effect (click) ──

    func ripple(at point: CGPoint, color: NSColor, startRadius: CGFloat = 8, endRadius: CGFloat = 36, duration: CFTimeInterval = 0.35) {
        let p = cocoaPoint(point.x, point.y)
        let layer = CAShapeLayer()
        let startPath = CGPath(ellipseIn: CGRect(
            x: p.x - startRadius, y: p.y - startRadius,
            width: startRadius * 2, height: startRadius * 2
        ), transform: nil)
        let endPath = CGPath(ellipseIn: CGRect(
            x: p.x - endRadius, y: p.y - endRadius,
            width: endRadius * 2, height: endRadius * 2
        ), transform: nil)

        layer.path = startPath
        layer.fillColor = nil
        layer.strokeColor = color.cgColor
        layer.lineWidth = 2.5
        layer.opacity = 0.6
        rootLayer.addSublayer(layer)

        // Path expansion
        let pathAnim = CABasicAnimation(keyPath: "path")
        pathAnim.fromValue = startPath
        pathAnim.toValue = endPath
        pathAnim.duration = duration
        pathAnim.timingFunction = CAMediaTimingFunction(name: .easeOut)

        // Fade out
        let fadeAnim = CABasicAnimation(keyPath: "opacity")
        fadeAnim.fromValue = 0.6
        fadeAnim.toValue = 0.0
        fadeAnim.duration = duration
        fadeAnim.timingFunction = CAMediaTimingFunction(name: .easeIn)

        // Width thinning
        let widthAnim = CABasicAnimation(keyPath: "lineWidth")
        widthAnim.fromValue = 2.5
        widthAnim.toValue = 0.5
        widthAnim.duration = duration

        let group = CAAnimationGroup()
        group.animations = [pathAnim, fadeAnim, widthAnim]
        group.duration = duration
        group.isRemovedOnCompletion = false
        group.fillMode = .forwards

        CATransaction.begin()
        CATransaction.setCompletionBlock { layer.removeFromSuperlayer() }
        layer.add(group, forKey: "ripple")
        CATransaction.commit()
    }

    // ── Glow Effect (move origin) ──

    func glow(at point: CGPoint, color: NSColor, radius: CGFloat = 12, duration: CFTimeInterval = 0.3) {
        let p = cocoaPoint(point.x, point.y)
        let layer = CAShapeLayer()
        let path = CGPath(ellipseIn: CGRect(
            x: p.x - radius, y: p.y - radius,
            width: radius * 2, height: radius * 2
        ), transform: nil)

        layer.path = path
        layer.fillColor = color.withAlphaComponent(0.35).cgColor
        layer.strokeColor = nil
        layer.opacity = 1.0

        // Soft shadow for glow effect
        layer.shadowColor = color.cgColor
        layer.shadowRadius = 8
        layer.shadowOpacity = 0.5
        layer.shadowOffset = .zero

        rootLayer.addSublayer(layer)

        // Scale up slightly then fade
        let scaleAnim = CABasicAnimation(keyPath: "transform.scale")
        scaleAnim.fromValue = 0.6
        scaleAnim.toValue = 1.2
        scaleAnim.duration = duration * 0.4

        let fadeAnim = CABasicAnimation(keyPath: "opacity")
        fadeAnim.fromValue = 1.0
        fadeAnim.toValue = 0.0
        fadeAnim.duration = duration
        fadeAnim.beginTime = duration * 0.2
        fadeAnim.timingFunction = CAMediaTimingFunction(name: .easeIn)

        let group = CAAnimationGroup()
        group.animations = [scaleAnim, fadeAnim]
        group.duration = duration * 1.2
        group.isRemovedOnCompletion = false
        group.fillMode = .forwards

        CATransaction.begin()
        CATransaction.setCompletionBlock { layer.removeFromSuperlayer() }
        layer.add(group, forKey: "glow")
        CATransaction.commit()
    }

    // ── Arc Trail (move path) ──

    func trail(from start: CGPoint, to end: CGPoint, color: NSColor, duration: CFTimeInterval = 0.4) {
        let p1 = cocoaPoint(start.x, start.y)
        let p2 = cocoaPoint(end.x, end.y)

        // Bezier control point — offset perpendicular to the line for a subtle arc
        let midX = (p1.x + p2.x) / 2
        let midY = (p1.y + p2.y) / 2
        let dx = p2.x - p1.x
        let dy = p2.y - p1.y
        let dist = sqrt(dx * dx + dy * dy)
        let arcOffset = min(dist * 0.15, 30) // subtle arc, max 30px
        let control = CGPoint(x: midX - dy / dist * arcOffset, y: midY + dx / dist * arcOffset)

        let path = CGMutablePath()
        path.move(to: p1)
        path.addQuadCurve(to: p2, control: control)

        let layer = CAShapeLayer()
        layer.path = path
        layer.fillColor = nil
        layer.strokeColor = color.withAlphaComponent(0.35).cgColor
        layer.lineWidth = 2.0
        layer.lineCap = .round
        layer.opacity = 1.0
        rootLayer.addSublayer(layer)

        // Draw-on animation
        let drawAnim = CABasicAnimation(keyPath: "strokeEnd")
        drawAnim.fromValue = 0.0
        drawAnim.toValue = 1.0
        drawAnim.duration = duration * 0.6
        drawAnim.timingFunction = CAMediaTimingFunction(name: .easeOut)

        // Fade out
        let fadeAnim = CABasicAnimation(keyPath: "opacity")
        fadeAnim.fromValue = 1.0
        fadeAnim.toValue = 0.0
        fadeAnim.duration = duration * 0.5
        fadeAnim.beginTime = duration * 0.5
        fadeAnim.timingFunction = CAMediaTimingFunction(name: .easeIn)

        let group = CAAnimationGroup()
        group.animations = [drawAnim, fadeAnim]
        group.duration = duration
        group.isRemovedOnCompletion = false
        group.fillMode = .forwards

        CATransaction.begin()
        CATransaction.setCompletionBlock { layer.removeFromSuperlayer() }
        layer.add(group, forKey: "trail")
        CATransaction.commit()
    }
}

// MARK: - Command Parsing

struct MoveCommand: Decodable {
    let action: String
    let from: [CGFloat]?
    let to: [CGFloat]?
    let at: [CGFloat]?
    let button: String?
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: OverlayWindow!
    var renderer: EffectRenderer!
    var hideTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = OverlayWindow()
        window.orderFront(nil)
        renderer = EffectRenderer(layer: window.contentView!.layer!)

        // Read stdin on background queue
        DispatchQueue.global(qos: .userInteractive).async { [weak self] in
            self?.readStdin()
        }

        // Signal ready
        fputs("ready\n", stderr)
    }

    func readStdin() {
        let decoder = JSONDecoder()

        while let line = readLine() {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }

            guard let data = trimmed.data(using: .utf8),
                  let cmd = try? decoder.decode(MoveCommand.self, from: data) else {
                continue
            }

            DispatchQueue.main.async { [weak self] in
                self?.handleCommand(cmd)
            }
        }

        // stdin closed — exit
        DispatchQueue.main.async {
            NSApplication.shared.terminate(nil)
        }
    }

    func handleCommand(_ cmd: MoveCommand) {
        resetHideTimer()

        switch cmd.action {
        case "move":
            guard let from = cmd.from, from.count >= 2,
                  let to = cmd.to, to.count >= 2 else { return }
            let fromPt = CGPoint(x: from[0], y: from[1])
            let toPt = CGPoint(x: to[0], y: to[1])

            renderer.glow(at: fromPt, color: HighlightColors.amber)
            renderer.trail(from: fromPt, to: toPt, color: HighlightColors.amber)
            renderer.ripple(at: toPt, color: HighlightColors.amber, startRadius: 4, endRadius: 20, duration: 0.25)

        case "click":
            guard let at = cmd.at, at.count >= 2 else { return }
            let pt = CGPoint(x: at[0], y: at[1])
            let button = cmd.button ?? "left"

            switch button {
            case "right":
                renderer.ripple(at: pt, color: HighlightColors.blue)
            case "double":
                renderer.ripple(at: pt, color: HighlightColors.amber, startRadius: 6, endRadius: 30, duration: 0.25)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                    self?.renderer.ripple(at: pt, color: HighlightColors.amber, startRadius: 10, endRadius: 42, duration: 0.3)
                }
            default:
                renderer.ripple(at: pt, color: HighlightColors.amber)
            }

        case "hide":
            clearAllEffects()

        case "quit":
            NSApplication.shared.terminate(nil)

        default:
            break
        }
    }

    func resetHideTimer() {
        hideTimer?.invalidate()
        window.orderFront(nil)
        hideTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: false) { [weak self] _ in
            self?.clearAllEffects()
        }
    }

    func clearAllEffects() {
        window.contentView?.layer?.sublayers?.forEach { $0.removeFromSuperlayer() }
    }
}

// MARK: - Main

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // No dock icon, no menu bar
let delegate = AppDelegate()
app.delegate = delegate
app.run()
