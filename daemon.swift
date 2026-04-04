import Cocoa
import Foundation
import CoreGraphics

// TerminalIN Daemon — high-performance window management
// Commands: list, move, raise
// Protocol: JSON lines on stdin/stdout

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ windowID: UnsafeMutablePointer<CGWindowID>) -> AXError

let terminalApps: Set<String> = ["Terminal", "ターミナル", "iTerm2", "Alacritty", "Warp", "kitty", "Hyper", "WezTerm"]

// ── AX cache: per-batch, avoids redundant AX queries ──
var appCache: [pid_t: [AXUIElement]] = [:]

func clearCache() { appCache.removeAll(keepingCapacity: true) }

func getWindows(pid: pid_t) -> [AXUIElement]? {
    if let cached = appCache[pid] { return cached }
    let ref = AXUIElementCreateApplication(pid)
    var val: CFTypeRef?
    guard AXUIElementCopyAttributeValue(ref, kAXWindowsAttribute as CFString, &val) == .success,
          let wins = val as? [AXUIElement] else { return nil }
    appCache[pid] = wins
    return wins
}

func findAXWindow(pid: pid_t, wn: Int) -> AXUIElement? {
    guard let wins = getWindows(pid: pid) else { return nil }
    let target = CGWindowID(wn)
    for w in wins {
        var wid: CGWindowID = 0
        if _AXUIElementGetWindow(w, &wid) == .success, wid == target { return w }
    }
    return nil
}

// ── list: CGWindowList (fast, no AX) ──
func handleList() -> [[String: Any]] {
    guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    var results: [[String: Any]] = []
    results.reserveCapacity(20)
    for w in infos {
        guard let app = w[kCGWindowOwnerName as String] as? String,
              terminalApps.contains(app),
              let b = w[kCGWindowBounds as String] as? [String: CGFloat],
              let x = b["X"], let y = b["Y"], let bw = b["Width"], let bh = b["Height"],
              bw > 50, bh > 50 else { continue }
        results.append([
            "app": app,
            "title": w[kCGWindowName as String] as? String ?? "",
            "windowNumber": w[kCGWindowNumber as String] as? Int ?? 0,
            "pid": w[kCGWindowOwnerPID as String] as? Int ?? 0,
            "x": Int(x), "y": Int(y), "width": Int(bw), "height": Int(bh),
        ])
    }
    return results
}

// ── move: batch AX position+size ──
func handleMove(_ windows: [[String: Any]]) -> [String: Int] {
    clearCache()
    var moved = 0
    for cmd in windows {
        guard let pid = (cmd["pid"] as? Int).map({ pid_t($0) }),
              let wn = cmd["windowNumber"] as? Int,
              let x = cmd["x"] as? Double, let y = cmd["y"] as? Double,
              let w = cmd["width"] as? Double, let h = cmd["height"] as? Double,
              let ax = findAXWindow(pid: pid, wn: wn) else { continue }
        var pt = CGPoint(x: x, y: y)
        var sz = CGSize(width: w, height: h)
        if let v = AXValueCreate(.cgPoint, &pt) { AXUIElementSetAttributeValue(ax, kAXPositionAttribute as CFString, v) }
        if let v = AXValueCreate(.cgSize, &sz) { AXUIElementSetAttributeValue(ax, kAXSizeAttribute as CFString, v) }
        moved += 1
    }
    return ["moved": moved]
}

// ── raise: activate app + AXRaise specific windows by CGWindowID ──
func handleRaise(_ windows: [[String: Any]]) -> [String: Int] {
    clearCache()
    // Group by PID for single activate per app
    var byPid: [pid_t: [Int]] = [:]
    for cmd in windows {
        guard let pid = (cmd["pid"] as? Int).map({ pid_t($0) }),
              let wn = cmd["windowNumber"] as? Int else { continue }
        byPid[pid, default: []].append(wn)
    }
    var raised = 0
    for (pid, wns) in byPid {
        // Activate app — brings its window layer forward
        NSRunningApplication(processIdentifier: pid)?.activate()
        guard let axWins = getWindows(pid: pid) else { continue }
        // Build CGWindowID → AXUIElement lookup
        var idMap: [CGWindowID: AXUIElement] = [:]
        idMap.reserveCapacity(axWins.count)
        for ax in axWins {
            var wid: CGWindowID = 0
            if _AXUIElementGetWindow(ax, &wid) == .success { idMap[wid] = ax }
        }
        // AXRaise in reverse so first in list = topmost
        for wn in wns.reversed() {
            if let ax = idMap[CGWindowID(wn)] {
                AXUIElementPerformAction(ax, kAXRaiseAction as CFString)
                raised += 1
            }
        }
    }
    return ["raised": raised]
}

// ── Main loop ──
setbuf(stdout, nil)

func writeJSON(_ obj: Any) {
    if let d = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: d, encoding: .utf8) { print(s) }
}

writeJSON(["ready": true])

while let line = readLine() {
    guard !line.isEmpty,
          let data = line.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = json["cmd"] as? String else { continue }
    let reqId = json["id"] as? String ?? ""
    let result: Any
    switch cmd {
    case "list":  result = handleList()
    case "move":  result = handleMove(json["windows"] as? [[String: Any]] ?? [])
    case "raise": result = handleRaise(json["windows"] as? [[String: Any]] ?? [])
    default:      result = ["error": "unknown"]
    }
    writeJSON(["id": reqId, "result": result])
}
