// win-helper.js — Windows 用ウィンドウ操作バックエンド
//
// macOS の native/ax-helper.mm (ax_helper.node) と同じ API 形状を、
// koffi (FFI, ビルド不要) 経由で Win32 API を呼んで実装する。
// main.js は全箇所で `if (axHelper && axHelper.xxx)` と null チェックしているため、
// メソッド名を揃えれば darwin 版とほぼ同じコードパスで動く。
//
// windowNumber == HWND (数値) として扱う。
// 座標系: Win32 は物理ピクセル / 左上原点。Electron screen API は DIP を返すため
// DPI スケールの変換が必要 (setDpiScale で外から注入)。

const koffi = require('koffi');
const fs = require('fs');
const path = require('path');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
let dwmapi = null;
try { dwmapi = koffi.load('dwmapi.dll'); } catch { /* optional */ }

// ── 仮想デスクトップ (mac の Space 相当): VirtualDesktopAccessor.dll があれば有効化 ──
// 外部(他プロセス)窓のデスクトップ移動には非公開 COM(IVirtualDesktopManagerInternal)が
// 要り、Windows ビルドごとに ABI が変わる。これを安定ラップした第三者 DLL
// (github.com/Ciantic/VirtualDesktopAccessor)を **オプション依存** でロードする。
// DLL は同梱しない。次のいずれかに置く: TIN_VDA_DLL(明示パス) /
// %APPDATA%\TiN\VirtualDesktopAccessor.dll / win-helper.js と同じディレクトリ。
// 見つからなければ Space 系は no-op のまま(capability OFF)。
let vda = null;
(function loadVDA() {
  const candidates = [
    process.env.TIN_VDA_DLL,
    path.join(process.env.APPDATA || '', 'TiN', 'VirtualDesktopAccessor.dll'),
    path.join(__dirname, 'VirtualDesktopAccessor.dll'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const lib = koffi.load(p);
      vda = {
        count:      lib.func('int GetDesktopCount()'),
        current:    lib.func('int GetCurrentDesktopNumber()'),
        goTo:       lib.func('void GoToDesktopNumber(int)'),
        moveWin:    lib.func('int MoveWindowToDesktopNumber(uintptr_t, int)'),
        winDesktop: lib.func('int GetWindowDesktopNumber(uintptr_t)'),
      };
      // ロード健全性チェック(GetDesktopCount が妥当な値を返すか)
      const n = vda.count();
      if (!(n >= 1 && n < 100)) { vda = null; continue; }
      console.log('[tin] VirtualDesktopAccessor loaded:', p, `(${n} desktops)`);
      break;
    } catch (e) { vda = null; /* 次の候補へ */ }
  }
  if (!vda) console.log('[tin] VirtualDesktopAccessor 未検出 — 仮想デスクトップ機能は無効 (capability OFF)');
})();

// ── 構造体 ──
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });

// ── コールバック プロトタイプ ──
const WNDENUMPROC = koffi.proto('bool WNDENUMPROC(uintptr_t hWnd, intptr_t lParam)');

