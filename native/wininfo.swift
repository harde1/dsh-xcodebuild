// wininfo — the one thing a shell cannot do: name a window and type into it.
//
// The panel mirrors another macOS app (Lookin) and forwards clicks back into it.
// Both halves need CoreGraphics, and neither has a command-line equivalent:
//
//   - `screencapture -l<windowid>` needs a CGWindowID, and the only way to learn one is
//     `CGWindowListCopyWindowInfo`. `osascript` is not an alternative: System Events gives
//     window bounds but never a window id, and it wants the *Accessibility* grant, while the
//     capture wants *Screen Recording* — two permissions for one number.
//   - A forwarded click is `CGEventPostToPid`. Nothing in the shell posts events at all.
//
// So this ships as source and is compiled on demand (see buildHelper in lib/macos-window.js):
// a prebuilt binary in a public plugin would be an unsigned blob nobody can read, and a wrong
// one for the architecture it lands on.
//
// Coordinate space, because getting this wrong is silent: every point this program takes or
// prints is a GLOBAL DISPLAY POINT with the origin at the top-left of the main display — the
// space `CGWindowListCopyWindowInfo` reports bounds in, and the space `CGEvent` posts in. The
// captured JPEG, by contrast, is in PIXELS at the backing scale (2x on Retina), which is why
// the caller maps a click through the window's *fraction*, never through pixels.
//
// Usage:
//   wininfo list [--pid <pid>]     pid \t id \t x \t y \t w \t h \t layer \t owner \t title
//   wininfo status                 accessibility=0|1 screenCapture=0|1 frontmostPid=<pid>
//   wininfo activate <pid>         bring that app forward
//   wininfo click <pid> <x> <y>    left mouse down + up at that global point
//   wininfo move <pid> <x> <y>     mouse moved there with no button
//   wininfo drag <pid> <x1> <y1> <x2> <y2>
//   wininfo scroll <pid> <x> <y> <dx> <dy>
//
// `<pid>` may be `-` to post at the system level (whatever is frontmost receives it) instead
// of to one process. The distinction is the whole reason this works while the panel has
// focus: posting to a pid does not require the target's window to be frontmost, and a
// system-level post would land on the Harness window the user is actually looking at.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Print to stdout and stop with a non-zero status; the caller reads the message.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

/// A number from the command line, or a clear failure instead of a silent zero.
func number(_ text: String) -> Double {
    guard let value = Double(text) else { fail("not a number: \(text)") }
    return value
}

/// The pid argument: `-` means "post at the system level", which is `nil`.
func targetPid(_ text: String) -> pid_t? {
    if text == "-" { return nil }
    guard let value = Int32(text) else { fail("not a pid: \(text)") }
    return value
}

/// Every window on screen, in front-to-back order, as one tab-separated line each.
///
/// Order matters to the caller: the first window of a pid is the one the app would call its
/// front window, which is the one worth mirroring. Tabs are stripped from titles so a line
/// stays one line.
func listWindows(pidFilter: pid_t?) {
    let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        fail("CGWindowListCopyWindowInfo returned nothing")
    }
    for window in raw {
        let pid = window[kCGWindowOwnerPID as String] as? pid_t ?? 0
        if let wanted = pidFilter, wanted != pid { continue }
        let id = window[kCGWindowNumber as String] as? Int ?? 0
        let layer = window[kCGWindowLayer as String] as? Int ?? 0
        let owner = window[kCGWindowOwnerName as String] as? String ?? ""
        // Without the Screen Recording grant this key is absent for other apps' windows, which
        // is how `status` is answered without asking the system twice.
        let title = window[kCGWindowName as String] as? String ?? ""
        let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
        let x = bounds["X"] as? Double ?? 0
        let y = bounds["Y"] as? Double ?? 0
        let w = bounds["Width"] as? Double ?? 0
        let h = bounds["Height"] as? Double ?? 0
        let clean = { (text: String) in text.replacingOccurrences(of: "\t", with: " ") }
        print("\(pid)\t\(id)\t\(Int(x))\t\(Int(y))\t\(Int(w))\t\(Int(h))\t\(layer)\t\(clean(owner))\t\(clean(title))")
    }
}

/// What this program is allowed to do, so the panel can say why a click did nothing.
///
/// `AXIsProcessTrusted` answers for the Accessibility grant, which is what posting to another
/// process needs and what macOS grants per *responsible* process — so a false answer here
/// usually means the Harness app itself has not been granted, not that this binary is
/// unsigned. `CGPreflightScreenCaptureAccess` is the same for screen capture; it is reported
/// for completeness, since a mirror that lists no windows at all is the symptom the panel
/// actually sees.
func printStatus() {
    let trusted = AXIsProcessTrusted() ? 1 : 0
    let capture = CGPreflightScreenCaptureAccess() ? 1 : 0
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    print("accessibility=\(trusted) screenCapture=\(capture) frontmostPid=\(front)")
}

