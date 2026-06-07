# TiN (TerminalIN) 機能カタログ

全機能に正式名称をつけて整理したカタログ。実装場所つき。
(v1.4.0 時点 / 2026-06-08 整理)

---

## I. ウィンドウ管理（スナップ・レイアウト）

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 1 | **Snap** | 任意の macOS アプリウィンドウをグリッドの指定スロットに配置 | `main.js` `snap-external` (1199) |
| 2 | **Release（Unsnap）** | Snap したウィンドウを解放し元の位置・サイズに戻す | `main.js` `unsnap-external` (1250) |
| 3 | **Release All** | ワークスペースの全 Snap 済みウィンドウを一括解放 | `workspace.html` GRID セクション |
| 4 | **Grid Size** | プリセット (1×2, 2×2…) またはカスタム列×行（最大20×20）を指定 | `main.js` `set-grid-size` (1933) |
| 5 | **Grid Ratio Edit** | ✏ 編集モードでセル間の境界線をドラッグして比率調整 | `grid-overlay.html`, `update-grid-ratios` (2727) |
| 6 | **Slot Layout（セル結合）** | slotLayout で自由なセル結合レイアウトを定義 | `main.js` `set-slot-layout` (2003) |
| 7 | **Reorder Slots** | スロットドット（●）ドラッグで配置順序を変更 | `main.js` `reorder-grid-slot` (1865) |
| 8 | **Swap Slots** | 2 スロットのウィンドウを位置交換 | `main.js` `swap-grid-slots` (1904) |
| 9 | **Retile** | 全 Snap 済みウィンドウを現グリッド定義で再配置（↺） | `main.js` `retile-now` (1572) |
| 10 | **Raise** | 指定ウィンドウをアプリ非アクティブ化のまま前面化 | `main.js` `raise-snapped` (1278) |
| 11 | **Wobble** | ウィンドウをぐらぐら揺らして視認性を高める | `main.js` `wobble-window` (1294) |

## II. 表示モード

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 12 | **Grid Mode** | 複数ウィンドウをタイル状に同時表示 | `main.js` `viewMode === 'grid'` |
| 13 | **Tab Mode** | タブ切替で 1 ウィンドウずつ表示 | `main.js` `viewMode === 'tab'` (901) |
| 14 | **View Mode Toggle** | ⊞ / ⊡ ボタンでグリッド⇔タブを即切替 | `main.js` `set-view-mode` (2024) |
| 15 | **Tab Select** | タブクリックでウィンドウを前面化 | `main.js` `set-active-tab` (2033) |

## III. Space 移動

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 16 | **Push to Space (next/prev)** | TiN + 全 Snap ウィンドウを前後のデスクトップへ一括移動（◀ ▶） | `main.js` `push-to-space` (1638) |
| 17 | **Push to Space (target)** | Space ピッカーで指定デスクトップへ移動（↗） | `main.js` `push-to-space-to` (1767) |
| 18 | **Get Spaces** | デスクトップ一覧と各 Space の ID・フォーカス状態を取得 | `main.js` `get-spaces` (1737) |
| 19 | **yabai SA Check** | yabai Scripting Addition の動作確認 | `main.js` `checkYabaiSA` (46) |

## IV. 組み込みターミナル（PTY）

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 20 | **Add Grid Terminal** | TiN 内に node-pty ベースの埋め込みターミナルを作成 | `main.js` `add-grid-terminal` (1178) |
| 21 | **Remove Grid Terminal** | 指定スロットの埋め込みターミナルを削除 | `main.js` `remove-grid-terminal` (1187) |
| 22 | **Terminal Input** | 埋め込みターミナルへの標準入力送信 | `main.js` `grid-terminal-input` (1123) |
| 23 | **Terminal Resize** | PTY のカラム・行数を変更 | `main.js` `grid-terminal-resize` (1131) |

