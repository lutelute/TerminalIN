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

// CGWindowList で特定 windowNumber の現在位置を取得 (compositor 視点)
// AX read はキャッシュされていたりウィンドウが別 Space にいる場合に正確ではないので
// こちらを使って移動の成否を検証する。
func readCompositorPosition(windowNumber: Int) -> CGRect? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .optionIncludingWindow], CGWindowID(windowNumber)) as? [[String: Any]] else {
        return nil
    }
    for w in list {
        if let wn = w[kCGWindowNumber as String] as? Int, wn == windowNumber,
           let bounds = w[kCGWindowBounds as String] as? [String: CGFloat],
           let x = bounds["X"], let y = bounds["Y"],
           let width = bounds["Width"], let height = bounds["Height"] {
            return CGRect(x: x, y: y, width: width, height: height)
        }
    }
    return nil
}

func handleMove(_ windows: [[String: Any]]) -> Any {
    clearCache()
    var moved = 0
    for cmd in windows {
        guard let x = cmd["x"] as? Double, let y = cmd["y"] as? Double,
              let w = cmd["width"] as? Double, let h = cmd["height"] as? Double else { continue }
        let appName = cmd["app"] as? String
        let pid = (cmd["pid"] as? Int).map { pid_t($0) }
        let windowNumber = cmd["windowNumber"] as? Int
        guard let appInfo = getApp(pid: pid, name: appName) else { continue }
        guard let win = findWindow(in: appInfo.windows, windowNumber: windowNumber, title: cmd["title"] as? String, windowIndex: cmd["windowIndex"] as? Int) else { continue }

        // 位置 → サイズ → 位置 の順で 2 回適用
        // macOS AX は size 適用時に window を親 display の端に吸着する挙動があるため
        // 位置を後で再設定して最終位置を強制する
        var point = CGPoint(x: x, y: y)
        var size = CGSize(width: w, height: h)
        if let val = AXValueCreate(.cgPoint, &point) {
            AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, val)
        }
        if let val = AXValueCreate(.cgSize, &size) {
            AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, val)
        }
        if let val = AXValueCreate(.cgPoint, &point) {
            AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, val)
        }

        // compositor (CGWindowList) で実位置を検証
        // AX read は信用できない (別Space/フルスクリーンの window は AX set が成功しても
        // compositor には反映されない)
        // 注: compositor は AX set からの反映に最大 ~100ms かかるため、20ms 間隔で
        //     最大 5 回リトライする
        var appliedOk = false
        if let wn = windowNumber {
            for _ in 0..<5 {
                if let actual = readCompositorPosition(windowNumber: wn) {
                    let dx = abs(actual.origin.x - x), dy = abs(actual.origin.y - y)
                    if dx < 3 && dy < 3 {
                        appliedOk = true
                        break
                    }
                }
                usleep(20_000) // 20ms
            }
        } else {
            // windowNumber がない場合は AX set の成功を信じる
            appliedOk = true
        }
        if appliedOk {
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