/// Bring an app forward, so a forwarded click lands on a window the app considers active.
///
/// No `activateIgnoringOtherApps`: it was deprecated in macOS 14 and does nothing there, and
/// focus stealing is now the system's decision. Posting to a pid does not need this at all —
/// it is here for the case where the app's own window must be the active one to respond.
func activate(pid: pid_t) {
    guard let app = NSRunningApplication(processIdentifier: pid) else { fail("no such pid: \(pid)") }
    app.activate()
}

/// Post one event either to a process or to the system.
func post(_ event: CGEvent?, to pid: pid_t?) {
    guard let event else { fail("could not create the event") }
    if let pid {
        event.postToPid(pid)
    } else {
        event.post(tap: .cghidEventTap)
    }
}

/// A mouse event at a global point.
func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, clicks: Int64 = 1) -> CGEvent? {
    let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)
    // Click state is what turns a down+up pair into a click rather than two stray events, and
    // what makes a second click a double-click; AppKit reads it, so it has to be set.
    event?.setIntegerValueField(.mouseEventClickState, value: clicks)
    return event
}

/// Down and up at one point: a click.
func click(pid: pid_t?, x: Double, y: Double) {
    let point = CGPoint(x: x, y: y)
    post(mouse(.mouseMoved, point, .left), to: pid)
    post(mouse(.leftMouseDown, point, .left), to: pid)
    // A real click is never instantaneous, and an app that measures the press can ignore a
    // zero-length one. 40ms is below perception and above any threshold AppKit applies.
    usleep(40_000)
    post(mouse(.leftMouseUp, point, .left), to: pid)
}

/// Move with no button held — what hovering does, and what makes a menu highlight.
func move(pid: pid_t?, x: Double, y: Double) {
    post(mouse(.mouseMoved, CGPoint(x: x, y: y), .left), to: pid)
}

/// Press, travel, release. The dragged events in between are not decoration: an app that only
/// sees down and up at distant points reads it as a click, not a drag.
func drag(pid: pid_t?, x1: Double, y1: Double, x2: Double, y2: Double) {
    let from = CGPoint(x: x1, y: y1)
    let to = CGPoint(x: x2, y: y2)
    post(mouse(.mouseMoved, from, .left), to: pid)
    post(mouse(.leftMouseDown, from, .left), to: pid)
    let steps = 8
    for step in 1...steps {
        let t = Double(step) / Double(steps)
        let point = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        post(mouse(.leftMouseDragged, point, .left), to: pid)
        usleep(8_000)
    }
    post(mouse(.leftMouseUp, to, .left), to: pid)
}

/// A wheel event at a point. `dy` positive scrolls down, which is what the panel sends when the
/// user scrolls the mirror the way they scroll a page.
func scroll(pid: pid_t?, x: Double, y: Double, dx: Double, dy: Double) {
    post(mouse(.mouseMoved, CGPoint(x: x, y: y), .left), to: pid)
    // Pixel units: line units are multiplied by the system's scroll speed, so the same number
    // would travel a different distance on another machine.
    let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)
    if let event {
        event.location = CGPoint(x: x, y: y)
    }
    post(event, to: pid)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else {
    fail("usage: wininfo list|status|activate|click|move|drag|scroll ...")
}

switch command {
case "list":
    var filter: pid_t? = nil
    if let index = arguments.firstIndex(of: "--pid"), index + 1 < arguments.count {
        filter = targetPid(arguments[index + 1])
    }
    listWindows(pidFilter: filter)
case "status":
    printStatus()
case "activate":
    guard arguments.count >= 2 else { fail("activate needs a pid") }
    // Activation names one app, so `-` is not accepted here: there is nothing to bring forward.
    guard let pid = targetPid(arguments[1]) else { fail("activate needs a real pid, not -") }
    activate(pid: pid)
case "click":
    guard arguments.count >= 4 else { fail("click needs a pid and a point") }
    click(pid: targetPid(arguments[1]), x: number(arguments[2]), y: number(arguments[3]))
case "move":
    guard arguments.count >= 4 else { fail("move needs a pid and a point") }
    move(pid: targetPid(arguments[1]), x: number(arguments[2]), y: number(arguments[3]))
case "drag":
    guard arguments.count >= 6 else { fail("drag needs a pid and two points") }
    drag(pid: targetPid(arguments[1]), x1: number(arguments[2]), y1: number(arguments[3]), x2: number(arguments[4]), y2: number(arguments[5]))
case "scroll":
    guard arguments.count >= 6 else { fail("scroll needs a pid, a point and a delta") }
    scroll(pid: targetPid(arguments[1]), x: number(arguments[2]), y: number(arguments[3]), dx: number(arguments[4]), dy: number(arguments[5]))
default:
    fail("unknown command: \(command)")
}
