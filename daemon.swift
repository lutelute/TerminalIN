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

// TiN が認識する外部ウィンドウのアプリ名 (ローカライズされた名前も含む)。
// Finder を含めることで Finder window も Available リストに出現させ
// grid への snap 対象にできる。
let terminalApps = Set(["Terminal", "ターミナル", "iTerm2", "Alacritty", "Warp", "kitty", "Hyper", "WezTerm", "Finder", "ファインダー"])

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


func handleMove(_ windows: [[String: Any]], positionOnly: Bool = false) -> Any {
    clearCache()
    var moved = 0
    var failed: [Int] = []
    let axTrusted = AXIsProcessTrusted()
    for cmd in windows {
        guard let x = cmd["x"] as? Double, let y = cmd["y"] as? Double else { continue }
        let appName = cmd["app"] as? String
        let pid = (cmd["pid"] as? Int).map { pid_t($0) }
        let windowNumber = cmd["windowNumber"] as? Int
        guard let appInfo = getApp(pid: pid, name: appName) else {
            if let wn = windowNumber { failed.append(wn) }
            continue
        }
        guard let win = findWindow(in: appInfo.windows, windowNumber: windowNumber, title: cmd["title"] as? String, windowIndex: cmd["windowIndex"] as? Int) else {
            if let wn = windowNumber { failed.append(wn) }
            continue
        }

        var point = CGPoint(x: x, y: y)
        var lastErr: AXError = .success

        if positionOnly {
            // ドラッグ中の軽量モード: position のみ (1回の AX 呼び出し)
            if let val = AXValueCreate(.cgPoint, &point) {
                let err = AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, val)
                if err != .success { lastErr = err }
            }
        } else {
            // 通常モード: position → size → position (3回)
            guard let w = cmd["width"] as? Double, let h = cmd["height"] as? Double else { continue }
            var size = CGSize(width: w, height: h)
            if let val = AXValueCreate(.cgPoint, &point) {
                let err = AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, val)
                if err != .success { lastErr = err }
            }
            if let val = AXValueCreate(.cgSize, &size) {
                let err = AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, val)
                if err != .success { lastErr = err }
            }
            if let val = AXValueCreate(.cgPoint, &point) {
                let err = AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, val)
                if err != .success { lastErr = err }
            }
        }
        if lastErr == .success {
            moved += 1
        } else if let wn = windowNumber {
            failed.append(wn)
        }
    }
    return ["moved": moved, "failed": failed, "axTrusted": axTrusted]
}

func handleRaise(_ windows: [[String: Any]]) -> Any {
    clearCache()
    var raised = 0
    var failed: [Int] = []
    for cmd in windows {
        let appName = cmd["app"] as? String
        let pid = (cmd["pid"] as? Int).map { pid_t($0) }
        let windowNumber = cmd["windowNumber"] as? Int
        guard let appInfo = getApp(pid: pid, name: appName) else {
            if let wn = windowNumber { failed.append(wn) }
            continue
        }
        guard let win = findWindow(in: appInfo.windows, windowNumber: windowNumber, title: cmd["title"] as? String, windowIndex: cmd["windowIndex"] as? Int) else {
            if let wn = windowNumber { failed.append(wn) }
            continue
        }
        let err = AXUIElementPerformAction(win, kAXRaiseAction as CFString)
        if err == .success {
            raised += 1
        } else if let wn = windowNumber {
            failed.append(wn)
        }
    }
    return ["raised": raised, "failed": failed, "axTrusted": AXIsProcessTrusted()]
}

// Wobble + raise: ウィンドウを一瞬 y-8px ずらして戻し、前面化する。
// 「クリックしたカードがどのウィンドウか」を視覚的に示すため。
// 全アプリ共通で position のみ操作する (Terminal.app は set size で AX 参照
// が無効化するため)。Finder も System Events 経由ではなく daemon の AX を
// 直接使うので ghost entry 問題を回避できる (findWindow が windowNumber で
// 一意にマッチするため)。
func handleWobble(_ windows: [[String: Any]]) -> Any {
    clearCache()
    var done = 0
    for cmd in windows {
        let appName = cmd["app"] as? String
        let pid = (cmd["pid"] as? Int).map { pid_t($0) }
        guard let appInfo = getApp(pid: pid, name: appName) else { continue }
        guard let win = findWindow(in: appInfo.windows, windowNumber: cmd["windowNumber"] as? Int, title: cmd["title"] as? String, windowIndex: cmd["windowIndex"] as? Int) else { continue }
        // 現在の AX 位置を読む
        var posRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(win, kAXPositionAttribute as CFString, &posRef) == .success,
              let axValue = posRef else { continue }
        var currentPoint = CGPoint.zero
        if !AXValueGetValue(axValue as! AXValue, .cgPoint, &currentPoint) { continue }
        // y - 8 に移動 → 60ms 待機 → 元の位置に戻す
        var upPoint = CGPoint(x: currentPoint.x, y: currentPoint.y - 8)
        if let val = AXValueCreate(.cgPoint, &upPoint) {
            AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, val)
        }
        usleep(60_000)
        if let val = AXValueCreate(.cgPoint, &currentPoint) {
            AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, val)
        }
        // AXRaise で z-order を上げる (アプリ全体を activate しない)
        AXUIElementPerformAction(win, kAXRaiseAction as CFString)
        done += 1
    }
    return ["done": done]
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
    case "move": result = handleMove(json["windows"] as? [[String: Any]] ?? [], positionOnly: json["positionOnly"] as? Bool ?? false)
    case "raise": result = handleRaise(json["windows"] as? [[String: Any]] ?? [])
    case "wobble": result = handleWobble(json["windows"] as? [[String: Any]] ?? [])
    case "verify": result = handleVerify(json["windows"] as? [[String: Any]] ?? [])
    default: result = ["error": "unknown command"]
    }
    let response: [String: Any] = ["id": reqId, "result": result]
    if let d = try? JSONSerialization.data(withJSONObject: response, options: []),
       let s = String(data: d, encoding: .utf8) { print(s) }
}
