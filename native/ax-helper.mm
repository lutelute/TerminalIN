// ax-helper.mm — N-API native addon for AXUIElement operations
// Electron main process 内で実行するため、TiN.app の TCC 権限を直接使用。
// daemon バイナリ不要。

#import <Foundation/Foundation.h>
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <node_api.h>
#include <dlfcn.h>

// Private API: get CGWindowID from AXUIElement
extern "C" AXError _AXUIElementGetWindow(AXUIElementRef element, CGWindowID *windowID);

// ── SkyLight.framework の Space 移動 API (macOS 14+, CGS 代替) ──
// dlopen で動的に読み込み、古い macOS でも安全に動作する。
typedef int SLSCid;
typedef SLSCid (*PFN_SLSMainConnectionID)(void);
typedef uint64_t (*PFN_SLSGetActiveSpace)(SLSCid cid);
typedef void (*PFN_SLSMoveWindowsToManagedSpace)(SLSCid cid, CFArrayRef windows, uint64_t spaceID);
typedef CFArrayRef (*PFN_SLSCopyManagedDisplaySpaces)(SLSCid cid);
typedef CGError (*PFN_SLSGetWindowOwner)(SLSCid cid, CGWindowID wid, SLSCid *ownerCid);
typedef CFArrayRef (*PFN_SLSCopySpacesForWindows)(SLSCid cid, int selector, CFArrayRef windows);

static PFN_SLSMainConnectionID pfnSLSMain = NULL;
static PFN_SLSGetActiveSpace pfnSLSGetActive = NULL;
static PFN_SLSMoveWindowsToManagedSpace pfnSLSMove = NULL;
static PFN_SLSCopyManagedDisplaySpaces pfnSLSCopySpaces = NULL;
static PFN_SLSGetWindowOwner pfnSLSGetOwner = NULL;
static PFN_SLSCopySpacesForWindows pfnSLSCopySpacesForWindows = NULL;

static void initSkyLight() {
    static bool done = false;
    if (done) return;
    done = true;
    void *h = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_NOLOAD);
    if (!h) h = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY);
    if (!h) return;
    pfnSLSMain       = (PFN_SLSMainConnectionID)dlsym(h, "SLSMainConnectionID");
    pfnSLSGetActive  = (PFN_SLSGetActiveSpace)dlsym(h, "SLSGetActiveSpace");
    pfnSLSMove       = (PFN_SLSMoveWindowsToManagedSpace)dlsym(h, "SLSMoveWindowsToManagedSpace");
    pfnSLSCopySpaces = (PFN_SLSCopyManagedDisplaySpaces)dlsym(h, "SLSCopyManagedDisplaySpaces");
    pfnSLSGetOwner   = (PFN_SLSGetWindowOwner)dlsym(h, "SLSGetWindowOwner");
    if (!pfnSLSGetOwner)
        pfnSLSGetOwner = (PFN_SLSGetWindowOwner)dlsym(h, "CGSGetWindowOwner");
    pfnSLSCopySpacesForWindows = (PFN_SLSCopySpacesForWindows)dlsym(h, "SLSCopySpacesForWindows");
    if (!pfnSLSCopySpacesForWindows)
        pfnSLSCopySpacesForWindows = (PFN_SLSCopySpacesForWindows)dlsym(h, "CGSCopySpacesForWindows");
}

static NSSet *terminalApps = nil;

static void ensureTerminalApps() {
    if (!terminalApps) {
        terminalApps = [[NSSet alloc] initWithArray:@[
            @"Terminal", @"ターミナル", @"iTerm2", @"Alacritty",
            @"Warp", @"kitty", @"Hyper", @"WezTerm",
            @"Finder", @"ファインダー",
            @"TiN"
        ]];
    }
}

// ── list: CGWindowList でターミナルウィンドウを列挙 ──
static napi_value ListWindows(napi_env env, napi_callback_info info) {
    ensureTerminalApps();

    CFArrayRef windowList = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID);

    napi_value result;
    napi_create_array(env, &result);

    if (!windowList) return result;

    NSMutableDictionary<NSString*, NSNumber*> *appWindowCount = [NSMutableDictionary new];
    uint32_t idx = 0;

    for (NSDictionary *win in (__bridge NSArray *)windowList) {
        NSString *ownerName = win[(__bridge NSString *)kCGWindowOwnerName];
        if (!ownerName || ![terminalApps containsObject:ownerName]) continue;

        NSDictionary *bounds = win[(__bridge NSString *)kCGWindowBounds];
        if (!bounds) continue;
        CGFloat x = [bounds[@"X"] floatValue];
        CGFloat y = [bounds[@"Y"] floatValue];
        CGFloat w = [bounds[@"Width"] floatValue];
        CGFloat h = [bounds[@"Height"] floatValue];
        if (w <= 50 || h <= 50) continue;

        NSString *title = win[(__bridge NSString *)kCGWindowName] ?: @"";
        NSNumber *wn = win[(__bridge NSString *)kCGWindowNumber];
        NSNumber *pid = win[(__bridge NSString *)kCGWindowOwnerPID];

        int windowIndex = [appWindowCount[ownerName] intValue];
        appWindowCount[ownerName] = @(windowIndex + 1);

        napi_value obj;
        napi_create_object(env, &obj);

        napi_value v;
        napi_create_string_utf8(env, [ownerName UTF8String], NAPI_AUTO_LENGTH, &v);
        napi_set_named_property(env, obj, "app", v);
        napi_create_string_utf8(env, [title UTF8String], NAPI_AUTO_LENGTH, &v);
        napi_set_named_property(env, obj, "title", v);
        napi_create_int32(env, [wn intValue], &v);
        napi_set_named_property(env, obj, "windowNumber", v);
        napi_create_int32(env, [pid intValue], &v);
        napi_set_named_property(env, obj, "pid", v);
        napi_create_int32(env, windowIndex, &v);
        napi_set_named_property(env, obj, "windowIndex", v);
        napi_create_int32(env, (int)x, &v);
        napi_set_named_property(env, obj, "x", v);
        napi_create_int32(env, (int)y, &v);
        napi_set_named_property(env, obj, "y", v);
        napi_create_int32(env, (int)w, &v);
        napi_set_named_property(env, obj, "width", v);
        napi_create_int32(env, (int)h, &v);
        napi_set_named_property(env, obj, "height", v);

        napi_set_element(env, result, idx++, obj);
    }

    CFRelease(windowList);
    return result;
}

