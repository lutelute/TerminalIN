// ax-helper.mm — N-API native addon for AXUIElement operations
// Electron main process 内で実行するため、TiN.app の TCC 権限を直接使用。
// daemon バイナリ不要。

#import <Foundation/Foundation.h>
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <node_api.h>
#include <dlfcn.h>
#include <string>
#include <vector>

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

// 普通のアプリの AX 要素の待ち時間 (既定 6 秒) を短くする。応答しないアプリ (しまった直後の Finder は
// 1.6〜3 秒止まった) が 1 つあるだけで、窓の一覧 (poll で 3 秒ごと) や配置のたびに TiN の main が固まっていた。
// 待ち時間は要素ごとなので、アプリの要素と、そこから取った窓の要素の両方に付ける。
// Dock (Mission Control) には付けない (縮小表示の読み取りが 0.5 秒を超えることがあり、運ぶのが崩れた)。
static const float AX_APP_TIMEOUT = 0.5f;

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

// ── list: CGWindowList で今見えている窓を列挙 (題名は AX で補う) ──
// 中身 (doListWindows) は N-API に触れない。同期版 (listWindows) と、専用の読み取りキューで動かす
// 非同期版 (listWindowsAsync、poll 用) がある。AX で題名を補う部分が遅いアプリで止まるため。
struct WinInfo { std::string app, title; int wn, pid, windowIndex, x, y, w, h; };

static std::vector<WinInfo> doListWindows() {
    std::vector<WinInfo> out;
    CFArrayRef windowList = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID);
    if (!windowList) return out;

    NSMutableDictionary<NSString*, NSNumber*> *appWindowCount = [NSMutableDictionary new];
    for (NSDictionary *win in (__bridge NSArray *)windowList) {
        NSString *ownerName = win[(__bridge NSString *)kCGWindowOwnerName];
        if (!ownerName) continue;
        NSNumber *layer = win[(__bridge NSString *)kCGWindowLayer];
        if (!layer || [layer intValue] != 0) continue;
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
        WinInfo wi;
        wi.app = [ownerName UTF8String] ?: "";
        wi.title = [title UTF8String] ?: "";
        wi.wn = [wn intValue]; wi.pid = [pid intValue]; wi.windowIndex = windowIndex;
        wi.x = (int)x; wi.y = (int)y; wi.w = (int)w; wi.h = (int)h;
        out.push_back(wi);
    }
    CFRelease(windowList);
    if (out.empty()) return out;

    // Screen Recording 権限がないと kCGWindowName が空になる。
    // Accessibility 権限経由の AX kAXTitleAttribute でタイトルを補完する。
    // PID ごとに AX ウィンドウ一覧を取得し、windowNumber → title をマップ
    NSMutableDictionary<NSNumber*, NSString*> *axTitleMap = [NSMutableDictionary new];
    NSMutableSet<NSNumber*> *processedPids = [NSMutableSet new];
    for (const WinInfo &wi : out) {
        NSNumber *pidKey = @(wi.pid);
        if ([processedPids containsObject:pidKey]) continue;
        [processedPids addObject:pidKey];
        AXUIElementRef appRef = AXUIElementCreateApplication((pid_t)wi.pid);
        AXUIElementSetMessagingTimeout(appRef, AX_APP_TIMEOUT);
        CFTypeRef wRef = NULL;
        if (AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute, &wRef) == kAXErrorSuccess && wRef) {
            CFArrayRef axWins = (CFArrayRef)wRef;
            CFIndex n = CFArrayGetCount(axWins);
            for (CFIndex j = 0; j < n; j++) {
                AXUIElementRef axWin = (AXUIElementRef)CFArrayGetValueAtIndex(axWins, j);
                AXUIElementSetMessagingTimeout(axWin, AX_APP_TIMEOUT);
                // AXWindowID を取得してマッピング
                CGWindowID wid = 0;
                CFTypeRef widRef = NULL;
                if (AXUIElementCopyAttributeValue(axWin, CFSTR("AXWindowID"), &widRef) == kAXErrorSuccess && widRef) {
                    if (CFGetTypeID(widRef) == CFNumberGetTypeID())
                        CFNumberGetValue((CFNumberRef)widRef, kCFNumberSInt32Type, &wid);
                    CFRelease(widRef);
                }
                if (wid == 0) _AXUIElementGetWindow(axWin, &wid);
                if (wid == 0) continue;
                CFTypeRef axTitleRef = NULL;
                if (AXUIElementCopyAttributeValue(axWin, kAXTitleAttribute, &axTitleRef) == kAXErrorSuccess && axTitleRef) {
                    NSString *axTitle = (__bridge_transfer NSString *)axTitleRef;
                    if (axTitle.length > 0) axTitleMap[@(wid)] = axTitle;
                }
            }
            CFRelease(wRef);
        }
        CFRelease(appRef);
    }
    if (axTitleMap.count > 0) {
        for (WinInfo &wi : out) {
            NSString *axTitle = axTitleMap[@(wi.wn)];
            if (axTitle) wi.title = [axTitle UTF8String] ?: wi.title;
        }
    }
    return out;
}

static napi_value winInfosToJs(napi_env env, const std::vector<WinInfo> &list) {
    napi_value result;
    napi_create_array(env, &result);
    uint32_t idx = 0;
    for (const WinInfo &wi : list) {
        napi_value obj, v;
        napi_create_object(env, &obj);
        napi_create_string_utf8(env, wi.app.c_str(), NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, obj, "app", v);
        napi_create_string_utf8(env, wi.title.c_str(), NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, obj, "title", v);
        napi_create_int32(env, wi.wn, &v); napi_set_named_property(env, obj, "windowNumber", v);
        napi_create_int32(env, wi.pid, &v); napi_set_named_property(env, obj, "pid", v);
        napi_create_int32(env, wi.windowIndex, &v); napi_set_named_property(env, obj, "windowIndex", v);
        napi_create_int32(env, wi.x, &v); napi_set_named_property(env, obj, "x", v);
        napi_create_int32(env, wi.y, &v); napi_set_named_property(env, obj, "y", v);
        napi_create_int32(env, wi.w, &v); napi_set_named_property(env, obj, "width", v);
        napi_create_int32(env, wi.h, &v); napi_set_named_property(env, obj, "height", v);
        napi_set_element(env, result, idx++, obj);
    }
    return result;
}

static napi_value ListWindows(napi_env env, napi_callback_info info) {
    ensureTerminalApps();
    return winInfosToJs(env, doListWindows());
}