## V. ワークスペース管理

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 24 | **New Workspace** | 独立した Snap セットを持つ新規 TiN ウィンドウを作成 | `main.js` `createWorkspace` (2099) |
| 25 | **Rename Workspace** | ヘッダーの名前をクリック編集 | `main.js` `rename-workspace` (2051) |
| 26 | **Workspace Color** | blue / purple / green / orange / red / teal の 6 色テーマ | `main.js` `WS_COLORS` (622) |
| 27 | **Close Workspace** | ワークスペースを閉じる | REST `/api/v1/workspace/close` (3824) |
| 28 | **Session Persistence** | 再起動時に Snap 状態・グリッド・位置を復元 | `main.js` `loadPersistedWorkspaces` (352) |
| 29 | **Preset Save/Load** | ワークスペース設定の名前付き保存・復元 | `main.js` `save-preset` / `load-preset` (3077) |

## VI. ドロワーパネル

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 30 | **GRID Section** | Snap 中ウィンドウ一覧と個別 Release | `workspace.html` |
| 31 | **Available Windows** | Terminal / Finder / Apps / TiN タブ分類のウィンドウ一覧 | `workspace.html` |
| 32 | **Window Search** | ウィンドウ名のフィルター検索 | `workspace.html` |
| 33 | **Slot Picker** | Snap 先スロットのクリック選択 | `workspace.html` |
| 34 | **CONSOLE Section** | 埋め込みターミナルの一覧・展開操作 | `workspace.html` |

## VII. Claude Code 統合

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 35 | **Claude Status Detection** | busy / perm / input 状態を検出しタブにバッジ表示（色相=状態、濃さ=深刻度） | `main.js` `readHookStates` (3124), `classifyPtyState` (3285) |
| 36 | **Install Claude Hooks** | `~/.claude/settings.json` に監視用 hooks を自動挿入 | `main.js` `installClaudeHooks` (3189) |
| 37 | **Uninstall Claude Hooks** | TiN hooks を settings.json から削除 | `main.js` `uninstallClaudeHooks` (3210) |
| 38 | **AI Colorize** | Terminal.app 各タブの claude タスク内容を AI 判定して色割り当て | `main.js` `ai-colorize` (3095) |

## VIII. Auto-Snap（自動スナップ）

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 39 | **Auto Cluster** | Claude CLI (Haiku) でターミナルを作業内容ごとに自動グループ化・分配 | `auto-snap.js` `executeAutoSnap` (195) |
| 40 | **Auto-Snap Config** | `auto-snap.yml` でコンテキスト・ルール・グリッドサイズを指定 | `auto-snap.js` `loadConfig` (47) |
| 41 | **Auto-Snap History** | `snap-history.jsonl` に過去結果を記録し AI 判定の参考に | `auto-snap.js` `appendHistory` (77) |

## IX. Orchestration API（REST）

`http://127.0.0.1:37123`（設定で有効化時のみ）。`main.js` `startRestServer` (3713)

| # | 機能名 | エンドポイント | 内容 |
|---|--------|---------------|------|
| 42 | **Status Endpoint** | `GET /api/v1/status` | ワークスペース・グリッド・Snap 状態 |
| 43 | **Windows Endpoint** | `GET /api/v1/windows` | スナップ可能ウィンドウ一覧 |
| 44 | **Snap Endpoint** | `POST /api/v1/snap` | windowNumber / PID で Snap |
| 45 | **Layout Endpoint** | `POST /api/v1/layout` | グリッドサイズと slotLayout 設定 |
| 46 | **Launch Endpoint** | `POST /api/v1/launch` | コマンド実行 + 出現ウィンドウを自動 Snap |
| 47 | **AX Trust Check** | `GET /api/ax-trust` | Accessibility 権限確認 |
| 48 | **Retile Endpoint** | `POST /api/retile` | 全 workspace を強制再配置 |

## X. tin:// URL スキーム

`main.js` `handleTinUrl` (2906)

