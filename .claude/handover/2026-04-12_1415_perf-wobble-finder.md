# TiN (TerminalIN) 引き継ぎ — 2026-04-12 14:15

## 1. プロジェクト概要

macOS 向けターミナルワークスペースマネージャー。外部ターミナル/Finder ウィンドウを grid にスナップして統合管理。Electron + Swift daemon 構成。

- **リポジトリ**: `/Users/shigenoburyuto/Documents/GitHub/tool_dev_SGNB/TerminalIN`
- **現在のバージョン**: v1.2.12
- **GitHub**: https://github.com/lutelute/TerminalIN
- **本番**: `/Applications/TiN.app` にパッケージインストール済み (v1.2.12)

## 2. 技術スタック

- Electron 41.1.1 + node-pty + xterm.js
- Swift daemon (`daemon.swift` → `daemon` バイナリ): CGWindowList + AXUIElement
- electron-builder (adhoc 署名, arm64)
- AtelierX 連携: `atelierx-plugin/` (snapped.json ファイル IPC + URL scheme)

## 3. 今回のセッションで完了したこと (v1.2.5 → v1.2.12)

### v1.2.6: snap perf 10x 高速化 + wobble + Finder 対応
- **compositor verify 廃止**: `daemon.swift` の `readCompositorPosition` 照合を削除。AX 座標と CGWindowList 座標に 100px オーダーのオフセットがあり、正常 move を毎回 false-fail → osascript fallback で 500-2500ms かかっていた。AXError 戻り値のみで判定するようにして 47-60ms に改善
- **wobble コマンド**: daemon に `handleWobble` 追加 (y-8px → 60ms → 戻す + AXRaise)。カードクリックで対象ウィンドウを視覚的に識別
- **Finder 対応**: `terminalApps` set に Finder/ファインダー追加、Available リストに表示、grid snap 可能
- **osascript fallback 非同期化**: `execSync` → `runOsascript` (execFile promise wrapper) で main thread ブロック解消

### v1.2.7: UI 分割
- Available セクションを TERMINAL / FINDER サブセクションに分割 (⌨️/📂 アイコン、[TERM]/[FINDER] バッジ)

### v1.2.8: Terminal unsnap サイズ復元
- Terminal.app の AX `set size` は拡大方向で silent fail する macOS バグを発見
- `unsnap-external` ハンドラで `osascriptMove` を直接呼ぶよう変更
- `osascriptMove` / `raiseSpecificWindows` で `normalizeAppName` 適用 (ターミナル → Terminal)

### v1.2.9: workspace 永続化
- `~/Library/Application Support/TiN/workspaces.json` に workspace 状態を保存/復元
- マッチング: windowNumber → app+title 完全一致 → app+title 前方 40 文字
- 復元バナー表示 (✓ 復元完了 / ⚠ スキップ)
- quit 中は `scheduleSaveWorkspaces` を無効化 (空上書き防止ガード)

### v1.2.10: AtelierX 競合対策
- snapped.json を daemon.move の BEFORE に同期書き出し
- atelierx-plugin の POLL_INTERVAL: 2000ms → 500ms

### v1.2.11: 低消費電力モード対策
- `disable-renderer-backgrounding` / `disable-background-timer-throttling`
- `backgroundThrottling: false`
- Info.plist: `NSSupportsAutomaticTermination: false` / `NSSupportsSuddenTermination: false`

### v1.2.12: 軽量化
- pollTimer: 800ms → 2000ms
- `mousedown → raise-all` を document 全体からタイトルバーのみに限定
- render() debounce 100ms 追加

## 4. 未解決の課題 (次セッションの重点)

### 4.1 パッケージ版 (TiN.app) がまだ重い
- **ユーザー報告**: 「tinの本番では重たい。動きも遅い。ラグがひどい」
- dev モード (`npm start`) では問題ない → パッケージ版固有の問題
- v1.2.12 で poll/raise/render を軽量化したが、ユーザーはまだ改善を確認していない
- **次のステップ**: パッケージ版の CPU profiling (Activity Monitor or Instruments)、asar 読み込みコスト測定、daemon spawn コスト比較

