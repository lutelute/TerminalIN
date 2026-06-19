// native/win-helper.cc
// Windows 版ウィンドウ操作 N-API addon。macOS の native/ax-helper.mm と同じ
// export 名・戻り値スキーマを持ち、build/Release/ax_helper.node として出力する。
// これにより main.js は OS を意識せず require('./build/Release/ax_helper.node') で
// ロードでき、既存の if(axHelper) パスが Windows でそのまま動く。
//
// 実装: AXUIElement の代わりに Win32 EnumWindows / SetWindowPos を使う。
// 仮想デスクトップ(Space)系メソッドは export しない → main.js が自動 skip する。
#include <node_api.h>
#include <windows.h>
#include <dwmapi.h>
#include <vector>
#include <map>
#include <string>

#ifndef DWMWA_CLOAKED
#define DWMWA_CLOAKED 14
#endif
#ifndef DWMWA_EXTENDED_FRAME_BOUNDS
#define DWMWA_EXTENDED_FRAME_BOUNDS 9
#endif

// HWND <-> int32 windowNumber。Windows の USER ハンドルは実質 32bit 域なので
// int32 で安全に往復できる(復元時は符号拡張)。macOS が int32 のため型互換も保つ。
static inline int32_t hwndToNum(HWND h) { return (int32_t)(intptr_t)h; }
static inline HWND numToHwnd(int32_t n) { return (HWND)(intptr_t)n; }

// UTF-16 -> UTF-8
static std::string toUtf8(const wchar_t* w) {
  if (!w || !w[0]) return std::string();
  int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (len <= 1) return std::string();
  std::string s((size_t)(len - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], len, nullptr, nullptr);
  return s;
}

// ウィンドウの「見た目の矩形」。DWM 拡張フレーム(描画される枠)を優先し、
// 取れなければ GetWindowRect(影・不可視リサイズ境界込み)にフォールバック。
static RECT visibleRect(HWND h) {
  RECT r{};
  if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &r, sizeof(r)) != S_OK) {
    GetWindowRect(h, &r);
  }
  return r;
}

static bool isCloaked(HWND h) {
  BOOL cloaked = FALSE;
  if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, &cloaked, sizeof(cloaked)) == S_OK)
    return cloaked != FALSE;
  return false;
}

// プロセスの実行ファイル名(拡張子なし)を取得 -> app 名に使う。
static std::wstring appNameForPid(DWORD pid) {
  std::wstring name;
  HANDLE hp = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (hp) {
    wchar_t path[MAX_PATH]; DWORD sz = MAX_PATH;
    if (QueryFullProcessImageNameW(hp, 0, path, &sz)) {
      std::wstring full(path, sz);
      size_t slash = full.find_last_of(L"\\/");
      name = (slash == std::wstring::npos) ? full : full.substr(slash + 1);
      size_t dot = name.find_last_of(L'.');
      if (dot != std::wstring::npos) name = name.substr(0, dot);
    }
    CloseHandle(hp);
  }
  return name;
}

// ── listWindows: 可視トップレベルウィンドウを列挙 ──
static BOOL CALLBACK enumCollect(HWND hwnd, LPARAM lp) {
  auto* out = reinterpret_cast<std::vector<HWND>*>(lp);
  if (!IsWindowVisible(hwnd)) return TRUE;
  if (GetWindowTextLengthW(hwnd) == 0) return TRUE;        // タイトルなし除外
  LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if (ex & WS_EX_TOOLWINDOW) return TRUE;                   // ツールウィンドウ除外
  if (isCloaked(hwnd)) return TRUE;                         // 他仮想デスクトップ除外
  out->push_back(hwnd);
  return TRUE;
}

