import Cocoa
import Foundation
import CoreGraphics

// TerminalIN Daemon — long-running process that handles:
// - list: enumerate terminal windows via CGWindowList
// - move: reposition windows via AXUIElement
//
// Protocol: JSON lines on stdin → JSON lines on stdout

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ windowID: UnsafeMutablePointer<CGWindowID>) -> AXError

let terminalApps = Set(["Terminal", "ターミナル", "iTerm2", "Alacritty", "Warp", "kitty", "Hyper", "WezTerm"])

var appCache: [pid_t: (ref: AXUIElement, windows: [AXUIElement])] = [:]
func clearCache() { appCache.removeAll() }

func getApp(pid: pid_t?, name: String?) -> (ref: AXUIElement, windows: [AXUIElement])? {
    if let pid = pid {
        if let cached = appCache[pid] { return cached }
        let ref = AXUIElementCreateApplication(pid)
        var windowsRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ref, kAXWindowsAttribute as CFString, &windowsRef) == .success,
              let wins = windowsRef as? [AXUIElement] else { return nil }
        let result = (ref: ref, windows: wins)
        appCache[pid] = result
        return result
    }
    if let name = name {
        guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == name }) else { return nil }
        return getApp(pid: app.processIdentifier, name: nil)
    }
    return nil
}

func getWindowTitle(_ win: AXUIElement) -> String? {
    var titleRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleRef) == .success else { return nil }
    return titleRef as? String
}

func getCGWindowID(_ win: AXUIElement) -> CGWindowID? {
    var windowID: CGWindowID = 0
    return _AXUIElementGetWindow(win, &windowID) == .success ? windowID : nil
}

func findWindow(in windows: [AXUIElement], windowNumber: Int?, title: String?, windowIndex: Int?) -> AXUIElement? {
    if let wn = windowNumber {
        for win in windows { if let wid = getCGWindowID(win), wid == CGWindowID(wn) { return win } }
    }
    if let title = title, !title.isEmpty {
        for win in windows { if getWindowTitle(win) == title { return win } }
        let prefix = String(title.prefix(min(40, title.count)))
        for win in windows { if let t = getWindowTitle(win), t.hasPrefix(prefix) { return win } }
    }
    if let idx = windowIndex, idx < windows.count { return windows[idx] }
    return nil
}

func handleList() -> Any {
    guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return [] as [[String: Any]]
    }
    var results: [[String: Any]] = []
    var appWindowCount: [String: Int] = [:]
    for win in windowList {
        guard let ownerName = win[kCGWindowOwnerName as String] as? String,
              terminalApps.contains(ownerName),
              let bounds = win[kCGWindowBounds as String] as? [String: CGFloat],
              let x = bounds["X"], let y = bounds["Y"],
              let w = bounds["Width"], let h = bounds["Height"],
              w > 50, h > 50 else { continue }
        let title = win[kCGWindowName as String] as? String ?? ""
        let windowIndex = appWindowCount[ownerName] ?? 0
        appWindowCount[ownerName] = windowIndex + 1
        results.append([
            "app": ownerName, "title": title, "windowIndex": windowIndex,
            "windowNumber": win[kCGWindowNumber as String] as? Int ?? 0,
            "pid": win[kCGWindowOwnerPID as String] as? Int ?? 0,
            "x": Int(x), "y": Int(y), "width": Int(w), "height": Int(h),
        ])
    }
    return results
}