// ── AX ヘルパー: windows 配列から対象を見つける (AX fetch 済み前提) ──
// batch 呼び出し時に同一 pid のウィンドウリストを使い回すために分離。
static AXUIElementRef findAXWindowInList(CFArrayRef windows, int windowNumber, const char *title, int windowIndex) {
    if (!windows) return NULL;
    CFIndex count = CFArrayGetCount(windows);

    // 1. windowNumber (CGWindowID) でマッチ
    // AXWindowID (公式属性, macOS 10.15+) を優先、失敗時は _AXUIElementGetWindow にフォールバック
    for (CFIndex i = 0; i < count; i++) {
        AXUIElementRef win = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
        CGWindowID wid = 0;
        bool matched = false;

        CFTypeRef widRef = NULL;
        if (AXUIElementCopyAttributeValue(win, CFSTR("AXWindowID"), &widRef) == kAXErrorSuccess && widRef) {
            if (CFGetTypeID(widRef) == CFNumberGetTypeID()) {
                CFNumberGetValue((CFNumberRef)widRef, kCFNumberSInt32Type, &wid);
            }
            CFRelease(widRef);
            matched = (wid == (CGWindowID)windowNumber);
        }
        if (!matched) {
            wid = 0;
            if (_AXUIElementGetWindow(win, &wid) == kAXErrorSuccess) {
                matched = (wid == (CGWindowID)windowNumber);
            }
        }
        if (matched) { CFRetain(win); return win; }
    }

    // 2. title でマッチ
    if (title && strlen(title) > 0) {
        NSString *targetTitle = [NSString stringWithUTF8String:title];
        for (CFIndex i = 0; i < count; i++) {
            AXUIElementRef win = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
            CFTypeRef titleRef = NULL;
            if (AXUIElementCopyAttributeValue(win, kAXTitleAttribute, &titleRef) == kAXErrorSuccess) {
                NSString *t = (__bridge NSString *)titleRef;
                NSUInteger prefixLen = MIN((NSUInteger)40, targetTitle.length);
                if ([t isEqualToString:targetTitle] || [t hasPrefix:[targetTitle substringToIndex:prefixLen]]) {
                    CFRetain(win);
                    CFRelease(titleRef);
                    return win;
                }
                CFRelease(titleRef);
            }
        }
    }

    // 3. CGWindowList position でマッチ (全 Space を対象: OnScreenOnly だと別 Space のウィンドウを見逃す)
    CFArrayRef cgList = CGWindowListCopyWindowInfo(kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (cgList) {
        CGPoint cgPos = {-99999, -99999};
        for (NSDictionary *w in (__bridge NSArray *)cgList) {
            if ([w[(__bridge NSString *)kCGWindowNumber] intValue] == windowNumber) {
                NSDictionary *b = w[(__bridge NSString *)kCGWindowBounds];
                cgPos.x = [b[@"X"] floatValue];
                cgPos.y = [b[@"Y"] floatValue];
                break;
            }
        }
        CFRelease(cgList);

        if (cgPos.x > -99990) {
            for (CFIndex i = 0; i < count; i++) {
                AXUIElementRef win = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
                CFTypeRef posRef = NULL;
                if (AXUIElementCopyAttributeValue(win, kAXPositionAttribute, &posRef) == kAXErrorSuccess) {
                    CGPoint axPos;
                    AXValueGetValue((AXValueRef)posRef, (AXValueType)kAXValueCGPointType, &axPos);
                    CFRelease(posRef);
                    if (fabs(axPos.x - cgPos.x) < 5 && fabs(axPos.y - cgPos.y) < 5) {
                        CFRetain(win);
                        return win;
                    }
                }
            }
        }
    }

    // 4. windowIndex フォールバック
    if (windowIndex >= 0 && windowIndex < (int)count) {
        AXUIElementRef win = (AXUIElementRef)CFArrayGetValueAtIndex(windows, windowIndex);
        CFRetain(win);
        return win;
    }

    return NULL;
}

// pid → AX windows を fetch してマッチ。単発呼び出し用。
static AXUIElementRef findAXWindow(pid_t pid, int windowNumber, const char *title, int windowIndex) {
    AXUIElementRef appRef = AXUIElementCreateApplication(pid);
    CFTypeRef windowsRef = NULL;
    if (AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute, &windowsRef) != kAXErrorSuccess) {
        CFRelease(appRef);
        return NULL;
    }
    AXUIElementRef result = findAXWindowInList((CFArrayRef)windowsRef, windowNumber, title, windowIndex);
    CFRelease(windowsRef);
    CFRelease(appRef);
    return result;
}