static napi_value ListWindows(napi_env env, napi_callback_info info) {
  std::vector<HWND> hwnds;
  EnumWindows(enumCollect, reinterpret_cast<LPARAM>(&hwnds));

  napi_value result;
  napi_create_array(env, &result);
  uint32_t idx = 0;
  std::map<std::wstring, int> appCount;  // app 名ごとの windowIndex

  for (HWND hwnd : hwnds) {
    RECT r = visibleRect(hwnd);
    int x = r.left, y = r.top, w = r.right - r.left, h = r.bottom - r.top;
    if (w <= 50 || h <= 50) continue;

    int tlen = GetWindowTextLengthW(hwnd);
    std::wstring title((size_t)tlen + 1, L'\0');
    int got = GetWindowTextW(hwnd, &title[0], tlen + 1);
    title.resize(got > 0 ? (size_t)got : 0);

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    std::wstring app = appNameForPid(pid);
    int windowIndex = appCount[app]++;

    napi_value obj; napi_create_object(env, &obj);
    napi_value v;
    std::string s;
    s = toUtf8(app.c_str());
    napi_create_string_utf8(env, s.c_str(), NAPI_AUTO_LENGTH, &v);
    napi_set_named_property(env, obj, "app", v);
    s = toUtf8(title.c_str());
    napi_create_string_utf8(env, s.c_str(), NAPI_AUTO_LENGTH, &v);
    napi_set_named_property(env, obj, "title", v);
    napi_create_int32(env, hwndToNum(hwnd), &v);
    napi_set_named_property(env, obj, "windowNumber", v);
    napi_create_int32(env, (int32_t)pid, &v);
    napi_set_named_property(env, obj, "pid", v);
    napi_create_int32(env, windowIndex, &v);
    napi_set_named_property(env, obj, "windowIndex", v);
    napi_create_int32(env, x, &v);
    napi_set_named_property(env, obj, "x", v);
    napi_create_int32(env, y, &v);
    napi_set_named_property(env, obj, "y", v);
    napi_create_int32(env, w, &v);
    napi_set_named_property(env, obj, "width", v);
    napi_create_int32(env, h, &v);
    napi_set_named_property(env, obj, "height", v);

    napi_set_element(env, result, idx++, obj);
  }
  return result;
}

// ── moveWindows(cmds, positionOnly) ── 戻り値 = 移動成功数(int)
static napi_value MoveWindows(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  bool positionOnly = false;
  if (argc >= 2) napi_get_value_bool(env, args[1], &positionOnly);

  uint32_t length = 0;
  napi_get_array_length(env, args[0], &length);
  int moved = 0;

  for (uint32_t i = 0; i < length; i++) {
    napi_value item; napi_get_element(env, args[0], i, &item);
    napi_value v;
    int32_t wn = 0, x = 0, y = 0, w = 0, h = 0;
    if (napi_get_named_property(env, item, "windowNumber", &v) == napi_ok) napi_get_value_int32(env, v, &wn);
    if (napi_get_named_property(env, item, "x", &v) == napi_ok) napi_get_value_int32(env, v, &x);
    if (napi_get_named_property(env, item, "y", &v) == napi_ok) napi_get_value_int32(env, v, &y);
    if (napi_get_named_property(env, item, "width", &v) == napi_ok) napi_get_value_int32(env, v, &w);
    if (napi_get_named_property(env, item, "height", &v) == napi_ok) napi_get_value_int32(env, v, &h);

    HWND hwnd = numToHwnd(wn);
    if (!IsWindow(hwnd)) continue;

    // 最大化/最小化なら通常状態へ戻してから配置
    WINDOWPLACEMENT wp{}; wp.length = sizeof(wp);
    if (GetWindowPlacement(hwnd, &wp) &&
        (wp.showCmd == SW_SHOWMAXIMIZED || wp.showCmd == SW_SHOWMINIMIZED)) {
      ShowWindow(hwnd, SW_RESTORE);
    }

    // DWM シャドウ補正: 見た目矩形(x,y,w,h) を外枠(SetWindowPos)座標へ変換
    RECT outer{}; GetWindowRect(hwnd, &outer);
    RECT vis = visibleRect(hwnd);
    int dl = vis.left - outer.left;     // 左の不可視境界(>=0)
    int dt = vis.top - outer.top;       // 上の不可視境界(タイトルバーは ~0)
    int dr = outer.right - vis.right;   // 右の不可視境界(>=0)
    int db = outer.bottom - vis.bottom; // 下の不可視境界(>=0)

    UINT flags = SWP_NOZORDER | SWP_NOACTIVATE;
    if (positionOnly) {
      if (SetWindowPos(hwnd, nullptr, x - dl, y - dt, 0, 0, flags | SWP_NOSIZE)) moved++;
    } else {
      int ox = x - dl, oy = y - dt;
      int ow = w + dl + dr, oh = h + dt + db;
      if (SetWindowPos(hwnd, nullptr, ox, oy, ow, oh, flags)) moved++;
    }
  }

  napi_value result; napi_create_int32(env, moved, &result);
  return result;
}