// ── user32 ──
const EnumWindows = user32.func('bool EnumWindows(WNDENUMPROC* lpEnumFunc, intptr_t lParam)');
const IsWindowVisible = user32.func('bool IsWindowVisible(uintptr_t hWnd)');
const IsWindow = user32.func('bool IsWindow(uintptr_t hWnd)');
const IsIconic = user32.func('bool IsIconic(uintptr_t hWnd)');
const GetWindowTextW = user32.func('int GetWindowTextW(uintptr_t hWnd, _Out_ uint16_t* lpString, int nMaxCount)');
const GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(uintptr_t hWnd)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32* lpdwProcessId)');
const GetWindowRect = user32.func('bool GetWindowRect(uintptr_t hWnd, _Out_ RECT* lpRect)');
const SetWindowPos = user32.func('bool SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)');
const IsZoomed = user32.func('bool IsZoomed(uintptr_t hWnd)');
const SetForegroundWindow = user32.func('bool SetForegroundWindow(uintptr_t hWnd)');
const BringWindowToTop = user32.func('bool BringWindowToTop(uintptr_t hWnd)');
const ShowWindow = user32.func('bool ShowWindow(uintptr_t hWnd, int nCmdShow)');
const GetForegroundWindow = user32.func('uintptr_t GetForegroundWindow()');
const GetWindow = user32.func('uintptr_t GetWindow(uintptr_t hWnd, uint32 uCmd)');
const GetWindowLongW = user32.func('int32 GetWindowLongW(uintptr_t hWnd, int nIndex)');
const AttachThreadInput = user32.func('bool AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)');
const SetWindowLongW = user32.func('int32 SetWindowLongW(uintptr_t hWnd, int nIndex, int32 dwNewLong)');
// ネイティブ・ドラッグ/リサイズ用 (WM_NCLBUTTONDOWN を投げ OS のモーダル移動ループに委譲)
const ReleaseCapture = user32.func('bool ReleaseCapture()');
const SendMessageW = user32.func('intptr_t SendMessageW(uintptr_t hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam)');

// ── kernel32 ──
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()');
const OpenProcess = kernel32.func('uintptr_t OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)');
const CloseHandle = kernel32.func('bool CloseHandle(uintptr_t hObject)');
const QueryFullProcessImageNameW = kernel32.func('bool QueryFullProcessImageNameW(uintptr_t hProcess, uint32 dwFlags, _Out_ uint16_t* lpExeName, _Inout_ uint32* lpdwSize)');

// ── dwmapi (cloaked 判定 = 別仮想デスクトップのウィンドウ) ──
let DwmGetWindowAttribute = null;
if (dwmapi) {
  try {
    DwmGetWindowAttribute = dwmapi.func('int32 DwmGetWindowAttribute(uintptr_t hwnd, uint32 dwAttribute, _Out_ void* pvAttribute, uint32 cbAttribute)');
  } catch { DwmGetWindowAttribute = null; }
}
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

// 透明な縁(invisible border / DWM 影領域)の幅を返す。
// Win11 の通常ウィンドウは GetWindowRect が DWM の見える縁より外側に
// 約7px(96dpi時) はみ出す。これを補正しないとタイル時に隙間/重なりが出る。
// ※ 必ず DPI aware なプロセス(Electron 本体)内で呼ぶこと。standalone node では
//    GetWindowRect が仮想化されて DWM 値とスケールが食い違い、誤った値になる。
function frameBorder(hWnd) {
  if (!DwmGetWindowAttribute) return { l: 0, t: 0, r: 0, b: 0 };
  try {
    const wr = {};
    if (!GetWindowRect(hWnd, wr)) return { l: 0, t: 0, r: 0, b: 0 };
    const buf = Buffer.alloc(16);
    const hr = DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16);
    if (hr !== 0) return { l: 0, t: 0, r: 0, b: 0 };
    const dl = buf.readInt32LE(0), dt = buf.readInt32LE(4), dr = buf.readInt32LE(8), db = buf.readInt32LE(12);
    const border = { l: dl - wr.left, t: dt - wr.top, r: wr.right - dr, b: wr.bottom - db };
    // 異常値ガード(最大化や UWP cloaked で負/巨大になることがある)
    const ok = v => v >= 0 && v < 40;
    if (!ok(border.l) || !ok(border.t) || !ok(border.r) || !ok(border.b)) return { l: 0, t: 0, r: 0, b: 0 };
    return border;
  } catch { return { l: 0, t: 0, r: 0, b: 0 }; }
}

// ── 定数 ──
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_NOACTIVATE = 0x08000000;
const GW_OWNER = 4;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const HWND_TOP = 0;
const SW_RESTORE = 9;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const DWMWA_CLOAKED = 14;
const MIN_SIZE = 50;
// ネイティブ移動/リサイズ (WM_NCLBUTTONDOWN の hit-test コード)
const WM_NCLBUTTONDOWN = 0x00A1;
const HTCAPTION = 2;
const HT_EDGE = { n: 12, s: 15, e: 11, w: 10, ne: 14, nw: 13, se: 17, sw: 16 };