// ── move: position + size を設定 ──
// args: [{pid, windowNumber, title, windowIndex, x, y, width, height}]
// positionOnly (optional): true なら position のみ
static napi_value MoveWindows(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    bool positionOnly = false;
    if (argc >= 2) {
        napi_get_value_bool(env, args[1], &positionOnly);
    }

    uint32_t length;
    napi_get_array_length(env, args[0], &length);

    int moved = 0;

    // 同一 pid のウィンドウ一覧を使い回すためのキャッシュ。
    // sidebar drag 時に 4 ウィンドウを同一 pid で処理するケースで AX 列挙を 4→1 に削減。
    struct AppCache { pid_t pid; AXUIElementRef appRef; CFArrayRef windowsRef; };
    AppCache cache[16] = {};
    int cacheSize = 0;

    for (uint32_t i = 0; i < length; i++) {
        napi_value item;
        napi_get_element(env, args[0], i, &item);

        int32_t pid, windowNumber, windowIndex = -1;
        double x, y, w = 0, h = 0;
        char title[256] = "";

        napi_value v;
        napi_get_named_property(env, item, "pid", &v); napi_get_value_int32(env, v, &pid);
        napi_get_named_property(env, item, "windowNumber", &v); napi_get_value_int32(env, v, &windowNumber);
        napi_get_named_property(env, item, "x", &v); napi_get_value_double(env, v, &x);
        napi_get_named_property(env, item, "y", &v); napi_get_value_double(env, v, &y);

        napi_value titleVal;
        napi_get_named_property(env, item, "title", &titleVal);
        size_t titleLen;
        napi_get_value_string_utf8(env, titleVal, title, sizeof(title), &titleLen);

        napi_value wiVal;
        if (napi_get_named_property(env, item, "windowIndex", &wiVal) == napi_ok) {
            napi_get_value_int32(env, wiVal, &windowIndex);
        }

        if (!positionOnly) {
            napi_get_named_property(env, item, "width", &v); napi_get_value_double(env, v, &w);
            napi_get_named_property(env, item, "height", &v); napi_get_value_double(env, v, &h);
        }

        // pid ごとに AX windows を一度だけ fetch (キャッシュヒットは O(cacheSize))
        CFArrayRef windowsRef = NULL;
        bool cacheHit = false;
        for (int ci = 0; ci < cacheSize; ci++) {
            if (cache[ci].pid == pid) {
                windowsRef = cache[ci].windowsRef;  // NULL の場合は失敗済み
                cacheHit = true;
                break;
            }
        }
        if (!cacheHit) {
            AXUIElementRef appRef = AXUIElementCreateApplication((pid_t)pid);
            CFTypeRef wRef = NULL;
            AXError axErr = AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute, &wRef);
            if (axErr != kAXErrorSuccess) {
                CFRelease(appRef);
                if (cacheSize < 16) cache[cacheSize++] = { (pid_t)pid, NULL, NULL };
                continue;
            }
            windowsRef = (CFArrayRef)wRef;
            if (cacheSize < 16) cache[cacheSize++] = { (pid_t)pid, appRef, windowsRef };
            else { CFRelease(appRef); CFRelease(windowsRef); continue; }
        }
        if (!windowsRef) continue;

        AXUIElementRef win = findAXWindowInList(windowsRef, windowNumber, title, windowIndex);
        if (!win) continue;

        CGPoint point = CGPointMake(x, y);
        AXValueRef posVal = AXValueCreate((AXValueType)kAXValueCGPointType, &point);

        if (positionOnly) {
            if (posVal) {
                AXUIElementSetAttributeValue(win, kAXPositionAttribute, posVal);
                CFRelease(posVal);
            }
        } else {
            // Terminal.app は set size で独自に window を動かすので pos-size-pos で上書き。
            CGSize size = CGSizeMake(w, h);
            AXValueRef sizeVal = AXValueCreate((AXValueType)kAXValueCGSizeType, &size);
            if (posVal) AXUIElementSetAttributeValue(win, kAXPositionAttribute, posVal);
            if (sizeVal) { AXUIElementSetAttributeValue(win, kAXSizeAttribute, sizeVal); CFRelease(sizeVal); }
            if (posVal) AXUIElementSetAttributeValue(win, kAXPositionAttribute, posVal);
            if (posVal) CFRelease(posVal);
        }

        moved++;
        CFRelease(win);
    }

    // キャッシュ解放
    for (int ci = 0; ci < cacheSize; ci++) {
        if (cache[ci].windowsRef) CFRelease(cache[ci].windowsRef);
        if (cache[ci].appRef) CFRelease(cache[ci].appRef);
    }

    napi_value result;
    napi_create_int32(env, moved, &result);
    return result;
}

