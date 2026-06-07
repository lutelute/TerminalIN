# TiN Windows 移植計画

(2026-06-08 作成。コードベース調査に基づく移植可能性評価と実装計画)

---

## 1. 現状の macOS 依存マップ

### 1.1 native/ax-helper.mm（全 1160 行 — ファイル全体が macOS 専用）

| 行 | 内容 | 使用 API |
|---|---|---|
| L12 | `_AXUIElementGetWindow`（AXUIElement → CGWindowID） | **非公開 AX API** |
| L14–48 | SkyLight.framework を dlopen（`SLSMainConnectionID` / `SLSGetActiveSpace` / `SLSMoveWindowsToManagedSpace` / `SLSCopySpacesForWindows` 等） | **非公開 CGS/SLS API** |
| L50–61 | ターミナルアプリ名リスト（Terminal / iTerm2 / Warp / Finder…） | macOS アプリ名前提 |
| L64–209 | `listWindows` — `CGWindowListCopyWindowInfo` + AX `kAXTitleAttribute` でタイトル補完 | CGWindowList + AXUIElement |
| L213–313 | `findAXWindowInList` — windowNumber → title → 座標 → index の4段マッチ | AXUIElement |
| L318–427 | `moveWindows` — `kAXPositionAttribute`/`kAXSizeAttribute` 設定（pos→size→pos の Terminal.app 対策付き） | AXUIElement |
| L430–499 | `raiseWindows` — `kAXRaiseAction`（フォーカスを奪わず z-order だけ上げる） | AXUIElement |
| L501–903 | Space 移動一式 — `CGSMoveWindowsToManagedSpace` 等 + 3 段フォールバック + 移動検証 | **非公開 CGS API** |
| L906–910 | `isAXTrusted`（`AXIsProcessTrusted`） | TCC 権限モデル |
| L914–936 | `getFrontmostWindowNumber` | CGWindowList |
| L941–977 | `setWindowSticky`（`CGSSetWindowTags` kCGSTagSticky — 全 Space 表示） | **非公開 CGS API** |
| L982–1023 | `getWindowIdFromHandle`（NSView* → NSWindow → windowNumber） | Cocoa |
| L1028–1110 | `listWindowsAllSpaces` / `getWindowNumbersByPid` | CGWindowList / AX |

### 1.2 main.js

| 行 | 内容 | 依存 |
|---|---|---|
| L5, L1081, L1144 | `node-pty` で `process.env.SHELL \|\| '/bin/zsh'` を spawn | SHELL 環境変数（node-pty 自体は Windows 対応） |
| L22–126 ほか | yabai 連携（`yabai -m query --spaces` 等、SA 偽陽性検証） | yabai（macOS 専用） |
| L132–138 | `runOsascript` | AppleScript |
| L146 | `lsof -ti:PORT` で DevTools ポート探索 | lsof（Windows に無し） |
| L789–846 | `normalizeAppName` + `osascriptMove`（System Events fallback） | AppleScript |
| L1091 | `ps -o tty= -p <pid>` で内蔵 PTY の tty 名取得（状態判定の突合キー） | **tty 概念** |
| L1370–1408 | アプリアイコン取得 — `mdfind` / `defaults read` / `sips` | macOS CLI 群 |
| L1604–1660 ほか | `getNativeWindowHandle()` → `getWindowIdFromHandle`、space-follow ポーリング | Cocoa + CGS |
| L1700–1860 | push-to-space（yabai 優先 → CGS fallback） | yabai + CGS |
| L2115–2117 | `titleBarStyle:'hiddenInset'`、`trafficLightPosition`、`transparent:true` | macOS 専用オプション |
| L2397–2430 | snapped タイトルの osascript 補完 | AppleScript |
| **L3117–3225** | **Claude Code hooks**: `/tmp/tin-claude-status/<tty>.json`、sh 構文 | **/tmp、sh、tty** |
| **L3227–3295** | **getClaudeStatuses**: `ps + awk` で tty 集合 + osascript で Terminal.app 全タブ一括取得 | **AppleScript + tty（最大の移植障壁）** |
| L3297–3328 | `classifyPtyState` — ストリーム末尾 + hooks 判定 | ロジックは移植可（tty キーのみ依存） |
| L3992 | `/api/v1/launch` が `spawn('/bin/sh', ['-c', cmd])` | sh |

### 1.3 その他