// DPI スケール (Electron 側から注入)。物理px = DIP * scale。
let dpiScale = 1;
function setDpiScale(s) { if (s && s > 0) dpiScale = s; }

// pid → {name, path} のキャッシュ (pid は安定)
const procInfoCache = new Map();

function getProcessInfo(pid) {
  if (pid <= 0) return { name: '', path: '' };
  if (procInfoCache.has(pid)) return procInfoCache.get(pid);
  let info = { name: '', path: '' };
  let h = 0;
  try {
    h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h) {
      const buf = Buffer.alloc(1024 * 2);
      const sizeArr = [1024];
      if (QueryFullProcessImageNameW(h, 0, buf, sizeArr)) {
        const full = buf.toString('utf16le', 0, sizeArr[0] * 2);
        let base = full.replace(/\\/g, '/').split('/').pop() || full;
        base = base.replace(/\.exe$/i, '');
        info = { name: base, path: full };
      }
    }
  } catch { /* ignore */ }
  finally { if (h) { try { CloseHandle(h); } catch {} } }
  procInfoCache.set(pid, info);
  return info;
}

function getProcessName(pid) { return getProcessInfo(pid).name; }

// アプリ名 (プロセス名) から実行ファイルのフルパスを引く。
// app.getFileIcon でアイコン抽出するために使う。現在表示中のウィンドウから探す。
function getExePathForApp(appName) {
  if (!appName) return '';
  for (const w of enumerate(true)) {
    if (w.app === appName) {
      const info = getProcessInfo(w.pid);
      if (info.path) return info.path;
    }
  }
  return '';
}

function getTitle(hWnd) {
  const len = GetWindowTextLengthW(hWnd);
  if (len <= 0) return '';
  const buf = Buffer.alloc((len + 1) * 2);
  const n = GetWindowTextW(hWnd, buf, len + 1);
  return buf.toString('utf16le', 0, n * 2);
}

function isCloaked(hWnd) {
  if (!DwmGetWindowAttribute) return false;
  try {
    const out = Buffer.alloc(4);
    const hr = DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out, 4);
    if (hr === 0) return out.readInt32LE(0) !== 0;
  } catch { /* ignore */ }
  return false;
}

// alt-tab 相当のフィルタ: トップレベルかつ実アプリのウィンドウだけ通す
function isAltTabWindow(hWnd) {
  if (!IsWindowVisible(hWnd)) return false;
  if (IsIconic(hWnd)) return false; // 最小化は除外 (mac も off-screen 除外)
  const exStyle = GetWindowLongW(hWnd, GWL_EXSTYLE) >>> 0;
  if (exStyle & WS_EX_TOOLWINDOW) return false;
  // owner 付きウィンドウ (ダイアログ等) は APPWINDOW 指定が無ければ除外
  const owner = GetWindow(hWnd, GW_OWNER);
  if (owner && !(exStyle & WS_EX_APPWINDOW)) return false;
  return true;
}