static dispatch_queue_t axReadQueue() {
    static dispatch_queue_t q = NULL;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ q = dispatch_queue_create("tin.ax.read", DISPATCH_QUEUE_SERIAL); });
    return q;
}
struct ListJob { std::vector<WinInfo> list; napi_deferred deferred; napi_threadsafe_function tsfn; };
static void listJobDone(napi_env env, napi_value, void *, void *data) {
    ListJob *job = (ListJob *)data;
    if (env) napi_resolve_deferred(env, job->deferred, winInfosToJs(env, job->list));
    delete job;
}
static napi_value ListWindowsAsync(napi_env env, napi_callback_info info) {
    ensureTerminalApps();
    ListJob *job = new ListJob();
    napi_value promise, name;
    napi_create_promise(env, &job->deferred, &promise);
    napi_create_string_utf8(env, "tin.ax.list", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, NULL, NULL, NULL, listJobDone, &job->tsfn) != napi_ok) {
        napi_resolve_deferred(env, job->deferred, winInfosToJs(env, doListWindows()));
        delete job;
        return promise;
    }
    napi_threadsafe_function tsfn = job->tsfn;
    dispatch_async(axReadQueue(), ^{
        @autoreleasepool { job->list = doListWindows(); }
        napi_call_threadsafe_function(tsfn, job, napi_tsfn_blocking);
        napi_release_threadsafe_function(tsfn, napi_tsfn_release);
    });
    return promise;
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
// ── move: AX で位置と大きさを書く ──
// 中身 (doMoveWindows) は N-API に触れない。同期版 (moveWindows) は JS のスレッドでそのまま、
// 非同期版 (moveWindowsAsync) は専用の直列キューで動かして Promise で返す。遅いアプリ
// (PowerPoint は 1 回 150〜500ms、しまった直後の Finder は数秒) で TiN の main を止めないため。
// 直列なので、同じ窓への書き込みが前後することはない。
struct MoveCmd { pid_t pid; int wn; double x, y, w, h; std::string title; int windowIndex; };
struct MoveResult { int wn; bool found; int errPos; int errSize; double x, y, w, h; };

static std::vector<MoveCmd> parseMoveCmds(napi_env env, napi_value arr, bool positionOnly) {
    std::vector<MoveCmd> out;
    uint32_t length = 0;
    napi_get_array_length(env, arr, &length);
    for (uint32_t i = 0; i < length; i++) {
        napi_value item, v;
        napi_get_element(env, arr, i, &item);
        MoveCmd c = { 0, 0, 0, 0, 0, 0, "", -1 };
        int32_t pid = 0, wn = 0, wi = -1;
        if (napi_get_named_property(env, item, "pid", &v) == napi_ok) napi_get_value_int32(env, v, &pid);
        if (napi_get_named_property(env, item, "windowNumber", &v) == napi_ok) napi_get_value_int32(env, v, &wn);
        if (napi_get_named_property(env, item, "x", &v) == napi_ok) napi_get_value_double(env, v, &c.x);
        if (napi_get_named_property(env, item, "y", &v) == napi_ok) napi_get_value_double(env, v, &c.y);
        if (!positionOnly) {
            if (napi_get_named_property(env, item, "width", &v) == napi_ok) napi_get_value_double(env, v, &c.w);
            if (napi_get_named_property(env, item, "height", &v) == napi_ok) napi_get_value_double(env, v, &c.h);
        }
        char title[256] = "";
        size_t titleLen = 0;
        if (napi_get_named_property(env, item, "title", &v) == napi_ok) napi_get_value_string_utf8(env, v, title, sizeof(title), &titleLen);
        if (napi_get_named_property(env, item, "windowIndex", &v) == napi_ok) napi_get_value_int32(env, v, &wi);
        c.pid = (pid_t)pid; c.wn = wn; c.title = title; c.windowIndex = wi;
        out.push_back(c);
    }
    return out;
}

static std::vector<MoveResult> doMoveWindows(const std::vector<MoveCmd> &cmds, bool positionOnly, bool detail, int *movedOut) {
    std::vector<MoveResult> results;
    int moved = 0;
    // 同一 pid のウィンドウ一覧を使い回すためのキャッシュ。
    // sidebar drag 時に 4 ウィンドウを同一 pid で処理するケースで AX 列挙を 4→1 に削減。
    // eui: そのアプリの AXEnhancedUserInterface を一時的に切ったか (最後に戻す)
    struct AppCache { pid_t pid; AXUIElementRef appRef; CFArrayRef windowsRef; bool eui; };
    AppCache cache[16] = {};
    int cacheSize = 0;

    for (const MoveCmd &c : cmds) {
        CFArrayRef windowsRef = NULL;
        bool cacheHit = false;
        for (int ci = 0; ci < cacheSize; ci++) {
            if (cache[ci].pid == c.pid) { windowsRef = cache[ci].windowsRef; cacheHit = true; break; }
        }
        if (!cacheHit) {
            AXUIElementRef appRef = AXUIElementCreateApplication(c.pid);
            // 応答しないアプリ (しまった直後の Finder など) で長く止まらないよう、待ちを短くする
            AXUIElementSetMessagingTimeout(appRef, AX_APP_TIMEOUT);
            CFTypeRef wRef = NULL;
            if (AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute, &wRef) != kAXErrorSuccess) {
                CFRelease(appRef);
                if (cacheSize < 16) cache[cacheSize++] = { c.pid, NULL, NULL, false };
                wRef = NULL;
            } else {
                windowsRef = (CFArrayRef)wRef;
                // AXEnhancedUserInterface が有効なアプリ (補助機能を使うアプリが立てる。Finder で実測) は、
                // 位置と大きさを続けて書くと大きさを無視したり位置が崩れたりする。書く間だけ切って最後に戻す。
                bool eui = false;
                if (!positionOnly) {
                    CFTypeRef ev = NULL;
                    if (AXUIElementCopyAttributeValue(appRef, CFSTR("AXEnhancedUserInterface"), &ev) == kAXErrorSuccess && ev) {
                        if (CFGetTypeID(ev) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)ev)) {
                            eui = AXUIElementSetAttributeValue(appRef, CFSTR("AXEnhancedUserInterface"), kCFBooleanFalse) == kAXErrorSuccess;
                        }
                        CFRelease(ev);
                    }
                }
                if (cacheSize < 16) cache[cacheSize++] = { c.pid, appRef, windowsRef, eui };
                else {
                    if (eui) AXUIElementSetAttributeValue(appRef, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
                    CFRelease(appRef); CFRelease(windowsRef); windowsRef = NULL;
                }
            }
        }

        AXUIElementRef win = windowsRef ? findAXWindowInList(windowsRef, c.wn, c.title.c_str(), c.windowIndex) : NULL;
        if (!win) {
            if (detail) results.push_back({ c.wn, false, 0, 0, 0, 0, 0, 0 });
            continue;
        }
        AXUIElementSetMessagingTimeout(win, AX_APP_TIMEOUT);
        AXError errPos = kAXErrorSuccess, errSize = kAXErrorSuccess;

        CGPoint point = CGPointMake(c.x, c.y);
        AXValueRef posVal = AXValueCreate((AXValueType)kAXValueCGPointType, &point);
        if (positionOnly) {
            if (posVal) { errPos = AXUIElementSetAttributeValue(win, kAXPositionAttribute, posVal); CFRelease(posVal); }
        } else {
            // Terminal.app は set size で独自に window を動かすので pos-size-pos で上書き。
            CGSize size = CGSizeMake(c.w, c.h);
            AXValueRef sizeVal = AXValueCreate((AXValueType)kAXValueCGSizeType, &size);
            if (posVal) AXUIElementSetAttributeValue(win, kAXPositionAttribute, posVal);
            if (sizeVal) { errSize = AXUIElementSetAttributeValue(win, kAXSizeAttribute, sizeVal); CFRelease(sizeVal); }
            if (posVal) errPos = AXUIElementSetAttributeValue(win, kAXPositionAttribute, posVal);
            if (posVal) CFRelease(posVal);
        }

        if (detail) {
            CGPoint ap = CGPointZero; CGSize as = CGSizeZero; CFTypeRef pv = NULL, sv = NULL;
            if (AXUIElementCopyAttributeValue(win, kAXPositionAttribute, &pv) == kAXErrorSuccess && pv) { AXValueGetValue((AXValueRef)pv, (AXValueType)kAXValueCGPointType, &ap); CFRelease(pv); }
            if (AXUIElementCopyAttributeValue(win, kAXSizeAttribute, &sv) == kAXErrorSuccess && sv) { AXValueGetValue((AXValueRef)sv, (AXValueType)kAXValueCGSizeType, &as); CFRelease(sv); }
            results.push_back({ c.wn, true, (int)errPos, (int)errSize, ap.x, ap.y, as.width, as.height });
        }
        moved++;
        CFRelease(win);
    }

    // キャッシュ解放 (切った AXEnhancedUserInterface は戻す)
    for (int ci = 0; ci < cacheSize; ci++) {
        if (cache[ci].eui && cache[ci].appRef) AXUIElementSetAttributeValue(cache[ci].appRef, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
        if (cache[ci].windowsRef) CFRelease(cache[ci].windowsRef);
        if (cache[ci].appRef) CFRelease(cache[ci].appRef);
    }
    if (movedOut) *movedOut = moved;
    return results;
}

