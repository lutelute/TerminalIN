# TiN (TerminalIN) — 開発ガイド

## ウィンドウ操作アーキテクチャ

`native/ax-helper.mm` を N-API addon としてビルドし、Electron main process 内で
AXUIElement を直接呼ぶ。外部 helper バイナリは持たない。

- **利点**: TiN.app 本体の TCC (Accessibility) 権限をそのまま使える。
  CDHash 変動による権限消失問題なし。
- **fallback**: `osascript` (System Events の `set position`/`set size`,
  `AXRaise`)。ax_helper がロードできないケースのみ動く。

`ax_helper` の API (native/ax-helper.mm):
- `listWindows()` — CGWindowList + AX position/size
- `moveWindows(cmds, positionOnly)` — AXUIElement position/size set
- `raiseWindows(cmds)` — AXUIElement AXRaise
- `isAXTrusted()` — Accessibility 権限確認
- `moveToSpace(...)` — CGS プライベート API で Space 移動

### Windows バックエンド = **koffi (`win-helper.js`) が canonical**

Windows のウィンドウ操作は **`win-helper.js`(koffi FFI、ビルド不要)** を `main.js` が
`require('./win-helper.js')` でロードし、mac の `ax_helper` と**同じ export 名・戻り値スキーマ**で
提供する。よって main.js は `if (axHelper && axHelper.xxx)` の同一コードパスで両 OS を扱う。

- **koffi が正**: C++ N-API 版(`native/win-helper.cc`)は **評価のうえ却下・退役**(2026-06-20)。
  実機(ARM64/200%)比較で koffi 版が優秀(透明グリッド描画・黒画面なし・snap 動作)だったため。
- Win32 API を koffi で直接呼ぶ: `EnumWindows` / `SetWindowPos`(DWM 不可視縁を
  `DWMWA_EXTENDED_FRAME_BOUNDS` で補正)/ `setDpiScale` で DIP→物理px 変換 / `BringWindowToTop`+
  `AttachThreadInput` で raise。
- **ビルド不要**: koffi も node-pty も prebuilt 同梱。`binding.gyp` は `OS=='mac'` 条件付きで
  Windows では何もビルドしない(さもないと `@electron/rebuild` が ax-helper.mm を Windows で
  コンパイルして失敗する)。
- ウィンドウは `transparent: true`(全 OS)で**グリッドが透過しスロット越しにスナップ窓が見える**。
  Windows は frameless+transparent のため手動ドラッグ/リサイズ + カスタム window controls を実装。
- 仮想デスクトップ(mac の Space 相当)系は現状 no-op スタブ。

## ビルド・インストール

```bash
npm run dist                   # predist で node-gyp rebuild が自動実行
bash scripts/install.sh        # /Applications/TiN.app に配置、自動起動
```

ax_helper.node は `build/Release/` に生成され、`asarUnpack` で展開される。

## 開発モード

```bash
npm run dev                    # --dev flag 付き (DevTools 開く)
npx electron . --dev > /tmp/tin-dev.log 2>&1   # stdout ログ取得用
```

## パフォーマンス計測で判明した知見

### sidebar ドラッグ中のリアルタイム追従
- `win.on('move')` で snapped ウィンドウを fire-and-forget で ax_helper に送信
- ドラッグ中は poll をスキップ (move 競合防止)
- 16ms throttle (60fps 上限)

### AXUIElement 制約
- Terminal.app の AX set size は **拡大方向で silent fail** する (macOS バグ)
- compositor verify (CGWindowList で位置検証) は AX 座標とオフセットがあり
  false-fail する → AXError 戻り値のみで判定

### osascript のコスト
- プロセス spawn: ~200ms、System Events IPC: ~100ms/操作
- ax_helper は in-process 呼び出しで <50ms → native を最優先

## AtelierX との関係
- AtelierX は TiN と競合していない (ユーザー確認済み 2026-04-12)
- snapped.json ファイル IPC で連携