// ── 共通の列挙 ──
// includeCloaked: true で別仮想デスクトップのウィンドウも含む (listWindowsAllSpaces 用)
function enumerate(includeCloaked) {
  const out = [];
  const appCount = new Map();
  const cb = koffi.register((hWnd, _lParam) => {
    try {
      if (!isAltTabWindow(hWnd)) return true;
      if (!includeCloaked && isCloaked(hWnd)) return true;

      const rect = {};
      if (!GetWindowRect(hWnd, rect)) return true;
      const x = rect.left, y = rect.top;
      const w = rect.right - rect.left, h = rect.bottom - rect.top;
      if (w <= MIN_SIZE || h <= MIN_SIZE) return true;

      const pidArr = [0];
      GetWindowThreadProcessId(hWnd, pidArr);
      const pid = pidArr[0];
      // 自プロセス (TiN 本体) のウィンドウは app='TiN' とする。
      // ソース起動だとプロセス名が 'electron' になり、mac 版の app==='TiN' 判定
      // (自己スナップ除外・TiN タブ分類) が壊れるため統一する。
      const app = (pid === process.pid) ? 'TiN' : getProcessName(pid);

      const title = getTitle(hWnd);

      const idx = appCount.get(pid) || 0;
      appCount.set(pid, idx + 1);

      out.push({
        app,
        title,
        windowNumber: Number(hWnd),
        pid,
        windowIndex: idx,
        x, y, width: w, height: h,
      });
    } catch { /* skip this window */ }
    return true;
  }, koffi.pointer(WNDENUMPROC));

  try { EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  return out;
}

// ── 公開 API (ax_helper 互換) ──

function listWindows() {
  return enumerate(false);
}

function listWindowsAllSpaces() {
  return enumerate(true);
}

function moveWindows(cmds, positionOnly) {
  if (!Array.isArray(cmds)) return 0;
  let moved = 0;
  for (const c of cmds) {
    const hWnd = Number(c.windowNumber);
    if (!hWnd || !IsWindow(hWnd)) continue;
    try {
      // 最大化されたウィンドウは SetWindowPos で位置だけ変えても見た目が
      // 最大化のままになるので、先に通常状態へ戻す。
      if (IsZoomed(hWnd)) ShowWindow(hWnd, SW_RESTORE);

      // 透明な縁を補正して「見える窓の縁」が要求座標に揃うようにする。
      const b = frameBorder(hWnd);
      let x = Math.round(c.x * dpiScale) - b.l;
      let y = Math.round(c.y * dpiScale) - b.t;
      let flags = SWP_NOZORDER | SWP_NOACTIVATE;
      let cx = 0, cy = 0;
      if (positionOnly) {
        flags |= SWP_NOSIZE;
      } else {
        cx = Math.round((c.width || 0) * dpiScale) + b.l + b.r;
        cy = Math.round((c.height || 0) * dpiScale) + b.t + b.b;
      }
      if (SetWindowPos(hWnd, 0, x, y, cx, cy, flags)) moved++;
    } catch { /* ignore */ }
  }
  return moved;
}

function raiseOne(hWnd) {
  if (!hWnd || !IsWindow(hWnd)) return false;
  try {
    if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
    // 1. z-order を最前面へ。SetWindowPos の純粋な z 変更は foreground lock の
    //    制約を受けないため、重なったタブ窓の前後関係を確実に入れ替えられる。
    const zok = SetWindowPos(hWnd, HWND_TOP, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    // 2. ベストエフォートでフォーカスも移す。foreground lock 回避のため対象スレッドに
    //    input をアタッチ。失敗しても z-order は 1. で確定済み。
    const fg = GetForegroundWindow();
    const myTid = GetCurrentThreadId();
    let targetTid = 0;
    if (fg) targetTid = GetWindowThreadProcessId(fg, [0]);
    if (targetTid && targetTid !== myTid) AttachThreadInput(targetTid, myTid, true);
    BringWindowToTop(hWnd);
    const fgok = SetForegroundWindow(hWnd);
    if (targetTid && targetTid !== myTid) AttachThreadInput(targetTid, myTid, false);
    return !!(zok || fgok);
  } catch { return false; }
}

function raiseWindows(cmds) {
  if (!Array.isArray(cmds)) return 0;
  let n = 0;
  // 複数渡された場合は末尾が最前面になるよう順番に raise
  for (const c of cmds) {
    const hWnd = Number(typeof c === 'object' ? c.windowNumber : c);
    if (raiseOne(hWnd)) n++;
  }
  return n;
}

function getFrontmostWindowNumber() {
  try { return Number(GetForegroundWindow()) || 0; } catch { return 0; }
}

function getWindowNumbersByPid(pid) {
  return enumerate(true).filter(w => w.pid === pid).map(w => w.windowNumber);
}

function isAXTrusted() {
  // Windows ではウィンドウ操作に特別な権限は不要
  return true;
}

// ── ネイティブ・ウィンドウ移動/リサイズ ──
// frameless+transparent な自ウィンドウを、IPC で毎フレーム setPosition する方式
// (レイテンシでカクつく/座標ズレで戻る) に代えて、OS の標準モーダル移動ループへ委譲する。
// ReleaseCapture() で現在のマウスキャプチャを解放し、WM_NCLBUTTONDOWN を送ると
// DefWindowProc がマウスアップまで自前で追従する。他アプリと同一の滑らかさ + Aero スナップが効く。
// ※ 自ウィンドウ(= Electron 本体スレッドが所有する HWND)に対してのみ呼ぶこと。
//    SendMessage はモーダルループ終了まで戻らない(= JS イベントループが一時ブロックされる)。
function startWindowDrag(hWnd) {
  hWnd = Number(hWnd);
  if (!hWnd || !IsWindow(hWnd)) return false;
  try {
    ReleaseCapture();
    SendMessageW(hWnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
    return true;
  } catch { return false; }
}

function startWindowResize(hWnd, edge) {
  hWnd = Number(hWnd);
  const hit = HT_EDGE[edge];
  if (!hWnd || !hit || !IsWindow(hWnd)) return false;
  try {
    ReleaseCapture();
    SendMessageW(hWnd, WM_NCLBUTTONDOWN, hit, 0);
    return true;
  } catch { return false; }
}

// ── 仮想デスクトップ (mac の Space 相当) — VirtualDesktopAccessor.dll があれば有効 ──
// vda 未ロード時は全て no-op(空配列/0/false)。main.js の if(axHelper.xxx) ガードと
// spacesCapable() による UI 出し分けで「未対応なら静かに無効」を担保する。
function spacesCapable() { return !!vda; }

function getSpacesList() {
  if (!vda) return [];
  try {
    const n = vda.count(), cur = vda.current();
    const out = [];
    for (let i = 0; i < n; i++) out.push({ id: i, index: i + 1, label: `Desktop ${i + 1}`, isCurrent: i === cur });
    return out;
  } catch { return []; }
}
function getSpaceForWindows(wns) {
  if (!vda || !Array.isArray(wns)) return [];
  return wns.map(wn => { try { return vda.winDesktop(Number(wn)); } catch { return -1; } });
}
function moveWindowsToSpaceId(wns, spaceId) {
  if (!vda || !Array.isArray(wns)) return 0;
  let moved = 0;
  for (const c of wns) {
    const wn = Number(typeof c === 'object' ? c.windowNumber : c);
    try { if (vda.moveWin(wn, Number(spaceId))) moved++; } catch { /* ignore */ }
  }
  return moved;
}
function moveToSpace(wns, direction) {
  if (!vda || !Array.isArray(wns)) return 0;
  try {
    const cur = vda.current(), cnt = vda.count();
    let target = cur + (Number(direction) || 0);
    target = Math.max(0, Math.min(cnt - 1, target));
    if (target === cur) return 0;
    return moveWindowsToSpaceId(wns, target);
  } catch { return 0; }
}
function moveWindowsToActiveSpace(wns) {
  if (!vda) return 0;
  try { return moveWindowsToSpaceId(wns, vda.current()); } catch { return 0; }
}
// sticky(全 Space 表示)は VDA でも非対応(pinned は別 API)。
function setWindowSticky() { return false; }
function getWindowIdFromHandle(h) { return Number(h) || 0; }

module.exports = {
  __backend: 'win32-koffi',
  setDpiScale,
  listWindows,
  listWindowsAllSpaces,
  moveWindows,
  raiseWindows,
  getFrontmostWindowNumber,
  getWindowNumbersByPid,
  isAXTrusted,
  startWindowDrag,
  startWindowResize,
  moveToSpace,
  moveWindowsToActiveSpace,
  moveWindowsToSpaceId,
  getSpaceForWindows,
  getSpacesList,
  spacesCapable,
  setWindowSticky,
  getWindowIdFromHandle,
  getExePathForApp,
};