// detail=true: 窓ごとの結果 [{ windowNumber, found, errPos, errSize, x, y, width, height }] を返す
// (書いたあとに AX から読み戻した実際の枠。効いたかどうかを呼び手が確かめられる)
static napi_value moveResultToJs(napi_env env, const std::vector<MoveResult> &rs, bool detail, int moved) {
    if (!detail) { napi_value r; napi_create_int32(env, moved, &r); return r; }
    napi_value arr; napi_create_array(env, &arr);
    uint32_t i = 0;
    for (const MoveResult &m : rs) {
        napi_value o, dv; napi_create_object(env, &o);
        napi_create_int32(env, m.wn, &dv); napi_set_named_property(env, o, "windowNumber", dv);
        napi_get_boolean(env, m.found, &dv); napi_set_named_property(env, o, "found", dv);
        if (m.found) {
            napi_create_int32(env, m.errPos, &dv); napi_set_named_property(env, o, "errPos", dv);
            napi_create_int32(env, m.errSize, &dv); napi_set_named_property(env, o, "errSize", dv);
            napi_create_double(env, m.x, &dv); napi_set_named_property(env, o, "x", dv);
            napi_create_double(env, m.y, &dv); napi_set_named_property(env, o, "y", dv);
            napi_create_double(env, m.w, &dv); napi_set_named_property(env, o, "width", dv);
            napi_create_double(env, m.h, &dv); napi_set_named_property(env, o, "height", dv);
        }
        napi_set_element(env, arr, i++, o);
    }
    return arr;
}

static napi_value MoveWindows(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    bool positionOnly = false, detail = false;
    if (argc >= 2) napi_get_value_bool(env, args[1], &positionOnly);
    if (argc >= 3) napi_get_value_bool(env, args[2], &detail);
    std::vector<MoveCmd> cmds = parseMoveCmds(env, args[0], positionOnly);
    int moved = 0;
    std::vector<MoveResult> rs = doMoveWindows(cmds, positionOnly, detail, &moved);
    return moveResultToJs(env, rs, detail, moved);
}

// 非同期版。結果は同期版と同じ形で Promise に入る
static dispatch_queue_t axQueue() {
    static dispatch_queue_t q = NULL;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ q = dispatch_queue_create("tin.ax.move", DISPATCH_QUEUE_SERIAL); });
    return q;
}
struct MoveJob {
    std::vector<MoveCmd> cmds; bool positionOnly; bool detail;
    std::vector<MoveResult> results; int moved;
    napi_deferred deferred; napi_threadsafe_function tsfn;
};
static void moveJobDone(napi_env env, napi_value /*js_cb*/, void * /*context*/, void *data) {
    MoveJob *job = (MoveJob *)data;
    if (env) {
        napi_value r = moveResultToJs(env, job->results, job->detail, job->moved);
        napi_resolve_deferred(env, job->deferred, r);
    }
    delete job;
}
static napi_value MoveWindowsAsync(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    MoveJob *job = new MoveJob();
    job->positionOnly = false; job->detail = false; job->moved = 0;
    if (argc >= 2) napi_get_value_bool(env, args[1], &job->positionOnly);
    if (argc >= 3) napi_get_value_bool(env, args[2], &job->detail);
    job->cmds = parseMoveCmds(env, args[0], job->positionOnly);
    napi_value promise, name;
    napi_create_promise(env, &job->deferred, &promise);
    napi_create_string_utf8(env, "tin.ax.move", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, NULL, NULL, NULL, moveJobDone, &job->tsfn) != napi_ok) {
        // 作れなければ同期で済ませる
        job->results = doMoveWindows(job->cmds, job->positionOnly, job->detail, &job->moved);
        napi_value r = moveResultToJs(env, job->results, job->detail, job->moved);
        napi_resolve_deferred(env, job->deferred, r);
        delete job;
        return promise;
    }
    napi_threadsafe_function tsfn = job->tsfn;
    dispatch_async(axQueue(), ^{
        @autoreleasepool {
            job->results = doMoveWindows(job->cmds, job->positionOnly, job->detail, &job->moved);
        }
        napi_call_threadsafe_function(tsfn, job, napi_tsfn_blocking);
        napi_release_threadsafe_function(tsfn, napi_tsfn_release);
    });
    return promise;
}

// ── raise: AXRaise ──
// 中身 (doRaiseWindows) は N-API に触れない。非同期版 (raiseWindowsAsync) は窓を動かすのと同じ直列キューで
// 動かす (動かしてから上げる、の順が崩れない)。
static int doRaiseWindows(const std::vector<MoveCmd> &cmds) {
    int raised = 0;
    // MoveWindows と同じ per-pid キャッシュ
    struct AppCache { pid_t pid; AXUIElementRef appRef; CFArrayRef windowsRef; };
    AppCache cache[16] = {};
    int cacheSize = 0;
    for (const MoveCmd &c : cmds) {
        CFArrayRef windowsRef = NULL;
        bool cacheHit = false;
        for (int ci = 0; ci < cacheSize; ci++) {
            if (cache[ci].pid == c.pid) { windowsRef = cache[ci].windowsRef; cacheHit = true; break; }
        }
        if (!cacheHit) {
            AXUIElementRef appRef = AXUIElementCreateApplication(c.pid);
            AXUIElementSetMessagingTimeout(appRef, AX_APP_TIMEOUT);
            CFTypeRef wRef = NULL;
            if (AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute, &wRef) != kAXErrorSuccess) {
                CFRelease(appRef);
                if (cacheSize < 16) cache[cacheSize++] = { c.pid, NULL, NULL };
                continue;
            }
            windowsRef = (CFArrayRef)wRef;
            if (cacheSize < 16) cache[cacheSize++] = { c.pid, appRef, windowsRef };
            else { CFRelease(appRef); CFRelease(windowsRef); continue; }
        }
        if (!windowsRef) continue;
        AXUIElementRef win = findAXWindowInList(windowsRef, c.wn, c.title.c_str(), c.windowIndex);
        if (!win) continue;
        AXUIElementSetMessagingTimeout(win, AX_APP_TIMEOUT);
        if (AXUIElementPerformAction(win, kAXRaiseAction) == kAXErrorSuccess) raised++;
        CFRelease(win);
    }
    for (int ci = 0; ci < cacheSize; ci++) {
        if (cache[ci].windowsRef) CFRelease(cache[ci].windowsRef);
        if (cache[ci].appRef) CFRelease(cache[ci].appRef);
    }
    return raised;
}

static napi_value RaiseWindows(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    std::vector<MoveCmd> cmds = parseMoveCmds(env, args[0], true);
    napi_value result;
    napi_create_int32(env, doRaiseWindows(cmds), &result);
    return result;
}