// ── raise: AXRaise ──
static napi_value RaiseWindows(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    uint32_t length;
    napi_get_array_length(env, args[0], &length);
    int raised = 0;

    // MoveWindows と同じ per-pid キャッシュ
    struct AppCache { pid_t pid; AXUIElementRef appRef; CFArrayRef windowsRef; };
    AppCache cache[16] = {};
    int cacheSize = 0;

    for (uint32_t i = 0; i < length; i++) {
        napi_value item;
        napi_get_element(env, args[0], i, &item);

        int32_t pid, windowNumber, windowIndex = -1;
        char title[256] = "";

        napi_value v;
        napi_get_named_property(env, item, "pid", &v); napi_get_value_int32(env, v, &pid);
        napi_get_named_property(env, item, "windowNumber", &v); napi_get_value_int32(env, v, &windowNumber);

        napi_value titleVal;
        napi_get_named_property(env, item, "title", &titleVal);
        size_t titleLen;
        napi_get_value_string_utf8(env, titleVal, title, sizeof(title), &titleLen);

        napi_value wiVal;
        if (napi_get_named_property(env, item, "windowIndex", &wiVal) == napi_ok) {
            napi_get_value_int32(env, wiVal, &windowIndex);
        }

        CFArrayRef windowsRef = NULL;
        bool cacheHit = false;
        for (int ci = 0; ci < cacheSize; ci++) {
            if (cache[ci].pid == pid) { windowsRef = cache[ci].windowsRef; cacheHit = true; break; }
        }
        if (!cacheHit) {
            AXUIElementRef appRef = AXUIElementCreateApplication((pid_t)pid);
            CFTypeRef wRef = NULL;
            if (AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute, &wRef) != kAXErrorSuccess) {
                CFRelease(appRef);
                if (cacheSize < 16) cache[cacheSize++] = { (pid_t)pid, NULL, NULL };
                continue;
            }
            windowsRef = (CFArrayRef)wRef;
            if (cacheSize < 16) cache[cacheSize++] = { (pid_t)pid, appRef, windowsRef };
            else { CFRelease(appRef); CFRelease(windowsRef); continue; }
        }
        if (!windowsRef) continue;

        AXUIElementRef win = findAXWindowInList(windowsRef, windowNumber, title, windowIndex);
        if (!win) continue;

        if (AXUIElementPerformAction(win, kAXRaiseAction) == kAXErrorSuccess) raised++;
        CFRelease(win);
    }

    for (int ci = 0; ci < cacheSize; ci++) {
        if (cache[ci].windowsRef) CFRelease(cache[ci].windowsRef);
        if (cache[ci].appRef) CFRelease(cache[ci].appRef);
    }

    napi_value result;
    napi_create_int32(env, raised, &result);
    return result;
}

// ── Spaces 移動 (CGS プライベート API — フォールバック用) ──
extern "C" {
    int CGSMainConnectionID(void);
    CFArrayRef CGSCopyManagedDisplaySpaces(int cid);
    void CGSMoveWindowsToManagedSpace(int cid, CFArrayRef windows, uint64_t space);
    uint64_t CGSGetActiveSpace(int cid);
    CGError CGSGetWindowOwner(int cid, CGWindowID wid, int *ownerCid);
    void CGSAddWindowsToSpaces(int cid, CFArrayRef windows, CFArrayRef spaces);
    void CGSRemoveWindowsFromSpaces(int cid, CFArrayRef windows, CFArrayRef spaces);
    // sticky = "visible on all Spaces" タグ操作
    CGError CGSSetWindowTags(int cid, CGWindowID wid, int *tags, int tagSize);
    CGError CGSClearWindowTags(int cid, CGWindowID wid, int *tags, int tagSize);
}

// SLS or CGS を統一的に呼ぶヘルパー
static int spaceCid() {
    initSkyLight();
    return pfnSLSMain ? pfnSLSMain() : CGSMainConnectionID();
}
static uint64_t spaceGetActive(int cid) {
    return pfnSLSGetActive ? pfnSLSGetActive(cid) : CGSGetActiveSpace(cid);
}
static CFArrayRef spaceCopyDisplaySpaces(int cid) {
    return pfnSLSCopySpaces ? pfnSLSCopySpaces(cid) : CGSCopyManagedDisplaySpaces(cid);
}
static void spaceMoveWindows(int cid, CFArrayRef windows, uint64_t spaceID) {
    if (pfnSLSMove) pfnSLSMove(cid, windows, spaceID);
    else CGSMoveWindowsToManagedSpace(cid, windows, spaceID);
}