- **auto-snap.js L94**: `claudePath = $HOME/.local/bin/claude`（Windows は探索ロジックが必要）
- **binding.gyp**: `xcode_settings` のみ、OS 条件分岐なし
- **package.json**: `build.mac` のみ、`predev` が osascript/pkill、icon.icns
- **scripts/install.sh**: codesign / xattr / TCC — 全て macOS 専用
- **workspace.html**: `⌘` 表記、`-apple-system` フォント
- **raycast-extension/**: macOS 前提（移植対象外）
- **atelierx-plugin/**: userData パスの違い以外ほぼそのまま動く

---

## 2. 移植可能性の評価

### そのまま動く（変更ほぼ不要）
- ワークスペース管理・グリッドジオメトリ・永続化（workspaces.json / presets / settings）
- REST API サーバー、ファイル IPC（`app.getPath('userData')` は両対応）
- xterm.js レンダラ、IPC 配線、復元マッチング（`matchPersistedToLive`）
- `classifyPtyState`（突合キーを tty→別 ID に変えれば移植可）
- `setIgnoreMouseEvents({forward:true})`、`globalShortcut`、`setLoginItemSettings`、`tin://` URL scheme

### 置き換え必要

| macOS | Windows 代替 |
|---|---|
| CGWindowList 列挙 | `EnumWindows` + `GetWindowTextW` + `DwmGetWindowAttribute(DWMWA_CLOAKED)`。HWND ≒ windowNumber |
| AX move/resize | `SetWindowPos` / `DeferWindowPos`。**DWM 不可視ボーダー（~7px）補正が必須** |
| AXRaise | `SetWindowPos(HWND_TOP, SWP_NOACTIVATE)` — ほぼ完全互換 |
| `getFrontmostWindowNumber` | `GetForegroundWindow` |
| `getWindowIdFromHandle` | 不要 — Electron の `getNativeWindowHandle()` が HWND を直接返す |
| AX 権限 / TCC | 不要（権限レス）。例外: 管理者昇格プロセスは UIPI で操作不可 |
| アイコン（sips/mdfind） | `app.getFileIcon(exePath)` + `QueryFullProcessImageNameW` |
| node-pty + zsh | node-pty ConPTY（Win10 1809+）。`COMSPEC`/PowerShell を設定化 |
| hooks（sh / /tmp / tty） | PowerShell ワンライナー、`%TEMP%`、キーは tty → **session_id** |
| `lsof -ti:port` | `net.createServer` の listen 試行（クロスプラットフォーム化） |
| `titleBarStyle:'hiddenInset'` | `titleBarStyle:'hidden'` + `titleBarOverlay` |
| install.sh / codesign | electron-builder NSIS（TCC 儀式は不要） |

### Windows では不可能（または大幅に意味が変わる）

1. **他プロセスウィンドウの仮想デスクトップ移動** — 公開 COM `IVirtualDesktopManager::MoveWindowToDesktop` は自プロセス限定。他プロセスは非公開 `IVirtualDesktopManagerInternal` が必要で Windows ビルドごとに壊れる
2. **sticky（全 Space 表示）** — 公開 API では不可（非公開 `IVirtualDesktopPinnedApps` のみ）
3. **Terminal.app タブ状態スキャン（osascript 相当）** — Windows Terminal に自動化 API なし。**→ hooks 一本化が唯一の現実解**
4. **tty による claude プロセス⇔タブ突合** — Windows に tty 概念なし

---

## 3. フェーズ分け実装計画

### Phase 1: プラットフォーム抽象化レイヤー（規模: L）
macOS で動作不変のままリファクタリング。Windows コードはまだ書かない。
- `platform/index.js`（`process.platform` で選択）、`platform/darwin/`、`platform/win32/`(stub)
- 抽象インターフェース: `windowManager` / `desktops`（capability フラグ付き・全メソッド optional）/ `terminalState` / `shell` / `appIcon`
- main.js の `axHelper.` 直接参照（約 40 箇所）、yabai、osascript を抽象層経由に移動
- **突合キーを tty → Claude Code hooks の `session_id` ベースへ移行**（macOS にも適用してコード統一）— 移植の最大の前提整理

### Phase 2: Win32 native addon（規模: L）
`native/win-helper.cc`（N-API, C++）。ax-helper.mm と同じ export 名・戻り値スキーマ。
- `listWindows`: `EnumWindows` → フィルタ（`WS_VISIBLE`、`WS_EX_TOOLWINDOW` 除外、`DWMWA_CLOAKED` 除外）
- `moveWindows`: `BeginDeferWindowPos`/`EndDeferWindowPos` + **DWM 不可視ボーダー補正** + Per-Monitor V2 DPI
- `raiseWindows` / `getFrontmostWindowNumber` / `getProcessPath(pid)`
- binding.gyp に OS 条件分岐（`dwmapi.lib`, `user32.lib`）

### Phase 3: 内蔵ターミナル + hooks の Windows 化（規模: M）
- node-pty `useConpty: true`、シェル設定化（pwsh → PowerShell → cmd 優先探索）
- hooks: `%TEMP%\tin-claude-status\<session_id>.json`、PowerShell ワンライナー（stdin JSON から session_id 取得）
- 外部ターミナルの状態検出は「hooks があれば色付け、なければタイトルのスピナー検出のみ」に割り切る

### Phase 4: Electron UI / ウィンドウ差異対応（規模: M）
- `titleBarOverlay` 化、`TITLEBAR_H`/`GROUPY_Y_OFFSET` 再調整
- `transparent:true` の Windows 検証（NG なら win32 のみ非透過 + 枠だけ描画）
- ホットキー `CommandOrControl` 正規化、⌘ 表記の出し分け、`system-ui`/`Segoe UI` フォント
- アイコン取得を `app.getFileIcon` 経路に差し替え

### Phase 5: 仮想デスクトップ対応（Tier 2 / best-effort）（規模: M〜L、リスク高）
- TiN 自身: `IVirtualDesktopManager::MoveWindowToDesktop`（公開 COM、自プロセスなので合法）
- 外部ウィンドウ: VirtualDesktopAccessor.dll を**オプション依存**としてロード。失敗 → capability OFF で UI 非表示
- sticky は Windows 未対応と明示

### Phase 6: ビルド・配布（規模: S〜M）
- `build.win`（NSIS + zip、icon.ico）、`scripts.dist:win`、`predev` の platform 分岐
- GitHub Actions で win/mac マトリクスビルド（node-gyp は各 OS でビルド必須）
- `scripts/install.ps1`

### Phase 7: 連携・仕上げ（規模: S）
- atelierx-plugin の userData パス分岐、README / FEATURES.md の Windows 節

**推奨順序**: 1 → 2 → 3 → 4 → 6（ここで「仮想デスクトップ抜き」の動く Windows 版をリリース可能）→ 5 → 7

---

## 4. 設計判断が必要なポイント

1. **仮想デスクトップは完全互換にできない（最重要）** — 非公開 COM は Windows Update で壊れる実績あり。Tier 2 機能として best-effort（推奨）か初版無効化か。「動かなくても本体機能は無傷」の分離が必須
2. **状態検出の hooks 一本化** — osascript 相当は存在しない。hooks の stdin JSON の session_id + pid を新しい共通キーにし、macOS でも同キーへ移行するのが正解。hooks 設置を促すオンボーディング UI が必要
3. **HWND の揮発性** — 既存の title/サイズ近似マッチがそのまま効く。ただし Windows Terminal は 1 プロセス・タブ統合なので「snap 単位はウィンドウ」と明記、`wt -w new` 運用を案内
4. **DWM 不可視ボーダー** — `GetWindowRect` は影含みで返す。addon 内で `DWMWA_EXTENDED_FRAME_BOUNDS` 差分を吸収（既存 JS のジオメトリ計算を無改変にできる）
5. **raise とフォアグラウンドロック** — `SetForegroundWindow` 制約。`app.focus({steal:true})` で不足なら `AttachThreadInput` を addon に
6. **transparent ウィンドウ** — Windows では最大化・Win+矢印スナップと相性が悪い。`backgroundMaterial:'acrylic'` ベースの別ルックも検討
7. **デフォルトシェル** — `SHELL` 環境変数は無い。pwsh → PowerShell → cmd 探索 + 設定オーバーライド

---

## 5. リスクと回避策

| リスク | 影響 | 回避策 |
|---|---|---|
| 非公開仮想デスクトップ COM が Windows Update で破壊 | Space 系機能停止 | capability 分離、起動時セルフテスト、失敗時 UI 非表示 |
| UIPI: 昇格アプリのウィンドウが操作不可 | 一部 snap 不能 | `GetLastError=5` 検出 → 「昇格プロセスのため操作不可」バッジ |
| DWM ボーダー差異（テーマ・Win10/11） | グリッドずれ | ウィンドウごとに実測補正、固定値を使わない |
| ConPTY の描画・リサイズ挙動差 | 内蔵ターミナルのちらつき | `useConpty` 明示、Win10 1809 未満は非サポート明記 |
| hooks が実行ポリシー/AV に阻まれる | 状態色が付かない | `-NoProfile -ExecutionPolicy Bypass` + 設置後 self-test + 診断表示 |
| 常駐のウィンドウ列挙・移動が AV/EDR にフラグ | 企業環境で起動不可 | Authenticode 署名を Phase 6 で検討 |
| 抽象層導入で macOS 版が壊れる | 既存ユーザー影響 | Phase 1 は「移動のみ・挙動不変」、毎フェーズ macOS スモークテスト |
| node-gyp の Windows ビルド環境問題 | 開発・CI 障害 | GitHub Actions windows-latest でビルド済み .node を成果物に |

---

## 実装時の要参照ファイル

- `main.js` — 抽象化レイヤー導入の主戦場（axHelper 直接参照 ~40 箇所、hooks、状態判定、yabai/osascript 経路）
- `native/ax-helper.mm` — Windows addon が複製すべき export 仕様・戻り値スキーマの正本
- `binding.gyp` — OS 条件分岐の追加
- `package.json` — build.win 追加、scripts の osascript 除去
- `workspace.html` — ⌘ 表記・フォント・capability ベースの UI 出し分け