struct RaiseJob { std::vector<MoveCmd> cmds; int raised; napi_deferred deferred; napi_threadsafe_function tsfn; };
static void raiseJobDone(napi_env env, napi_value, void *, void *data) {
    RaiseJob *job = (RaiseJob *)data;
    if (env) { napi_value r; napi_create_int32(env, job->raised, &r); napi_resolve_deferred(env, job->deferred, r); }
    delete job;
}
static napi_value RaiseWindowsAsync(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    RaiseJob *job = new RaiseJob();
    job->raised = 0;
    job->cmds = parseMoveCmds(env, args[0], true);
    napi_value promise, name;
    napi_create_promise(env, &job->deferred, &promise);
    napi_create_string_utf8(env, "tin.ax.raise", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, NULL, NULL, NULL, raiseJobDone, &job->tsfn) != napi_ok) {
        napi_value r; napi_create_int32(env, doRaiseWindows(job->cmds), &r);
        napi_resolve_deferred(env, job->deferred, r);
        delete job;
        return promise;
    }
    napi_threadsafe_function tsfn = job->tsfn;
    dispatch_async(axQueue(), ^{
        @autoreleasepool { job->raised = doRaiseWindows(job->cmds); }
        napi_call_threadsafe_function(tsfn, job, napi_tsfn_blocking);
        napi_release_threadsafe_function(tsfn, napi_tsfn_release);
    });
    return promise;
}