// moveToSpace(windowNumbers: number[], direction: number) → moved count
// 指定ウィンドウを次/前の Space に移動する。自プロセスのウィンドウ (Electron) に有効。
static napi_value MoveToSpace(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    int32_t direction;
    napi_get_value_int32(env, args[1], &direction);

    int cid = spaceCid();
    uint64_t currentSpace = spaceGetActive(cid);

    CFArrayRef displays = spaceCopyDisplaySpaces(cid);
    if (!displays) {
        napi_value result; napi_create_int32(env, 0, &result); return result;
    }
    NSMutableArray<NSNumber*> *allSpaces = [NSMutableArray new];
    for (NSDictionary *d in (__bridge NSArray *)displays) {
        for (NSDictionary *s in d[@"Spaces"]) {
            NSNumber *sid = s[@"id64"] ?: s[@"ManagedSpaceID"];
            if (sid) [allSpaces addObject:sid];
        }
    }
    CFRelease(displays);
    if (allSpaces.count <= 1) {
        napi_value result; napi_create_int32(env, 0, &result); return result;
    }

    NSInteger currentIdx = -1;
    for (NSUInteger i = 0; i < allSpaces.count; i++) {
        if ([allSpaces[i] unsignedLongLongValue] == currentSpace) { currentIdx = i; break; }
    }
    if (currentIdx < 0) currentIdx = 0;
    NSInteger nextIdx = (currentIdx + direction + (NSInteger)allSpaces.count) % (NSInteger)allSpaces.count;
    uint64_t targetSpace = [allSpaces[nextIdx] unsignedLongLongValue];

    uint32_t length;
    napi_get_array_length(env, args[0], &length);
    int moved = 0;
    // ウィンドウが指定 Space に存在するか確認（複数 Space 所属時も正確に判定）
    auto isWindowOnSpace = [&](CGWindowID wid, uint64_t spaceId) -> bool {
        if (!pfnSLSCopySpacesForWindows) return false;
        CFArrayRef spaces = pfnSLSCopySpacesForWindows(cid, 7, (__bridge CFArrayRef)@[@(wid)]);
        if (!spaces) return false;
        bool found = false;
        for (CFIndex j = 0; j < CFArrayGetCount(spaces); j++) {
            uint64_t sid = 0;
            CFNumberGetValue((CFNumberRef)CFArrayGetValueAtIndex(spaces, j), kCFNumberSInt64Type, (int64_t*)&sid);
            if (sid == spaceId) { found = true; break; }
        }
        CFRelease(spaces);
        return found;
    };
    auto getWindowSpaceId = [&](CGWindowID wid) -> uint64_t {
        if (!pfnSLSCopySpacesForWindows) return 0;
        CFArrayRef spaces = pfnSLSCopySpacesForWindows(cid, 7, (__bridge CFArrayRef)@[@(wid)]);
        if (!spaces) return 0;
        uint64_t sid = 0;
        if (CFArrayGetCount(spaces) > 0)
            CFNumberGetValue((CFNumberRef)CFArrayGetValueAtIndex(spaces, 0), kCFNumberSInt64Type, (int64_t*)&sid);
        CFRelease(spaces);
        return sid;
    };

    for (uint32_t i = 0; i < length; i++) {
        napi_value item;
        napi_get_element(env, args[0], i, &item);
        int32_t wn;
        napi_get_value_int32(env, item, &wn);

        uint64_t spaceBefore = getWindowSpaceId((CGWindowID)wn);
        bool onTarget = false;

        // ownerCid で MoveWindows を試みる
        int ownerCid = 0;
        CGSGetWindowOwner(cid, (CGWindowID)wn, &ownerCid);
        spaceMoveWindows((ownerCid > 0) ? ownerCid : cid,
                         (__bridge CFArrayRef)@[@(wn)], targetSpace);
        usleep(5000);
        onTarget = isWindowOnSpace((CGWindowID)wn, targetSpace);

        if (!onTarget) {
            // myCid で MoveWindows 再試行
            spaceMoveWindows(cid, (__bridge CFArrayRef)@[@(wn)], targetSpace);
            usleep(5000);
            onTarget = isWindowOnSpace((CGWindowID)wn, targetSpace);
        }

        if (!onTarget) {
            // Add/Remove 方式: window を target Space に追加してから old を削除
            CFArrayRef winArr  = (__bridge CFArrayRef)@[@(wn)];
            CFArrayRef toArr   = (__bridge CFArrayRef)@[@((int64_t)targetSpace)];
            CFArrayRef fromArr = (__bridge CFArrayRef)@[@((int64_t)spaceBefore)];

            CGSAddWindowsToSpaces(cid, winArr, toArr);
            usleep(10000);
            if (isWindowOnSpace((CGWindowID)wn, targetSpace)) {
                CGSRemoveWindowsFromSpaces(cid, winArr, fromArr);
                usleep(5000);
                onTarget = true;
            } else {
                // ownerCid で Add 再試行
                int addCid = (ownerCid > 0) ? ownerCid : cid;
                CGSAddWindowsToSpaces(addCid, winArr, toArr);
                usleep(10000);
                if (isWindowOnSpace((CGWindowID)wn, targetSpace)) {
                    CGSRemoveWindowsFromSpaces(addCid, winArr, fromArr);
                    usleep(5000);
                    onTarget = true;
                }
            }
        }

        uint64_t spaceAfter = getWindowSpaceId((CGWindowID)wn);
        if (!onTarget)
            NSLog(@"[tin] moveToSpace wn=%d before=%llu after=%llu target=%llu FAILED (all methods)",
                  wn, (unsigned long long)spaceBefore, (unsigned long long)spaceAfter, (unsigned long long)targetSpace);
        else
            NSLog(@"[tin] moveToSpace wn=%d %llu→%llu OK", wn,
                  (unsigned long long)spaceBefore, (unsigned long long)targetSpace);
        moved++;
    }

    napi_value result;
    napi_create_int32(env, moved, &result);
    return result;
}

// getSpaceForWindows(windowNumbers[]) → [{wn, spaceId}]
static napi_value GetSpaceForWindows(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    initSkyLight();
    int cid = spaceCid();

    uint32_t length;
    napi_get_array_length(env, args[0], &length);

    napi_value result;
    napi_create_array_with_length(env, length, &result);
    for (uint32_t i = 0; i < length; i++) {
        napi_value item;
        napi_get_element(env, args[0], i, &item);
        int32_t wn;
        napi_get_value_int32(env, item, &wn);

        uint64_t spaceId = 0;
        if (pfnSLSCopySpacesForWindows) {
            CFArrayRef spaces = pfnSLSCopySpacesForWindows(cid, 7, (__bridge CFArrayRef)@[@(wn)]);
            if (spaces) {
                if (CFArrayGetCount(spaces) > 0) {
                    CFNumberRef n = (CFNumberRef)CFArrayGetValueAtIndex(spaces, 0);
                    CFNumberGetValue(n, kCFNumberSInt64Type, (int64_t*)&spaceId);
                }
                CFRelease(spaces);
            }
        }

        napi_value entry, wnVal, spaceVal;
        napi_create_object(env, &entry);
        napi_create_int32(env, wn, &wnVal);
        napi_create_int64(env, (int64_t)spaceId, &spaceVal);
        napi_set_named_property(env, entry, "wn", wnVal);
        napi_set_named_property(env, entry, "spaceId", spaceVal);
        napi_set_element(env, result, i, entry);
    }
    return result;
}

// getSpacesList() → [{id, index, isCurrent}]
// 全 Space の一覧を返す (CGSCopyManagedDisplaySpaces ベース)
static napi_value GetSpacesList(napi_env env, napi_callback_info info) {
    initSkyLight();
    int cid = spaceCid();
    uint64_t activeSpace = spaceGetActive(cid);
    CFArrayRef displays = spaceCopyDisplaySpaces(cid);

    napi_value result;
    napi_create_array(env, &result);
    if (!displays) return result;

    uint32_t idx = 0;
    for (NSDictionary *d in (__bridge NSArray *)displays) {
        for (NSDictionary *s in d[@"Spaces"]) {
            NSNumber *sid = s[@"id64"] ?: s[@"ManagedSpaceID"];
            if (!sid) continue;
            uint64_t spaceId = [sid unsignedLongLongValue];

            napi_value entry, v;
            napi_create_object(env, &entry);
            napi_create_int64(env, (int64_t)spaceId, &v);
            napi_set_named_property(env, entry, "id", v);
            napi_create_uint32(env, idx + 1, &v);
            napi_set_named_property(env, entry, "index", v);
            napi_get_boolean(env, spaceId == activeSpace, &v);
            napi_set_named_property(env, entry, "isCurrent", v);
            napi_set_element(env, result, idx++, entry);
        }
    }
    CFRelease(displays);
    return result;
}