// ── raiseWindows(cmds) ── 各要素は {windowNumber,...} or number。前面化(フォーカスは奪わない)
static napi_value RaiseWindows(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  uint32_t length = 0;
  napi_get_array_length(env, args[0], &length);
  int raised = 0;
  for (uint32_t i = 0; i < length; i++) {
    napi_value item; napi_get_element(env, args[0], i, &item);
    int32_t wn = 0;
    napi_valuetype vt; napi_typeof(env, item, &vt);
    if (vt == napi_object) {
      napi_value v;
      if (napi_get_named_property(env, item, "windowNumber", &v) == napi_ok)
        napi_get_value_int32(env, v, &wn);
    } else if (vt == napi_number) {
      napi_get_value_int32(env, item, &wn);
    }
    HWND hwnd = numToHwnd(wn);
    if (!IsWindow(hwnd)) continue;
    if (SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0,
                     SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)) raised++;
  }
  napi_value result; napi_create_int32(env, raised, &result);
  return result;
}

// ── isAXTrusted() ── Windows に AX 権限の概念はない。常に true。
static napi_value IsAXTrusted(napi_env env, napi_callback_info info) {
  napi_value result; napi_get_boolean(env, true, &result);
  return result;
}

// ── getFrontmostWindowNumber() ──
static napi_value GetFrontmostWindowNumber(napi_env env, napi_callback_info info) {
  HWND h = GetForegroundWindow();
  int32_t wn = (h && IsWindow(h)) ? hwndToNum(h) : 0;
  napi_value result; napi_create_int32(env, wn, &result);
  return result;
}

// ── getWindowNumbersByPid(pid) ──
struct PidCollect { DWORD pid; std::vector<HWND>* out; };
static BOOL CALLBACK enumByPid(HWND hwnd, LPARAM lp) {
  auto* pc = reinterpret_cast<PidCollect*>(lp);
  DWORD wpid = 0; GetWindowThreadProcessId(hwnd, &wpid);
  if (wpid == pc->pid && IsWindowVisible(hwnd)) pc->out->push_back(hwnd);
  return TRUE;
}
static napi_value GetWindowNumbersByPid(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  int32_t pid = 0; napi_get_value_int32(env, args[0], &pid);
  std::vector<HWND> hwnds;
  PidCollect pc{ (DWORD)pid, &hwnds };
  EnumWindows(enumByPid, reinterpret_cast<LPARAM>(&pc));
  napi_value result; napi_create_array(env, &result);
  uint32_t idx = 0;
  for (HWND h : hwnds) {
    napi_value v; napi_create_int32(env, hwndToNum(h), &v);
    napi_set_element(env, result, idx++, v);
  }
  return result;
}

// ── getWindowIdFromHandle(ptr) ──
// main.js は win.getNativeWindowHandle() の Buffer を readBigUInt64LE(0) して渡す。
// Windows ではこの値が HWND。windowNumber(= listWindows と同じ int32) に変換して返す。
static napi_value GetWindowIdFromHandle(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  uint64_t ptrVal = 0;
  napi_valuetype vt; napi_typeof(env, args[0], &vt);
  if (vt == napi_bigint) {
    bool lossless = false;
    napi_get_value_bigint_uint64(env, args[0], &ptrVal, &lossless);
  } else {
    double d = 0; napi_get_value_double(env, args[0], &d);
    ptrVal = (uint64_t)(int64_t)d;
  }
  HWND hwnd = (HWND)(uintptr_t)ptrVal;
  int32_t wid = (hwnd && IsWindow(hwnd)) ? hwndToNum(hwnd) : 0;
  napi_value result; napi_create_int32(env, wid, &result);
  return result;
}

// ── Module init ── (Space 系は export しない → main.js が自動 skip)
static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, nullptr, 0, ListWindows, nullptr, &fn);
  napi_set_named_property(env, exports, "listWindows", fn);
  napi_create_function(env, nullptr, 0, MoveWindows, nullptr, &fn);
  napi_set_named_property(env, exports, "moveWindows", fn);
  napi_create_function(env, nullptr, 0, RaiseWindows, nullptr, &fn);
  napi_set_named_property(env, exports, "raiseWindows", fn);
  napi_create_function(env, nullptr, 0, IsAXTrusted, nullptr, &fn);
  napi_set_named_property(env, exports, "isAXTrusted", fn);
  napi_create_function(env, nullptr, 0, GetFrontmostWindowNumber, nullptr, &fn);
  napi_set_named_property(env, exports, "getFrontmostWindowNumber", fn);
  napi_create_function(env, nullptr, 0, GetWindowNumbersByPid, nullptr, &fn);
  napi_set_named_property(env, exports, "getWindowNumbersByPid", fn);
  napi_create_function(env, nullptr, 0, GetWindowIdFromHandle, nullptr, &fn);
  napi_set_named_property(env, exports, "getWindowIdFromHandle", fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