// activateApp(pid) → bool
// 指定 pid のアプリを前面(アクティブ)にする。
//
// なぜ必要か: kAXRaiseAction は「そのアプリの中で」窓を前に出すだけで、アプリ自体は
// アクティブにならない。グリッド越しのクリックが TiN に吸われた場合、救済で窓を
// raise してもキーボードフォーカスは TiN に残るため、ユーザーは端末を選ぶのに
// もう一度クリックする羽目になる。raise の直後にこれを呼んで初めて「選んだ」になる。
//
// NSApplicationActivateAllWindows は付けない。付けると snap していない同じアプリの
// 他の窓まで一緒にせり上がってきてグリッドを覆う。
static napi_value ActivateApp(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    int32_t pid = 0;
    napi_get_value_int32(env, args[0], &pid);

    bool ok = false;
    if (pid > 0) {
        // 1) AX 経路 (kAXFrontmost)。この addon は Electron main 内で動き TiN の
        //    Accessibility 権限をそのまま使えるので、ファイル内の他の操作と同じ土俵で済む。
        AXUIElementRef appRef = AXUIElementCreateApplication((pid_t)pid);
        if (appRef) {
            AXUIElementSetMessagingTimeout(appRef, AX_APP_TIMEOUT);
            if (AXUIElementSetAttributeValue(appRef, kAXFrontmostAttribute, kCFBooleanTrue)
                == kAXErrorSuccess) ok = true;
            CFRelease(appRef);
        }
        // 2) AX が拒否された場合のフォールバック (権限が落ちている等)。
        if (!ok) {
            NSRunningApplication *app =
                [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid];
            if (app) ok = [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
        }
    }

    napi_value result;
    napi_get_boolean(env, ok, &result);
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
        NSString *displayId = d[@"Display Identifier"] ?: @"";
        // そのディスプレイで今見えているデスクトップ (isCurrent はキーボードの行き先の 1 つだけ)
        NSDictionary *curSpace = d[@"Current Space"];
        uint64_t visibleId = [(curSpace[@"id64"] ?: curSpace[@"ManagedSpaceID"]) unsignedLongLongValue];
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
            // type: 0 = 通常のデスクトップ, 4 = フルスクリーンのアプリ (窓を運び込めない)
            napi_create_int32(env, [s[@"type"] intValue], &v);
            napi_set_named_property(env, entry, "type", v);
            napi_create_string_utf8(env, [displayId UTF8String], NAPI_AUTO_LENGTH, &v);
            napi_set_named_property(env, entry, "display", v);
            napi_get_boolean(env, spaceId == visibleId, &v);
            napi_set_named_property(env, entry, "isVisible", v);
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

        // Add/Remove fallback (moveWindowsToSpaceId と同じ方式)
        if (spaceAfter != activeSpace && spaceBefore > 0) {
            CFArrayRef winCF  = (__bridge CFArrayRef)@[@(wn)];
            CFArrayRef toArr  = (__bridge CFArrayRef)@[@((int64_t)activeSpace)];
            CFArrayRef fromArr= (__bridge CFArrayRef)@[@((int64_t)spaceBefore)];
            int addCid = (ownerCid > 0) ? ownerCid : cid;
            CGSAddWindowsToSpaces(addCid, winCF, toArr);
            usleep(10000);
            if (pfnSLSCopySpacesForWindows) {
                CFArrayRef sp = pfnSLSCopySpacesForWindows(cid, 7, (__bridge CFArrayRef)@[@(wn)]);
                if (sp && CFArrayGetCount(sp) > 0) { CFNumberGetValue((CFNumberRef)CFArrayGetValueAtIndex(sp, 0), kCFNumberSInt64Type, &spaceAfter); CFRelease(sp); }
            }
            if (spaceAfter == activeSpace) {
                CGSRemoveWindowsFromSpaces(addCid, winCF, fromArr);
                usleep(5000);
            } else {
                // ownerCid と cid 両方で試みる
                CGSAddWindowsToSpaces(cid, winCF, toArr);
                usleep(10000);
                if (pfnSLSCopySpacesForWindows) {
                    CFArrayRef sp = pfnSLSCopySpacesForWindows(cid, 7, (__bridge CFArrayRef)@[@(wn)]);
                    if (sp && CFArrayGetCount(sp) > 0) { CFNumberGetValue((CFNumberRef)CFArrayGetValueAtIndex(sp, 0), kCFNumberSInt64Type, &spaceAfter); CFRelease(sp); }
                }
                if (spaceAfter == activeSpace) {
                    CGSRemoveWindowsFromSpaces(cid, winCF, fromArr);
                    usleep(5000);
                }
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

// ── マウス左ボタンが押されているか ──
// ウィンドウのレベル/重ね順をドラッグの途中で変えないための判定に使う。
// pressedMouseButtons はアプリがアクティブでなくてもグローバルな押下状態を返す。
static napi_value IsMouseButtonDown(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_get_boolean(env, ([NSEvent pressedMouseButtons] & 1) != 0, &result);
    return result;
}

// ── 最前面ウィンドウの CGWindowNumber を取得 ──
// z-order 上位の layer=0 normal window を返す。一致なければ 0。
// 省略可能な第1引数: 飛ばす CGWindowID の配列。TiN 本体はフォーカス中に通常レベルへ
// 上がるので、除外しないと「最前面 = TiN 自身」になり snap/unsnap が空振りする。
static napi_value GetFrontmostWindowNumber(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    NSMutableSet<NSNumber *> *skip = [NSMutableSet set];
    bool isArr = false;
    if (argc >= 1 && napi_is_array(env, args[0], &isArr) == napi_ok && isArr) {
        uint32_t len = 0;
        napi_get_array_length(env, args[0], &len);
        for (uint32_t i = 0; i < len; i++) {
            napi_value el; int32_t v = 0;
            if (napi_get_element(env, args[0], i, &el) == napi_ok &&
                napi_get_value_int32(env, el, &v) == napi_ok && v > 0) [skip addObject:@(v)];
        }
    }
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
            if (wn && [skip containsObject:@([wn intValue])]) continue;
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
        if (!ownerName) continue;
        NSNumber *layer = win[(__bridge NSString *)kCGWindowLayer];
        if (!layer || [layer intValue] != 0) continue;

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
//
// 注意: kAXWindows は「そのアプリの全ウィンドウ」ではない。別 Space の窓が
// 落ちることがある (実測: 現存する Terminal の窓 3 つが出てこなかった)。
// ここに出てくることは生存の証拠になるが、出てこないことは閉じた証拠にならない。
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
    AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef *)&windows);
    if (windows) {
        CFIndex count = CFArrayGetCount(windows);
        for (CFIndex i = 0; i < count; i++) {
            AXUIElementRef win = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
            CGWindowID wid = 0;
            _AXUIElementGetWindow(win, &wid);
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
// ── 外部の窓を別デスクトップへ「運ぶ」ための部品 (lib/space-carry.js が順に呼ぶ) ──
// macOS 26 では他アプリの窓を Space 間で動かす private API が全て塞がれている
// (SLSMoveWindowsToManagedSpace / 互換 ID / Add+Remove、2026-11-03 実測)。
// 残る手は人の操作の再現 = 「タイトルバーを掴んだまま、デスクトップ切替のショートカットを押す」。
// ここでは 1 操作ずつの部品だけを出し、順番と待ち時間は JS 側で組み立てる
// (main thread を usleep で長く止めないため)。

// getActiveSpaceId() → 今見えているデスクトップの Space ID
static napi_value GetActiveSpaceId(napi_env env, napi_callback_info info) {
    int cid = spaceCid();
    napi_value v;
    napi_create_int64(env, (int64_t)spaceGetActive(cid), &v);
    return v;
}

typedef CGError (*PFN_SLSGetWindowTags)(int cid, uint32_t wid, uint64_t *tags, int size);
static PFN_SLSGetWindowTags pfnGetTags() {
    static PFN_SLSGetWindowTags f = NULL;
    static bool done = false;
    if (!done) {
        done = true;
        void *h = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY);
        if (h) f = (PFN_SLSGetWindowTags)dlsym(h, "SLSGetWindowTags");
    }
    return f;
}

// hitTestPoint(x, y) → { wn, pid, layer, app } | null
// その点をクリックしたら受け取る窓 (前から順に見て、クリックを素通しする窓は飛ばす)。
// 素通しの判定は窓タグの bit 9 (ignoresMouseEvents)。例: Seclitary の全画面の透明な帯。
// 合成のマウスを押す前に「掴むのは本当に運びたい窓か」を確かめるために使う。
static napi_value HitTestPoint(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    double x = 0, y = 0;
    napi_get_value_double(env, args[0], &x);
    napi_get_value_double(env, args[1], &y);
    CGPoint p = CGPointMake(x, y);

    napi_value result;
    napi_get_null(env, &result);
    CFArrayRef list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (!list) return result;
    int cid = spaceCid();
    PFN_SLSGetWindowTags getTags = pfnGetTags();
    for (NSDictionary *w in (__bridge NSArray *)list) {
        int layer = [w[(__bridge NSString *)kCGWindowLayer] intValue];
        if (layer >= kCGCursorWindowLevel) continue;   // カーソル・システムの最上位は対象外
        CGRect r;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(__bridge NSString *)kCGWindowBounds], &r)) continue;
        if (!CGRectContainsPoint(r, p)) continue;
        if ([w[(__bridge NSString *)kCGWindowAlpha] doubleValue] <= 0.0) continue;
        uint32_t wid = [w[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
        if (getTags) {
            uint64_t tags = 0;
            if (getTags(cid, wid, &tags, 64) == kCGErrorSuccess && ((tags >> 9) & 1)) continue;
        }
        napi_value obj, v;
        napi_create_object(env, &obj);
        napi_create_int32(env, (int32_t)wid, &v);
        napi_set_named_property(env, obj, "wn", v);
        napi_create_int32(env, [w[(__bridge NSString *)kCGWindowOwnerPID] intValue], &v);
        napi_set_named_property(env, obj, "pid", v);
        napi_create_int32(env, layer, &v);
        napi_set_named_property(env, obj, "layer", v);
        NSString *owner = w[(__bridge NSString *)kCGWindowOwnerName] ?: @"";
        napi_create_string_utf8(env, [owner UTF8String], NAPI_AUTO_LENGTH, &v);
        napi_set_named_property(env, obj, "app", v);
        result = obj;
        break;
    }
    CFRelease(list);
    return result;
}

// getWindowBounds(windowNumbers[]) → [{ wn, x, y, width, height }]
// 別 Space の窓でも取れる (CGWindowListCreateDescriptionFromArray)。
static napi_value GetWindowBounds(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    uint32_t length = 0;
    napi_get_array_length(env, args[0], &length);
    NSMutableArray *ids = [NSMutableArray array];
    for (uint32_t i = 0; i < length; i++) {
        napi_value item; int32_t wn = 0;
        napi_get_element(env, args[0], i, &item);
        napi_get_value_int32(env, item, &wn);
        [ids addObject:@(wn)];
    }
    napi_value result;
    napi_create_array(env, &result);
    if (!ids.count) return result;
    // CGWindowListCreateDescriptionFromArray は CGWindowID の CFArray を要求する (CFNumber 不可)
    CFMutableArrayRef arr = CFArrayCreateMutable(NULL, ids.count, NULL);
    for (NSNumber *n in ids) CFArrayAppendValue(arr, (const void *)(uintptr_t)[n unsignedIntValue]);
    CFArrayRef desc = CGWindowListCreateDescriptionFromArray(arr);
    CFRelease(arr);
    if (!desc) return result;
    uint32_t idx = 0;
    for (NSDictionary *w in (__bridge NSArray *)desc) {
        CGRect r;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(__bridge NSString *)kCGWindowBounds], &r)) continue;
        napi_value obj, v;
        napi_create_object(env, &obj);
        napi_create_int32(env, [w[(__bridge NSString *)kCGWindowNumber] intValue], &v);
        napi_set_named_property(env, obj, "wn", v);
        napi_create_double(env, r.origin.x, &v);    napi_set_named_property(env, obj, "x", v);
        napi_create_double(env, r.origin.y, &v);    napi_set_named_property(env, obj, "y", v);
        napi_create_double(env, r.size.width, &v);  napi_set_named_property(env, obj, "width", v);
        napi_create_double(env, r.size.height, &v); napi_set_named_property(env, obj, "height", v);
        napi_set_element(env, result, idx++, obj);
    }
    CFRelease(desc);
    return result;
}

// postMouse(kind, x, y) — kind: "move" | "down" | "drag" | "up" (左ボタン)
static napi_value PostMouse(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    char kind[8] = "";
    size_t len = 0;
    napi_get_value_string_utf8(env, args[0], kind, sizeof(kind), &len);
    double x = 0, y = 0;
    napi_get_value_double(env, args[1], &x);
    napi_get_value_double(env, args[2], &y);
    CGEventType t = kCGEventMouseMoved;
    if (!strcmp(kind, "down")) t = kCGEventLeftMouseDown;
    else if (!strcmp(kind, "drag")) t = kCGEventLeftMouseDragged;
    else if (!strcmp(kind, "up")) t = kCGEventLeftMouseUp;
    CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    CGEventRef e = CGEventCreateMouseEvent(src, t, CGPointMake(x, y), kCGMouseButtonLeft);
    bool ok = e != NULL;
    if (e) {
        if (t == kCGEventLeftMouseDown || t == kCGEventLeftMouseUp || t == kCGEventLeftMouseDragged)
            CGEventSetIntegerValueField(e, kCGMouseEventClickState, 1);
        CGEventPost(kCGHIDEventTap, e);
        CFRelease(e);
    }
    if (src) CFRelease(src);
    napi_value v;
    napi_get_boolean(env, ok, &v);
    return v;
}