| # | 機能名 | URL |
|---|--------|-----|
| 49 | **Snap URL** | `tin://snap?app=X&windowNumber=Y` |
| 50 | **Raise URL** | `tin://raise?app=X&windowNumber=Y` |
| 51 | **Release URL** | `tin://release?app=X&windowNumber=Y` |
| 52 | **Workspace Focus URL** | `tin://workspace/focus` |
| 53 | **New Terminal URL** | `tin://terminal/new?cwd=X` |

## XI. 設定・カスタマイズ

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 54 | **Hotkeys** | Snap / Unsnap / Focus / スロット 1-4 のショートカット | `main.js` `DEFAULT_HOTKEYS` (182) |
| 55 | **Poll Interval** | ウィンドウ状態確認間隔（既定 3000ms） | `appSettings.pollIntervalMs` (189) |
| 56 | **Drag End Mode** | ドラッグ終了時の再配置動作 position / full / off | `appSettings.dragEndMode` (190) |
| 57 | **Sticky Windows** | Snap 済みウィンドウを全デスクトップに表示 | `appSettings.stickyWindows` (194) |
| 58 | **Orchestration API Toggle** | REST API の有効化スイッチ | `appSettings.orchApi` (195) |
| 59 | **Settings Persistence** | settings.json への設定保存・復元 | `main.js` `saveSettings` (207) |
| 60 | **Preferences** | Cmd+, の設定画面 | `main.js` (3502) |

## XII. ウィンドウ同期・復帰・安定化

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 61 | **Window Poll** | 定期的に CGWindowList で生死判定・タイトル更新 | `main.js` `pollFn` (2326) |
| 62 | **Window Recovery** | 消失した Snap ウィンドウを title/app で再マッチング復帰 | `main.js` `recoverSnappedWindows` (677) |
| 63 | **Missing Window Eviction** | 2 連続ポーリング不在で evict | `main.js` `pollFn` (2361) |
| 64 | **Stabilization Guard** | sleep/wake・ディスプレイ抜き挿し後 30 秒は消失を無視 | `main.js` `beginStabilize` (738) |
| 65 | **Cross-Space Restore** | 他 Space のウィンドウも復帰対象に含める | `main.js` `restoreSnappedWindows` (434) |
| 66 | **Batch Restore** | 起動時に全 workspace の Snap を 1 回の呼び出しで一括復帰 | `main.js` `restoreAllPending` (536) |

## XIII. 状態ファイル（外部連携プロトコル）

| # | 機能名 | ファイル | 内容 |
|---|--------|---------|------|
| 67 | **Info File** | `info.json` | バージョン・capabilities・起動時刻（起動時作成・終了時削除） |
| 68 | **Snapped File** | `snapped.json` | Snap 中ウィンドウ一覧（AtelierX 連携にも使用） |
| 69 | **Workspaces File** | `workspaces.json` | 全 workspace の状態（再起動復帰用） |

## XIV. ネイティブ機能（ax_helper / N-API addon）

`native/ax-helper.mm`

| # | 機能名 | 内容 | 関数 |
|---|--------|------|------|
| 70 | **List Windows (AX)** | AX API でウィンドウ列挙 | `ListWindows` (64) |
| 71 | **Move Windows** | AX で位置・サイズ設定（in-process <50ms） | `MoveWindows` (318) |
| 72 | **Raise Windows** | アプリ非アクティブ化のまま z-order 上げ | `RaiseWindows` (430) |
| 73 | **AX Trusted** | Accessibility 権限確認 | `IsAXTrusted` (906) |
| 74 | **Get Frontmost Window** | 最前面ウィンドウの高速取得 (~1ms) | `GetFrontmostWindowNumber` (914) |
| 75 | **Set Window Sticky** | CGS API で全 Space 表示の切替 | `SetWindowSticky` (941) |
| 76 | **Get Spaces List** | CGS API で Space 一覧取得 | `GetSpacesList` (705) |
| 77 | **Get Space for Windows** | ウィンドウの所属 Space 確認 | `GetSpaceForWindows` (661) |
| 78 | **List Windows All Spaces** | 別 Space の隠れウィンドウも列挙 | `ListWindowsAllSpaces` (1028) |
| 79 | **Move via yabai** | yabai CLI 経由の Space 移動 | `main.js` `moveWindowsViaYabai` (82) |
| 80 | **Move to Space ID** | CGS プライベート API で直接 Space 移動（fallback） | `MoveWindowsToSpaceId` (739) |
| 81 | **Move to Active Space** | 別 Space のウィンドウを現デスクトップへ呼び寄せ | `MoveWindowsToActiveSpace` (807) |