func handleMove(_ windows: [[String: Any]]) -> Any {
    clearCache()
    var moved = 0
    for cmd in windows {
        guard let x = cmd["x"] as? Double, let y = cmd["y"] as? Double,
              let w = cmd["width"] as? Double, let h = cmd["height"] as? Double else { continue }
        let appName = cmd["app"] as? String
        let pid = (cmd["pid"] as? Int).map { pid_t($0) }
        guard let appInfo = getApp(pid: pid, name: appName) else { continue }
        guard let win = findWindow(in: appInfo.windows, windowNumber: cmd["windowNumber"] as? Int, title: cmd["title"] as? String, windowIndex: cmd["windowIndex"] as? Int) else { continue }
        // 1回目: 要求位置/サイズ通りに設定を試みる
        // 2回目: 位置→サイズ→位置 の順で再適用 (macOS AX は size 適用時に
        //        親 display がジャンプすることがあるため、位置を後で
        //        再設定して最終位置を強制する)
        var point = CGPoint(x: x, y: y)
        var size = CGSize(width: w, height: h)
        var posErr: AXError = .failure
        var sizeErr: AXError = .failure
        if let val = AXValueCreate(.cgPoint, &point) {
            posErr = AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, val)
        }
        if let val = AXValueCreate(.cgSize, &size) {
            sizeErr = AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, val)
        }
        // 位置を再設定 (size 適用後に位置がずれるケースへの保険)
        if let val = AXValueCreate(.cgPoint, &point) {
            let reErr = AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, val)
            if reErr == .success { posErr = .success }
        }
        // 実際に適用されたか検証: 1px 以内の誤差は許容
        var appliedOk = false
        var actualPosRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(win, kAXPositionAttribute as CFString, &actualPosRef) == .success,
           let actualVal = actualPosRef {
            var actual = CGPoint.zero
            if AXValueGetValue(actualVal as! AXValue, .cgPoint, &actual) {
                let dx = abs(actual.x - x), dy = abs(actual.y - y)
                appliedOk = (dx < 2 && dy < 2)
            }
        }
        if posErr == .success && sizeErr == .success && appliedOk {
            moved += 1
        }
    }
    return ["moved": moved]
}

func handleRaise(_ windows: [[String: Any]]) -> Any {
    clearCache()
    var raised = 0
    for cmd in windows {
        let appName = cmd["app"] as? String
        let pid = (cmd["pid"] as? Int).map { pid_t($0) }
        guard let appInfo = getApp(pid: pid, name: appName) else { continue }
        guard let win = findWindow(in: appInfo.windows, windowNumber: cmd["windowNumber"] as? Int, title: cmd["title"] as? String, windowIndex: cmd["windowIndex"] as? Int) else { continue }
        AXUIElementPerformAction(win, kAXRaiseAction as CFString)
        raised += 1
    }
    return ["raised": raised]
}

// Verify whether windows still exist via AXUIElement.
// Unlike CGWindowListCopyWindowInfo with .optionOnScreenOnly, this returns
// true even for off-screen windows (e.g. on a disconnected display), so
// we can distinguish "user closed the window" from "display disconnected".
func handleVerify(_ windows: [[String: Any]]) -> Any {
    clearCache()
    var alive: [Int] = []
    for cmd in windows {
        guard let wn = cmd["windowNumber"] as? Int else { continue }
        let appName = cmd["app"] as? String
        let pid = (cmd["pid"] as? Int).map { pid_t($0) }
        guard let appInfo = getApp(pid: pid, name: appName) else { continue }
        if findWindow(in: appInfo.windows, windowNumber: wn, title: cmd["title"] as? String, windowIndex: nil) != nil {
            alive.append(wn)
        }
    }
    return ["alive": alive]
}

// ── Main loop ──
setbuf(stdout, nil)
let readyData = try! JSONSerialization.data(withJSONObject: ["ready": true], options: [])
print(String(data: readyData, encoding: .utf8)!)

while let line = readLine() {
    guard !line.isEmpty,
          let data = line.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = json["cmd"] as? String else { continue }
    let reqId = json["id"] as? String ?? ""
    var result: Any
    switch cmd {
    case "list": result = handleList()
    case "move": result = handleMove(json["windows"] as? [[String: Any]] ?? [])
    case "raise": result = handleRaise(json["windows"] as? [[String: Any]] ?? [])
    case "verify": result = handleVerify(json["windows"] as? [[String: Any]] ?? [])
    default: result = ["error": "unknown command"]
    }
    let response: [String: Any] = ["id": reqId, "result": result]
    if let d = try? JSONSerialization.data(withJSONObject: response, options: []),
       let s = String(data: d, encoding: .utf8) { print(s) }
}