// moveWindowsToSpaceId(windowNumbers[], targetSpaceId) → moved count
// 絶対 Space ID を指定してウィンドウを移動する (Mission Control 追従用)
static napi_value MoveWindowsToSpaceId(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    int64_t targetSpace;
    napi_get_value_int64(env, args[1], &targetSpace);

    initSkyLight();
    int cid = spaceCid();

    uint32_t length;
    napi_get_array_length(env, args[0], &length);
    int moved = 0;

    auto getWinSpace = [&](CGWindowID wid) -> uint64_t {
        if (!pfnSLSCopySpacesForWindows) return 0;
        CFArrayRef spaces = pfnSLSCopySpacesForWindows(cid, 7, (__bridge CFArrayRef)@[@(wid)]);
        if (!spaces) return 0;
        uint64_t sid = 0;
        if (CFArrayGetCount(spaces) > 0) {
            CFNumberRef n = (CFNumberRef)CFArrayGetValueAtIndex(spaces, 0);
            CFNumberGetValue(n, kCFNumberSInt64Type, (int64_t*)&sid);
        }
        CFRelease(spaces);
        return sid;
    };

    for (uint32_t i = 0; i < length; i++) {
        napi_value item;
        napi_get_element(env, args[0], i, &item);
        int32_t wn;
        napi_get_value_int32(env, item, &wn);

        uint64_t spaceBefore = getWinSpace((CGWindowID)wn);
        if (spaceBefore == (uint64_t)targetSpace) { moved++; continue; }

        int ownerCid = 0;
        CGSGetWindowOwner(cid, (CGWindowID)wn, &ownerCid);
        spaceMoveWindows(ownerCid > 0 ? ownerCid : cid,
                         (__bridge CFArrayRef)@[@(wn)], (uint64_t)targetSpace);
        usleep(5000); // 5ms — 最小限のコミット待機

        uint64_t spaceAfter = getWinSpace((CGWindowID)wn);
        if (spaceAfter != (uint64_t)targetSpace && spaceBefore > 0) {
            CFArrayRef winArr  = (__bridge CFArrayRef)@[@(wn)];
            CFArrayRef toArr   = (__bridge CFArrayRef)@[@(targetSpace)];
            CFArrayRef fromArr = (__bridge CFArrayRef)@[@((int64_t)spaceBefore)];
            CGSAddWindowsToSpaces(cid, winArr, toArr);
            usleep(10000); // 10ms
            spaceAfter = getWinSpace((CGWindowID)wn);
            if (spaceAfter == (uint64_t)targetSpace)
                CGSRemoveWindowsFromSpaces(cid, winArr, fromArr);
        }

        NSLog(@"[tin] moveWindowsToSpaceId wn=%d %llu→%llu %@", wn,
              (unsigned long long)spaceBefore, (unsigned long long)(uint64_t)targetSpace,
              spaceAfter == (uint64_t)targetSpace ? @"OK" : @"FAILED");
        moved++;
    }

    napi_value result;
    napi_create_int32(env, moved, &result);
    return result;
}

// moveWindowsToActiveSpace(windowNumbers) → moved count
// 指定 windowNumber を全て現在アクティブな Space に引き寄せる。
static napi_value MoveWindowsToActiveSpace(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    int cid = spaceCid();
    uint64_t activeSpace = spaceGetActive(cid);

    uint32_t length;
    napi_get_array_length(env, args[0], &length);
    int moved = 0;

    for (uint32_t i = 0; i < length; i++) {
        napi_value item;
        napi_get_element(env, args[0], i, &item);
        int32_t wn;
        napi_get_value_int32(env, item, &wn);
        CGWindowID winId = (CGWindowID)wn;

        int ownerCid = 0;
        if (pfnSLSGetOwner) pfnSLSGetOwner(cid, winId, &ownerCid);
        else CGSGetWindowOwner(cid, winId, &ownerCid);
        int moveCid = (ownerCid > 0) ? ownerCid : cid;

        // Space 前確認
        uint64_t spaceBefore = 0;
        if (pfnSLSCopySpacesForWindows) {
            CFArrayRef sp = pfnSLSCopySpacesForWindows(cid, 7, (__bridge CFArrayRef)@[@(wn)]);
            if (sp && CFArrayGetCount(sp) > 0) {
                CFNumberGetValue((CFNumberRef)CFArrayGetValueAtIndex(sp, 0), kCFNumberSInt64Type, &spaceBefore);
                CFRelease(sp);
            }
        }

        NSArray *winArr = @[@(wn)];
        spaceMoveWindows(moveCid, (__bridge CFArrayRef)winArr, activeSpace);
        usleep(5000);

        uint64_t spaceAfter = 0;
        if (pfnSLSCopySpacesForWindows) {
            CFArrayRef sp = pfnSLSCopySpacesForWindows(cid, 7, (__bridge CFArrayRef)@[@(wn)]);
            if (sp && CFArrayGetCount(sp) > 0) {
                CFNumberGetValue((CFNumberRef)CFArrayGetValueAtIndex(sp, 0), kCFNumberSInt64Type, &spaceAfter);
                CFRelease(sp);
            }
        }

        // 失敗時 myCid で再試行
        if (spaceAfter != activeSpace && spaceAfter == spaceBefore) {
            spaceMoveWindows(cid, (__bridge CFArrayRef)winArr, activeSpace);
            usleep(5000);
            if (pfnSLSCopySpacesForWindows) {
                CFArrayRef sp = pfnSLSCopySpacesForWindows(cid, 7, (__bridge CFArrayRef)@[@(wn)]);
                if (sp && CFArrayGetCount(sp) > 0) { CFNumberGetValue((CFNumberRef)CFArrayGetValueAtIndex(sp, 0), kCFNumberSInt64Type, &spaceAfter); CFRelease(sp); }
            }
        }

        if (spaceAfter != activeSpace)
            NSLog(@"[tin] moveToActiveSpace wn=%d before=%llu after=%llu target=%llu FAILED",
                  wn, (unsigned long long)spaceBefore, (unsigned long long)spaceAfter, (unsigned long long)activeSpace);
        moved++;
    }

    napi_value result;
    napi_create_int32(env, moved, &result);
    return result;
}