// getSpaceHotkeys() → { left: {enabled, keyCode, modifiers}, right: {...} }
// システム設定 > キーボード > ショートカット > Mission Control の
// 「左/右の操作スペースに移動」(AppleSymbolicHotKeys 79 / 81)。ユーザーが割り当てを
// 変えていればその割り当てを返す。項目が無ければ既定 (Ctrl+←/→、有効)。
static napi_value GetSpaceHotkeys(napi_env env, napi_callback_info info) {
    NSDictionary *all = (__bridge_transfer NSDictionary *)CFPreferencesCopyAppValue(
        CFSTR("AppleSymbolicHotKeys"), CFSTR("com.apple.symbolichotkeys"));
    napi_value result;
    napi_create_object(env, &result);
    const char *names[2] = { "left", "right" };
    NSString *keys[2] = { @"79", @"81" };
    int defaultCodes[2] = { 123, 124 };
    for (int i = 0; i < 2; i++) {
        bool enabled = true;
        int keyCode = defaultCodes[i];
        int64_t mods = 0x840000;   // Control | Fn (矢印キーは Fn 付きで届く)
        NSDictionary *hk = [all isKindOfClass:[NSDictionary class]] ? all[keys[i]] : nil;
        if ([hk isKindOfClass:[NSDictionary class]]) {
            if (hk[@"enabled"]) enabled = [hk[@"enabled"] boolValue];
            NSArray *params = hk[@"value"][@"parameters"];
            if ([params isKindOfClass:[NSArray class]] && params.count >= 3) {
                keyCode = [params[1] intValue];
                mods = [params[2] longLongValue];
            }
        }
        napi_value obj, v;
        napi_create_object(env, &obj);
        napi_get_boolean(env, enabled, &v);         napi_set_named_property(env, obj, "enabled", v);
        napi_create_int32(env, keyCode, &v);        napi_set_named_property(env, obj, "keyCode", v);
        napi_create_int64(env, mods, &v);           napi_set_named_property(env, obj, "modifiers", v);
        napi_set_named_property(env, result, names[i], obj);
    }
    return result;
}

// postHotkey(keyCode, modifiers) — 実キーボードと同じ並びで送る:
// 修飾キーを押す (flagsChanged) → キー down/up → 修飾キーを離す (flagsChanged)。
// 修飾キーの「離した」を送らないと、Dock が Control を押しっぱなしと見て、その後の
// 合成ドラッグで窓が動かなくなる (2026-11-03 実測。これが「運べたり運べなかったり」の正体)。
static napi_value PostHotkey(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    int32_t keyCode = 0;
    int64_t mods = 0;
    napi_get_value_int32(env, args[0], &keyCode);
    napi_get_value_int64(env, args[1], &mods);

    struct Mod { CGEventFlags flag; CGKeyCode key; };
    const Mod order[4] = {
        { kCGEventFlagMaskControl,   59 },
        { kCGEventFlagMaskAlternate, 58 },
        { kCGEventFlagMaskShift,     56 },
        { kCGEventFlagMaskCommand,   55 },
    };
    CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    CGEventFlags held = 0;
    for (int i = 0; i < 4; i++) {
        if (!(mods & order[i].flag)) continue;
        held |= order[i].flag;
        CGEventRef e = CGEventCreateKeyboardEvent(src, order[i].key, true);
        CGEventSetType(e, kCGEventFlagsChanged);
        CGEventSetFlags(e, held);
        CGEventPost(kCGHIDEventTap, e); CFRelease(e);
        usleep(12000);
    }
    CGEventFlags keyFlags = held | (CGEventFlags)(mods & kCGEventFlagMaskSecondaryFn);
    if (keyCode >= 123 && keyCode <= 126) keyFlags |= kCGEventFlagMaskNumericPad | kCGEventFlagMaskSecondaryFn;
    CGEventRef d = CGEventCreateKeyboardEvent(src, (CGKeyCode)keyCode, true);
    CGEventSetFlags(d, keyFlags); CGEventPost(kCGHIDEventTap, d); CFRelease(d);
    usleep(20000);
    CGEventRef u = CGEventCreateKeyboardEvent(src, (CGKeyCode)keyCode, false);
    CGEventSetFlags(u, keyFlags); CGEventPost(kCGHIDEventTap, u); CFRelease(u);
    for (int i = 3; i >= 0; i--) {
        if (!(mods & order[i].flag)) continue;
        usleep(12000);
        held &= ~order[i].flag;
        CGEventRef e = CGEventCreateKeyboardEvent(src, order[i].key, false);
        CGEventSetType(e, kCGEventFlagsChanged);
        CGEventSetFlags(e, held);
        CGEventPost(kCGHIDEventTap, e); CFRelease(e);
    }
    if (src) CFRelease(src);
    napi_value v;
    napi_get_undefined(env, &v);
    return v;
}

// getCursorPosition() → {x, y} / warpCursor(x, y)
static napi_value GetCursorPosition(napi_env env, napi_callback_info info) {
    CGEventRef e = CGEventCreate(NULL);
    CGPoint p = e ? CGEventGetLocation(e) : CGPointZero;
    if (e) CFRelease(e);
    napi_value obj, v;
    napi_create_object(env, &obj);
    napi_create_double(env, p.x, &v); napi_set_named_property(env, obj, "x", v);
    napi_create_double(env, p.y, &v); napi_set_named_property(env, obj, "y", v);
    return obj;
}
static napi_value WarpCursor(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    double x = 0, y = 0;
    napi_get_value_double(env, args[0], &x);
    napi_get_value_double(env, args[1], &y);
    CGWarpMouseCursorPosition(CGPointMake(x, y));
    // warp 直後はハードウェアのマウス移動が一瞬無視されるので、すぐ繋ぎ直す
    CGAssociateMouseAndMouseCursorPosition(true);
    napi_value v;
    napi_get_undefined(env, &v);
    return v;
}