## XV. UI 状態・インタラクション

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 82 | **Focus Highlight** | frontmost ウィンドウのタブを強調表示 | `main.js` `startFrontmostPoll` (3426) |
| 83 | **Sidebar Width** | ドロワー幅のドラッグ調整 | `main.js` `sidebar-width-changed` (2770) |
| 84 | **Sidebar Toggle** | ドロワーの開閉 | `main.js` `toggle-collapse` (2063) |
| 85 | **Groupy Container Mode** | ヘッダー直下（68px オフセット）に外部アプリを配置 | `main.js` `GROUPY_Y_OFFSET` (173) |
| 86 | **Click-through** | グリッドのハンドル以外でクリックを下のアプリに透過 | `set-overlay-clickthrough` (2712) |
| 87 | **Resize Handles** | グリッドの上・右・コーナードラッグでリサイズ | `grid-overlay.html` |

## XVI. AtelierX 連携

`atelierx-plugin/main.js`

| # | 機能名 | 内容 |
|---|--------|------|
| 88 | **AtelierX Bridge** | TiN 管理ウィンドウを AtelierX カード上に 🔒 バッジ表示 |
| 89 | **Card Action (Snap)** | AtelierX の「+TiN」ボタンから Snap |
| 90 | **Card Decorator (Lock)** | TiN 管理中ウィンドウを AtelierX 自動配置から除外 |

## XVII. メニュー

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 91 | **File Menu** | New / Close Workspace | `main.js` (3509) |
| 92 | **Shell Menu** | New Grid Terminal / Close Terminal | `main.js` (3517) |
| 93 | **Edit Menu** | Retile / Grid Size / Snap Frontmost | `main.js` (3530) |
| 94 | **Window Menu** | macOS 標準（ワークスペース一覧） | Electron 標準 |

## XVIII. スクリーン・電源イベント

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 95 | **Display Events** | モニター抜き挿し時の自動復帰 | `main.js` `display-removed` (3485), `ensureOnScreen` (768) |
| 96 | **Power Events** | suspend/resume 前後の消失を無視 | `main.js` `powerMonitor` (3480) |
| 97 | **Lock Events** | スクリーンロック時の状態変化を無視 | `main.js` (3482) |

## XIX. 運用・デバッグ

| # | 機能名 | 内容 | 実装場所 |
|---|--------|------|----------|
| 98 | **Console Logging** | `[tin]` プレフィックス付きイベントログ | 全体 |
| 99 | **Remote DevTools** | CDP リモート接続（port 9222-9224） | `main.js` `pickDevToolsPort` (143) |
| 100 | **App Nap Workaround** | バックグラウンド throttle 防止フラグ | `main.js` (152) |
| 101 | **Window Focus Retile** | Electron フォーカス時に retile 実行 | `main.js` `browser-window-focus` (2664) |
| 102 | **Second Instance Guard** | 多重起動時は既存ウィンドウを前面化 | `main.js` `second-instance` (2965) |
| 103 | **Quit Cleanup** | PTY kill / info.json・snapped.json 削除 / workspaces.json 保存 | `main.js` `before-quit` (3058) |

---

**合計: 103 機能** — IPC ハンドラ / URL スキーム / REST API / メニュー / ホットキー経由でアクセス可能。