// ── axTrusted ──
static napi_value IsAXTrusted(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_get_boolean(env, AXIsProcessTrusted(), &result);
    return result;
}

// ── 最前面ウィンドウの CGWindowNumber を取得 ──
// z-order 上位の layer=0 normal window を返す。一致なければ 0。
static napi_value GetFrontmostWindowNumber(napi_env env, napi_callback_info info) {
    CFArrayRef windowList = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID);
    int32_t result = 0;
    if (windowList) {
        for (NSDictionary *win in (__bridge NSArray *)windowList) {
            NSNumber *layer = win[(__bridge NSString *)kCGWindowLayer];
            if (layer && [layer intValue] != 0) continue;
            NSDictionary *bounds = win[(__bridge NSString *)kCGWindowBounds];
            if (!bounds) continue;
            CGFloat w = [bounds[@"Width"] floatValue];
            CGFloat h = [bounds[@"Height"] floatValue];
            if (w <= 50 || h <= 50) continue;
            NSNumber *wn = win[(__bridge NSString *)kCGWindowNumber];
            if (wn) { result = [wn intValue]; break; }
        }
        CFRelease(windowList);
    }
    napi_value ret;
    napi_create_int32(env, result, &ret);
    return ret;
}

// ── ウィンドウの sticky (全 Space 表示) フラグを操作 ──
// sticky にすると全 Space で見える→TiN 移動後 unsticky で現 Space に固定される。
// kCGSTagSticky = 0x0800
static napi_value SetWindowSticky(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    // args[0]: windowNumbers (Array<number>)
    // args[1]: sticky (boolean)
    bool sticky = false;
    napi_get_value_bool(env, args[1], &sticky);

    int cid = CGSMainConnectionID();
    int stickyTag = 0x0800; // kCGSTagSticky

    uint32_t length;
    napi_get_array_length(env, args[0], &length);
    int count = 0;
    for (uint32_t i = 0; i < length; i++) {
        napi_value item;
        napi_get_element(env, args[0], i, &item);
        int32_t wn;
        napi_get_value_int32(env, item, &wn);
        CGWindowID wid = (CGWindowID)wn;

        CGError err;
        if (sticky) {
            err = CGSSetWindowTags(cid, wid, &stickyTag, 32);
        } else {
            err = CGSClearWindowTags(cid, wid, &stickyTag, 32);
        }
        NSLog(@"[tin] setSticky wn=%d sticky=%d err=%d", wn, sticky, err);
        if (err == 0) count++;
    }

    napi_value result;
    napi_create_int32(env, count, &result);
    return result;
}

// ── NSWindow ポインタから CGWindowID を取得 ──
// win.getNativeWindowHandle() で得た Buffer の先頭 8 バイトをそのまま BigInt で渡す。
// transparent ウィンドウも CGWindowList に依存しないため確実に取得できる。
static napi_value GetWindowIdFromHandle(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    uint64_t ptrVal = 0;
    napi_valuetype vtype;
    napi_typeof(env, args[0], &vtype);
    if (vtype == napi_bigint) {
        bool lossless;
        napi_get_value_bigint_uint64(env, args[0], &ptrVal, &lossless);
    } else {
        double d;
        napi_get_value_double(env, args[0], &d);
        ptrVal = (uint64_t)(int64_t)d;
    }

    CGWindowID wid = 0;
    if (ptrVal) {
        @try {
            // macOS では getNativeWindowHandle() は NSView* を返す
            id obj = (__bridge id)(void *)ptrVal;
            NSWindow *nsWin = nil;
            if ([obj isKindOfClass:[NSView class]]) {
                nsWin = [(NSView *)obj window];
            } else if ([obj isKindOfClass:[NSWindow class]]) {
                nsWin = (NSWindow *)obj;
            }
            if (nsWin) {
                int wn = [nsWin windowNumber];
                if (wn > 0) wid = (CGWindowID)wn;
            }
        } @catch (NSException *e) {
            NSLog(@"[tin] getWindowIdFromHandle exception: %@", e);
        }
    }
    NSLog(@"[tin] getWindowIdFromHandle ptr=0x%llx wid=%u", ptrVal, wid);

    napi_value result;
    napi_create_uint32(env, wid, &result);
    return result;
}