### 4.2 AtelierX との競合
- TiN snap 直後に AtelierX auto-grid が同じウィンドウを戻す問題
- TiN 側 (v1.2.10): snapped.json 先行書き出し + poll 短縮で対策済み
- **AtelierX 側 (未実施)**: grid relayout の個別 move 前に exclusion 再チェック。ユーザーが AtelierX 側の Claude に指示する予定だったが未完了
- 指示内容: grid relayout の各 window move 直前に `currentExclusionSet.has(win.id)` で再チェック

### 4.3 2 つ目の snap が効かない場合がある (断続的)
- ストレステストで 1 回だけ gridCount=8 (前サイクルの release 未完了で蓄積) を検出
- CDP `btn.click()` は mousedown を発火しないため、raise-all 経路のテスト漏れがあった
- v1.2.12 で mousedown raise-all をタイトルバー限定にしたので改善される可能性あり
- 根本対策として snap/unsnap 処理中の多重クリック防止 (UI ロック) も候補

## 5. 重要な技術的教訓 (memory にも保存済み)

### AX 座標 vs CGWindowList 座標のオフセット
- Terminal.app で AXPosition と CGWindowBounds に 100px オーダーの差がある
- compositor verify は false-fail するので使わない → AXError 戻り値のみ
- 詳細: `memory/feedback_compositor_verify.md`

### Terminal.app AX set size の拡大 silent fail
- daemon (Swift AX) で set size の拡大方向が無視される
- osascript (System Events) 経由なら成功する
- unsnap は osascriptMove を直接使う
- 詳細: `memory/feedback_terminal_ax_set_size.md`

### osascript アプリ名
- CGWindowList は "ターミナル" を返すが System Events の `tell process` は "Terminal" が必要
- `normalizeAppName()` で変換必須

### Electron パッケージ版の TCC
- rebuild で daemon の cdhash が変わる → AX/Automation/Screen Recording 権限が外れる可能性
- daemon の `AXIsProcessTrusted()` で検知 → `_daemonAXUntrusted` flag で osascript fallback に切替

## 6. ファイル構成 (主要)

```
main.js          — Electron メインプロセス (~1400行)
daemon.swift     — Swift daemon (list/move/raise/wobble/verify)
daemon           — コンパイル済みバイナリ
workspace.html   — サイドバー UI (renderer)
grid-overlay.html — グリッドオーバーレイ
package.json     — Electron + electron-builder 設定
atelierx-plugin/
  main.js        — AtelierX 連携プラグイン
  manifest.json  — プラグインメタデータ
```

## 7. 次のアクション (優先順)

1. **パッケージ版の重さ問題を調査** — v1.2.12 の軽量化効果をユーザーに確認。まだ重いなら:
   - Activity Monitor で CPU/memory profile
   - asar vs filesystem の読み込みコスト比較
   - daemon の CGWindowList 呼び出しコスト (32 windows) を測定
   - Finder をデフォルト非表示にして window 数を半減させる選択肢
2. **AtelierX 側の変更を確認** — ユーザーが AtelierX 側に exclusion 再チェックの指示を出す
3. **snap 多重クリック防止** — 処理中は UI ボタンを disable する

## 8. ビルド手順

```bash
# daemon ビルド
swiftc -O -o daemon daemon.swift -framework Cocoa -framework ApplicationServices

# dev モード
npm start          # or npm run dev (--dev flag 付き)

# パッケージ
npm run dist       # → dist/mac-arm64/TiN.app + dist/TiN-X.Y.Z-arm64-mac.zip

# インストール (重要: rm -rf 必須、cp -R だと古い asar が残る)
rm -rf /Applications/TiN.app
cp -R dist/mac-arm64/TiN.app /Applications/
xattr -cr /Applications/TiN.app
open -a TiN

# リリース
gh release create vX.Y.Z dist/TiN-X.Y.Z-arm64-mac.zip dist/latest-mac.yml --title "..."
```

## 9. コンテキスト・メモ

- ユーザーは「任せる」スタイル。方針を短く提示して OK なら実装、問題が出たら素直に報告
- ユーザーは AtelierX も並行開発中。TiN と AtelierX の連携が重要な文脈
- 「壊れにくく、ユーザビリティが高い」を重視。fancy よりも robust を選ぶ
- Electron dev モードでは動くがパッケージ版で壊れるパターンが多い → 常にパッケージ版でも検証する
- CDP (port 9222) 経由での自動テストが有効。ただし `btn.click()` は mousedown を発火しないので注意
- バージョン bump → commit → push → `npm run dist` → deploy → `gh release create` の流れが確立
