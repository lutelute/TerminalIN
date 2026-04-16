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