// ── 全 Space の対象アプリウィンドウを列挙 ──
// push-to-space 時に snapped terminals が別 Space にある場合でも windowNumber を取得できる。
// ListWindows と同じ構造だが kCGWindowListOptionOnScreenOnly を外している。
static napi_value ListWindowsAllSpaces(napi_env env, napi_callback_info info) {
    ensureTerminalApps();

    CFArrayRef windowList = CGWindowListCopyWindowInfo(
        kCGWindowListExcludeDesktopElements,
        kCGNullWindowID);

    napi_value result;
    napi_create_array(env, &result);
    if (!windowList) return result;

    uint32_t idx = 0;
    for (NSDictionary *win in (__bridge NSArray *)windowList) {
        NSString *ownerName = win[(__bridge NSString *)kCGWindowOwnerName];
        if (!ownerName || ![terminalApps containsObject:ownerName]) continue;

        NSDictionary *bounds = win[(__bridge NSString *)kCGWindowBounds];
        if (!bounds) continue;
        CGFloat w = [bounds[@"Width"] floatValue];
        CGFloat h = [bounds[@"Height"] floatValue];
        if (w <= 50 || h <= 50) continue;

        NSString *title = win[(__bridge NSString *)kCGWindowName] ?: @"";
        NSNumber *wn  = win[(__bridge NSString *)kCGWindowNumber];
        NSNumber *pid = win[(__bridge NSString *)kCGWindowOwnerPID];

        napi_value obj;
        napi_create_object(env, &obj);
        napi_value v;
        napi_create_string_utf8(env, [ownerName UTF8String], NAPI_AUTO_LENGTH, &v);
        napi_set_named_property(env, obj, "app", v);
        napi_create_string_utf8(env, [title UTF8String], NAPI_AUTO_LENGTH, &v);
        napi_set_named_property(env, obj, "title", v);
        napi_create_int32(env, [wn intValue], &v);
        napi_set_named_property(env, obj, "windowNumber", v);
        napi_create_int32(env, [pid intValue], &v);
        napi_set_named_property(env, obj, "pid", v);

        napi_set_element(env, result, idx++, obj);
    }

    CFRelease(windowList);
    return result;
}

// ── AX 経由で PID のウィンドウ番号一覧を取得 ──
// transparent ウィンドウは CGWindowList に出ないため AXUIElement で取得する。
static napi_value GetWindowNumbersByPid(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    int32_t pid;
    napi_get_value_int32(env, args[0], &pid);

    napi_value result;
    napi_create_array(env, &result);
    uint32_t idx = 0;

    AXUIElementRef app = AXUIElementCreateApplication(pid);
    CFArrayRef windows = NULL;
    AXError axErr = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef *)&windows);
    NSLog(@"[tin] getWindowNumbersByPid pid=%d axErr=%d windows=%@", pid, axErr, windows ? @"ok" : @"nil");
    if (windows) {
        CFIndex count = CFArrayGetCount(windows);
        NSLog(@"[tin] window count=%ld", (long)count);
        for (CFIndex i = 0; i < count; i++) {
            AXUIElementRef win = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
            CGWindowID wid = 0;
            AXError widErr = _AXUIElementGetWindow(win, &wid);
            NSLog(@"[tin]   win[%ld] widErr=%d wid=%u", (long)i, widErr, wid);
            if (wid > 0) {
                napi_value numVal;
                napi_create_int32(env, (int32_t)wid, &numVal);
                napi_set_element(env, result, idx++, numVal);
            }
        }
        CFRelease(windows);
    }
    CFRelease(app);
    return result;
}

// ── Module init ──
static napi_value Init(napi_env env, napi_value exports) {
    napi_value fn;
    napi_create_function(env, NULL, 0, ListWindows, NULL, &fn);
    napi_set_named_property(env, exports, "listWindows", fn);

    napi_create_function(env, NULL, 0, MoveWindows, NULL, &fn);
    napi_set_named_property(env, exports, "moveWindows", fn);

    napi_create_function(env, NULL, 0, RaiseWindows, NULL, &fn);
    napi_set_named_property(env, exports, "raiseWindows", fn);

    napi_create_function(env, NULL, 0, GetWindowNumbersByPid, NULL, &fn);
    napi_set_named_property(env, exports, "getWindowNumbersByPid", fn);

    napi_create_function(env, NULL, 0, GetWindowIdFromHandle, NULL, &fn);
    napi_set_named_property(env, exports, "getWindowIdFromHandle", fn);

    napi_create_function(env, NULL, 0, SetWindowSticky, NULL, &fn);
    napi_set_named_property(env, exports, "setWindowSticky", fn);

    napi_create_function(env, NULL, 0, ListWindowsAllSpaces, NULL, &fn);
    napi_set_named_property(env, exports, "listWindowsAllSpaces", fn);

    napi_create_function(env, NULL, 0, IsAXTrusted, NULL, &fn);
    napi_set_named_property(env, exports, "isAXTrusted", fn);

    napi_create_function(env, NULL, 0, MoveToSpace, NULL, &fn);
    napi_set_named_property(env, exports, "moveToSpace", fn);

    napi_create_function(env, NULL, 0, MoveWindowsToActiveSpace, NULL, &fn);
    napi_set_named_property(env, exports, "moveWindowsToActiveSpace", fn);

    napi_create_function(env, NULL, 0, GetSpaceForWindows, NULL, &fn);
    napi_set_named_property(env, exports, "getSpaceForWindows", fn);

    napi_create_function(env, NULL, 0, GetSpacesList, NULL, &fn);
    napi_set_named_property(env, exports, "getSpacesList", fn);

    napi_create_function(env, NULL, 0, MoveWindowsToSpaceId, NULL, &fn);
    napi_set_named_property(env, exports, "moveWindowsToSpaceId", fn);

    napi_create_function(env, NULL, 0, GetFrontmostWindowNumber, NULL, &fn);
    napi_set_named_property(env, exports, "getFrontmostWindowNumber", fn);

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