// ── Mission Control (Dock の AX) ──
// Mission Control を開いている間、Dock は窓の縮小表示 (mc.windows の AXButton、題名・位置付き) と
// スペースバー (mc.spaces.list の AXButton、並びは SLSCopyManagedDisplaySpaces と同じ) を AX に出す。
// 縮小表示を合成ドラッグでスペースバーのデスクトップへ落とすと、画面を切り替えずに他のアプリの窓を
// 別のデスクトップへ移せる (2026-11-03 実測、macOS 26.7.2)。
// 縮小表示の並びは手前から奥 (アプリごとに重ねる設定のとき、重なりの手前が先)。
static id mcAttr(AXUIElementRef e, CFStringRef a) {
    CFTypeRef v = NULL;
    if (AXUIElementCopyAttributeValue(e, a, &v) != kAXErrorSuccess || !v) return nil;
    return CFBridgingRelease(v);
}
static CGRect mcFrame(AXUIElementRef e) {
    CGPoint p = CGPointZero; CGSize s = CGSizeZero; id v;
    if ((v = mcAttr(e, kAXPositionAttribute))) AXValueGetValue((__bridge AXValueRef)v, (AXValueType)kAXValueCGPointType, &p);
    if ((v = mcAttr(e, kAXSizeAttribute))) AXValueGetValue((__bridge AXValueRef)v, (AXValueType)kAXValueCGSizeType, &s);
    return CGRectMake(p.x, p.y, s.width, s.height);
}
static NSArray *mcChildren(AXUIElementRef e) {
    id kids = mcAttr(e, kAXChildrenAttribute);
    return [kids isKindOfClass:[NSArray class]] ? kids : @[];
}
// 子要素は親の配列が持っているだけなので、見つけた要素は id (strong) で返して寿命を延ばす
static id mcFindById(id e, NSString *ident, int depth) {
    NSString *mine = mcAttr((__bridge AXUIElementRef)e, CFSTR("AXIdentifier"));
    if ([mine isKindOfClass:[NSString class]] && [mine isEqualToString:ident]) return e;
    if (depth <= 0) return nil;
    for (id k in mcChildren((__bridge AXUIElementRef)e)) {
        id r = mcFindById(k, ident, depth - 1);
        if (r) return r;
    }
    return nil;
}
static pid_t dockPid() {
    for (NSRunningApplication *a in [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.dock"])
        return a.processIdentifier;
    return 0;
}
// 表示中の Mission Control の画面ごとの要素 (mc.display の AXUIElement)。開いていなければ空。
static NSArray *mcDisplays(AXUIElementRef app) {
    NSMutableArray *out = [NSMutableArray array];
    id mc = mcFindById((__bridge id)app, @"mc", 2);
    if (!mc) return out;
    for (id k in mcChildren((__bridge AXUIElementRef)mc)) {
        NSString *ident = mcAttr((__bridge AXUIElementRef)k, CFSTR("AXIdentifier"));
        if ([ident isKindOfClass:[NSString class]] && [ident isEqualToString:@"mc.display"]) [out addObject:k];
    }
    return out;
}
static void mcSetFrame(napi_env env, napi_value obj, CGRect r) {
    napi_value v;
    napi_create_double(env, r.origin.x, &v);    napi_set_named_property(env, obj, "x", v);
    napi_create_double(env, r.origin.y, &v);    napi_set_named_property(env, obj, "y", v);
    napi_create_double(env, r.size.width, &v);  napi_set_named_property(env, obj, "w", v);
    napi_create_double(env, r.size.height, &v); napi_set_named_property(env, obj, "h", v);
}

// mcSnapshot() → null (Mission Control が開いていない) |
//   [{ x, y, w, h, windows: [{title, x, y, w, h}], spaces: [{title, x, y, w, h}] }]  (画面ごと)
static napi_value McSnapshot(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_get_null(env, &result);
    pid_t pid = dockPid();
    if (!pid) return result;
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    NSArray *displays = mcDisplays(app);
    if (displays.count) {
        napi_create_array(env, &result);
        uint32_t di = 0;
        for (id d in displays) {
            AXUIElementRef disp = (__bridge AXUIElementRef)d;
            napi_value dobj, wins, sps;
            napi_create_object(env, &dobj);
            mcSetFrame(env, dobj, mcFrame(disp));
            napi_create_array(env, &wins);
            napi_create_array(env, &sps);
            uint32_t wi = 0, si = 0;
            id winGroup = mcFindById(d, @"mc.windows", 2);
            if (winGroup) for (id b in mcChildren((__bridge AXUIElementRef)winGroup)) {
                AXUIElementRef be = (__bridge AXUIElementRef)b;
                NSString *role = mcAttr(be, kAXRoleAttribute);
                if (![role isKindOfClass:[NSString class]] || ![role isEqualToString:@"AXButton"]) continue;
                NSString *title = mcAttr(be, kAXTitleAttribute);
                napi_value o, v;
                napi_create_object(env, &o);
                napi_create_string_utf8(env, [title isKindOfClass:[NSString class]] ? title.UTF8String : "", NAPI_AUTO_LENGTH, &v);
                napi_set_named_property(env, o, "title", v);
                mcSetFrame(env, o, mcFrame(be));
                napi_set_element(env, wins, wi++, o);
            }
            id list = mcFindById(d, @"mc.spaces.list", 3);
            if (list) for (id b in mcChildren((__bridge AXUIElementRef)list)) {
                AXUIElementRef be = (__bridge AXUIElementRef)b;
                NSString *title = mcAttr(be, kAXTitleAttribute);
                napi_value o, v;
                napi_create_object(env, &o);
                napi_create_string_utf8(env, [title isKindOfClass:[NSString class]] ? title.UTF8String : "", NAPI_AUTO_LENGTH, &v);
                napi_set_named_property(env, o, "title", v);
                mcSetFrame(env, o, mcFrame(be));
                napi_set_element(env, sps, si++, o);
            }
            napi_set_named_property(env, dobj, "windows", wins);
            napi_set_named_property(env, dobj, "spaces", sps);
            napi_set_element(env, result, di++, dobj);
        }
    }
    CFRelease(app);
    return result;
}

// mcPressSpace(displayIndex, spaceIndex) → bool
// スペースバーのデスクトップを押す = Mission Control を閉じてそのデスクトップへ切り替わる。
static napi_value McPressSpace(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    int32_t di = 0, si = 0;
    napi_get_value_int32(env, args[0], &di);
    napi_get_value_int32(env, args[1], &si);
    bool ok = false;
    pid_t pid = dockPid();
    if (pid) {
        AXUIElementRef app = AXUIElementCreateApplication(pid);
        NSArray *displays = mcDisplays(app);
        if (di >= 0 && di < (int32_t)displays.count) {
            id list = mcFindById(displays[di], @"mc.spaces.list", 3);
            NSArray *btns = list ? mcChildren((__bridge AXUIElementRef)list) : @[];
            if (si >= 0 && si < (int32_t)btns.count)
                ok = AXUIElementPerformAction((__bridge AXUIElementRef)btns[si], kAXPressAction) == kAXErrorSuccess;
        }
        CFRelease(app);
    }
    napi_value v;
    napi_get_boolean(env, ok, &v);
    return v;
}

// mcToggle() → bool — Mission Control を開く/閉じる (Dock への通知。キー割り当てに依らない)
typedef void (*PFN_CoreDockSendNotification)(CFStringRef, int);
static napi_value McToggle(napi_env env, napi_callback_info info) {
    static PFN_CoreDockSendNotification fn = NULL;
    static bool tried = false;
    if (!tried) {
        tried = true;
        void *h = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY);
        if (h) fn = (PFN_CoreDockSendNotification)dlsym(h, "CoreDockSendNotification");
        if (!fn) fn = (PFN_CoreDockSendNotification)dlsym(RTLD_DEFAULT, "CoreDockSendNotification");
    }
    if (fn) fn(CFSTR("com.apple.expose.awake"), 0);
    napi_value v;
    napi_get_boolean(env, fn != NULL, &v);
    return v;
}

// setWindowsMinimized([{ windowNumber, pid }], minimized) → 変えられた数
// Mission Control で端末を山ごと運ぶとき、同じアプリの関係ない窓を一時的にしまうのに使う
// (山に関係ない窓が混ざっていると、山ごと掴むとその窓まで移ってしまう)。
// 窓の番号だけで照合する (題名や並び順での当て推量はしない — 別の窓をしまってしまう)。
// 最小化した窓は、元のデスクトップで解除すればそのデスクトップに戻る。
// しまった窓の AX 要素 (windowNumber → AXUIElement)。戻すときはこれを直接使う。
// Finder は最小化した窓を窓番号で引けなくなる (AXWindowID も _AXUIElementGetWindow も合わない) うえ、
// しまった直後は窓一覧そのものが取れないことがある (2026-11-03 実機)。
static NSMutableDictionary<NSNumber*, id> *gMinimizedAX = nil;

static napi_value SetWindowsMinimized(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    bool minimized = true, detail = false;
    if (argc >= 2) napi_get_value_bool(env, args[1], &minimized);
    if (argc >= 3) napi_get_value_bool(env, args[2], &detail);
    // detail=true のときは窓ごとの結果の配列を返す: 0=変えた / -1=アプリの窓一覧が取れない /
    //   -2=窓が見つからない / それ以外=AXError
    napi_value codes;
    napi_create_array(env, &codes);

    uint32_t length = 0;
    napi_get_array_length(env, args[0], &length);
    int changed = 0;
    NSMutableDictionary<NSNumber*, NSArray*> *winsOfPid = [NSMutableDictionary new];

    for (uint32_t i = 0; i < length; i++) {
        napi_value item, v;
        napi_get_element(env, args[0], i, &item);
        int32_t pid = 0, windowNumber = 0;
        if (napi_get_named_property(env, item, "pid", &v) == napi_ok) napi_get_value_int32(env, v, &pid);
        if (napi_get_named_property(env, item, "windowNumber", &v) == napi_ok) napi_get_value_int32(env, v, &windowNumber);
        int code = -2;
        if (pid <= 0 || windowNumber <= 0) { napi_value cv; napi_create_int32(env, code, &cv); napi_set_element(env, codes, i, cv); continue; }
        if (!gMinimizedAX) gMinimizedAX = [NSMutableDictionary new];
        id kept = gMinimizedAX[@(windowNumber)];
        if (!minimized && kept) {
            AXError err = AXUIElementSetAttributeValue((__bridge AXUIElementRef)kept, kAXMinimizedAttribute, kCFBooleanFalse);
            if (err == kAXErrorSuccess || err == kAXErrorInvalidUIElement) [gMinimizedAX removeObjectForKey:@(windowNumber)];
            if (err == kAXErrorSuccess) {
                changed++;
                napi_value cv; napi_create_int32(env, 0, &cv); napi_set_element(env, codes, i, cv);
                continue;
            }
        }

        NSArray *wins = winsOfPid[@(pid)];
        if (!wins) {
            AXUIElementRef app = AXUIElementCreateApplication((pid_t)pid);
            if (app) AXUIElementSetMessagingTimeout(app, AX_APP_TIMEOUT);
            CFTypeRef wRef = NULL;
            if (app && AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &wRef) == kAXErrorSuccess && wRef) {
                wins = CFBridgingRelease(wRef);
            } else {
                wins = @[];
            }
            if (app) CFRelease(app);
            winsOfPid[@(pid)] = wins;
        }
        if (!wins.count) code = -1;
        for (id w in wins) {
            AXUIElementRef win = (__bridge AXUIElementRef)w;
            CGWindowID wid = 0;
            CFTypeRef widRef = NULL;
            if (AXUIElementCopyAttributeValue(win, CFSTR("AXWindowID"), &widRef) == kAXErrorSuccess && widRef) {
                if (CFGetTypeID(widRef) == CFNumberGetTypeID()) CFNumberGetValue((CFNumberRef)widRef, kCFNumberSInt32Type, &wid);
                CFRelease(widRef);
            }
            if (wid != (CGWindowID)windowNumber) {
                wid = 0;
                if (_AXUIElementGetWindow(win, &wid) != kAXErrorSuccess || wid != (CGWindowID)windowNumber) continue;
            }
            AXError err = AXUIElementSetAttributeValue(win, kAXMinimizedAttribute, minimized ? kCFBooleanTrue : kCFBooleanFalse);
            code = (err == kAXErrorSuccess) ? 0 : (int)err;
            if (err == kAXErrorSuccess) {
                changed++;
                if (minimized) gMinimizedAX[@(windowNumber)] = w;
                else [gMinimizedAX removeObjectForKey:@(windowNumber)];
            }
            break;
        }
        napi_value cv; napi_create_int32(env, code, &cv); napi_set_element(env, codes, i, cv);
    }

    if (detail) return codes;
    napi_value result;
    napi_create_int32(env, changed, &result);
    return result;
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_value fn;


    napi_create_function(env, NULL, 0, GetActiveSpaceId, NULL, &fn);
    napi_set_named_property(env, exports, "getActiveSpaceId", fn);
    napi_create_function(env, NULL, 0, HitTestPoint, NULL, &fn);
    napi_set_named_property(env, exports, "hitTestPoint", fn);
    napi_create_function(env, NULL, 0, GetWindowBounds, NULL, &fn);
    napi_set_named_property(env, exports, "getWindowBounds", fn);
    napi_create_function(env, NULL, 0, PostMouse, NULL, &fn);
    napi_set_named_property(env, exports, "postMouse", fn);
    napi_create_function(env, NULL, 0, GetSpaceHotkeys, NULL, &fn);
    napi_set_named_property(env, exports, "getSpaceHotkeys", fn);
    napi_create_function(env, NULL, 0, PostHotkey, NULL, &fn);
    napi_set_named_property(env, exports, "postHotkey", fn);
    napi_create_function(env, NULL, 0, GetCursorPosition, NULL, &fn);
    napi_set_named_property(env, exports, "getCursorPosition", fn);
    napi_create_function(env, NULL, 0, WarpCursor, NULL, &fn);
    napi_set_named_property(env, exports, "warpCursor", fn);
    napi_create_function(env, NULL, 0, McSnapshot, NULL, &fn);
    napi_set_named_property(env, exports, "mcSnapshot", fn);
    napi_create_function(env, NULL, 0, McPressSpace, NULL, &fn);
    napi_set_named_property(env, exports, "mcPressSpace", fn);
    napi_create_function(env, NULL, 0, McToggle, NULL, &fn);
    napi_set_named_property(env, exports, "mcToggle", fn);
    napi_create_function(env, NULL, 0, SetWindowsMinimized, NULL, &fn);
    napi_set_named_property(env, exports, "setWindowsMinimized", fn);
    napi_create_function(env, NULL, 0, ListWindows, NULL, &fn);
    napi_set_named_property(env, exports, "listWindows", fn);
    napi_create_function(env, NULL, 0, ListWindowsAsync, NULL, &fn);
    napi_set_named_property(env, exports, "listWindowsAsync", fn);

    napi_create_function(env, NULL, 0, MoveWindows, NULL, &fn);
    napi_set_named_property(env, exports, "moveWindows", fn);
    napi_create_function(env, NULL, 0, MoveWindowsAsync, NULL, &fn);
    napi_set_named_property(env, exports, "moveWindowsAsync", fn);

    napi_create_function(env, NULL, 0, RaiseWindows, NULL, &fn);
    napi_set_named_property(env, exports, "raiseWindows", fn);
    napi_create_function(env, NULL, 0, RaiseWindowsAsync, NULL, &fn);
    napi_set_named_property(env, exports, "raiseWindowsAsync", fn);

    napi_create_function(env, NULL, 0, ActivateApp, NULL, &fn);
    napi_set_named_property(env, exports, "activateApp", fn);

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

    napi_create_function(env, NULL, 0, IsMouseButtonDown, NULL, &fn);
    napi_set_named_property(env, exports, "isMouseButtonDown", fn);

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
