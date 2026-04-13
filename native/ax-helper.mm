// ax-helper.mm — N-API native addon for AXUIElement operations
// Electron main process 内で実行するため、TiN.app の TCC 権限を直接使用。
// daemon バイナリ不要。

#import <Foundation/Foundation.h>
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <node_api.h>

// Private API: get CGWindowID from AXUIElement
extern "C" AXError _AXUIElementGetWindow(AXUIElementRef element, CGWindowID *windowID);

static NSSet *terminalApps = nil;

static void ensureTerminalApps() {
    if (!terminalApps) {
        terminalApps = [[NSSet alloc] initWithArray:@[
            @"Terminal", @"ターミナル", @"iTerm2", @"Alacritty",
            @"Warp", @"kitty", @"Hyper", @"WezTerm",
            @"Finder", @"ファインダー"
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

// ── AX ヘルパー: pid → AXUIElement → windows ──
static AXUIElementRef findAXWindow(pid_t pid, int windowNumber, const char *title, int windowIndex) {
    AXUIElementRef appRef = AXUIElementCreateApplication(pid);
    CFTypeRef windowsRef = NULL;
    if (AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute, &windowsRef) != kAXErrorSuccess) {
        CFRelease(appRef);
        return NULL;
    }

    CFArrayRef windows = (CFArrayRef)windowsRef;
    CFIndex count = CFArrayGetCount(windows);

    // 1. windowNumber (CGWindowID) でマッチ
    for (CFIndex i = 0; i < count; i++) {
        AXUIElementRef win = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
        CGWindowID wid = 0;
        if (_AXUIElementGetWindow(win, &wid) == kAXErrorSuccess && wid == (CGWindowID)windowNumber) {
            CFRetain(win);
            CFRelease(windowsRef);
            CFRelease(appRef);
            return win;
        }
    }

    // 2. title でマッチ
    if (title && strlen(title) > 0) {
        NSString *targetTitle = [NSString stringWithUTF8String:title];
        for (CFIndex i = 0; i < count; i++) {
            AXUIElementRef win = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
            CFTypeRef titleRef = NULL;
            if (AXUIElementCopyAttributeValue(win, kAXTitleAttribute, &titleRef) == kAXErrorSuccess) {
                NSString *t = (__bridge NSString *)titleRef;
                NSUInteger prefixLen = MIN(40, targetTitle.length);
                if ([t isEqualToString:targetTitle] || [t hasPrefix:[targetTitle substringToIndex:prefixLen]]) {
                    CFRetain(win);
                    CFRelease(titleRef);
                    CFRelease(windowsRef);
                    CFRelease(appRef);
                    return win;
                }
                CFRelease(titleRef);
            }
        }
    }

    // 3. CGWindowList position でマッチ
    CFArrayRef cgList = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
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
                        CFRelease(windowsRef);
                        CFRelease(appRef);
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
        CFRelease(windowsRef);
        CFRelease(appRef);
        return win;
    }

    CFRelease(windowsRef);
    CFRelease(appRef);
    return NULL;
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

        AXUIElementRef win = findAXWindow((pid_t)pid, windowNumber, title, windowIndex);
        if (!win) continue;

        CGPoint point = CGPointMake(x, y);
        AXValueRef posVal = AXValueCreate((AXValueType)kAXValueCGPointType, &point);

        if (positionOnly) {
            if (posVal) {
                AXUIElementSetAttributeValue(win, kAXPositionAttribute, posVal);
                CFRelease(posVal);
            }
        } else {
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

        AXUIElementRef win = findAXWindow((pid_t)pid, windowNumber, title, windowIndex);
        if (!win) continue;

        if (AXUIElementPerformAction(win, kAXRaiseAction) == kAXErrorSuccess) raised++;
        CFRelease(win);
    }

    napi_value result;
    napi_create_int32(env, raised, &result);
    return result;
}

// ── axTrusted ──
static napi_value IsAXTrusted(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_get_boolean(env, AXIsProcessTrusted(), &result);
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

    napi_create_function(env, NULL, 0, IsAXTrusted, NULL, &fn);
    napi_set_named_property(env, exports, "isAXTrusted", fn);

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
