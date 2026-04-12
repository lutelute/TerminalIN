# 引き継ぎ: TiN (TerminalIN)

> 作成日時: 2026-04-12 17:30
> セッションID: perf-regression
> ステータス: ブロック中 — パッケージ版の品質がv1.2.12より劣化

---

## 1. プロジェクト概要

**目的**: macOS 向けターミナルワークスペースマネージャー。外部ターミナル/Finder ウィンドウを grid にスナップして統合管理。

**技術スタック**: Electron 41.1.1 + node-pty + xterm.js + Swift daemon (AXUIElement)

**リポジトリ**: `/Users/shigenoburyuto/Documents/GitHub/tool_dev_SGNB/TerminalIN`
**バージョン**: v1.2.14 (未コミット — v1.2.12 からの差分が大きい)

---

## 2. アーキテクチャ・構造

### 主要コンポーネント
| コンポーネント | パス | 役割 |
|---|---|---|
| Electron main | `main.js` (~1600行) | ウィンドウ管理、IPC、daemon通信 |
| Sidebar UI | `workspace.html` | renderer、snapped/available リスト |
| Swift daemon | `daemon.swift` → `daemon` | CGWindowList + AXUIElement (list/move/raise/wobble/verify) |
| AtelierX plugin | `atelierx-plugin/` | snapped.json ファイル IPC で連携 |

### データフロー
```
[Sidebar UI] ──IPC──> [main.js] ──stdin/stdout JSON──> [daemon (Swift)]
                          │
                          ├── snapped.json ──> [AtelierX plugin]
                          └── workspaces.json (永続化)
```

---

## 3. 現在の状態

### 完了済み (このセッションで良かった変更)
- [x] `atomicWriteJSON` 非同期化 (event loop ブロック解消)
- [x] `findWorkspace` → WeakMap O(1)、`isExternalSnapped` → グローバル Map O(1)
- [x] poll handler: identity チェックで変化なし時 IPC スキップ
- [x] daemon.swift: 未使用 `readCompositorPosition` 削除
- [x] renderer: `external-windows` IPC で snappedExternals のタイトル同期更新 (タイトル表示問題修正)
- [x] `scripts/build-daemon.sh`: daemon.swift 未変更時はコンパイルスキップ
- [x] `scripts/install.sh`: daemon inode 保持インストール
- [x] `visualEffectState: 'followWindow'` (前面=クリア、背面=灰色)

### ⚠ 問題のある変更 (要調査・取消検討)
- [ ] **snap/unsnap 後の `raiseAllWorkspaceWindows` を一時削除→復元** — 復元したが、パッケージ版で依然として遅い・ぎこちない
- [ ] **unsnap で retile 削除→復元** — 復元したが動作確認不十分
- [ ] **daemon AX ラッチ (`_daemonAXUntrusted`) を廃止して毎回試行に変更** — パッケージ版で daemon が AX untrusted のまま（バナー出続ける）
- [ ] **unsnap を `batchMove` 経由に変更** (元は `osascriptMove` 直接) — Terminal.app の AX set size 拡大 silent fail 問題に対する影響未確認

### 未着手
- [ ] パッケージ版の daemon AX 権限問題の根本解決
- [ ] パッケージ版での snap/unsnap 速度検証
- [ ] v1.2.12 との A/B 比較

---

## 4. 重要な設計判断

| 判断内容 | 選択 | 理由 |
|---|---|---|
| daemon AX untrusted 時の動作 | 毎回 daemon を試行、失敗時 osascript fallback | ラッチすると権限追加後も復帰しない問題。ただしパッケージ版で機能していない |
| unsnap の move 経路 | `batchMove` (daemon 優先) | daemon trusted なら 5ms。ただし Terminal.app の set size 問題未検証 |
| vibrancy | `followWindow` | 前面=クリア、背面=灰色。ユーザー要望 |

---

## 5. 既知の問題・注意点

### 🔴 最重要: パッケージ版 (TiN.app) が v1.2.12 より悪化
- **ユーザー報告**: 「全然appが良くない」「スピード変わらない」「位置ズレ」「ぎこちない」
- dev モードでは snap 1-12ms / unsnap 5-11ms で超高速
- パッケージ版では daemon が `axTrusted: false` を返す → osascript fallback → 遅い
- `rm -rf /Applications/TiN.app && cp -R` すると daemon の TCC 認証が消える
- `scripts/install.sh` で daemon inode 保持しても解決しなかった

### 🟡 daemon AX 権限の謎
- `echo '{"cmd":"move",...}' | /Applications/TiN.app/Contents/Resources/daemon` → `axTrusted: true`
- しかし TiN.app から spawn すると `axTrusted: false` を返す
- CDHash はプロジェクトの daemon と app 内の daemon で一致 (`e9155e26...`)
- **仮説**: TiN.app (Electron) の子プロセスとして spawn された daemon は、親アプリのサンドボックス/TCC コンテキストに影響される可能性

### 🟡 AtelierX は競合していない
- ユーザー確認済み: 「aterierXは邪魔していない。競合していない」
- v1.2.10 の AtelierX 競合対策 (snapped.json 先行書き出し) は不要だった可能性

### 🟡 Terminal.app AX set size 拡大 silent fail
- daemon で unsnap すると size が戻らない可能性 (v1.2.8 で発見)
- このセッションで `batchMove` 経由に変更したが、Terminal.app でのテスト未実施

---

## 6. 直近の変更（このセッション）

### 変更ファイル (v1.2.12 → v1.2.14 未コミット)
| ファイル | 変更内容 |
|---|---|
| `main.js` | atomicWriteJSON 非同期化、findWorkspace WeakMap化、poll最適化、daemon AXラッチ廃止、snap/unsnap のraise/retile変更、vibrancy followWindow |
| `workspace.html` | DOM差分更新(セクション永続化)、xterm再マウント回避、snappedExternalsタイトル同期、lastExtIdentity廃止 |
| `daemon.swift` | `readCompositorPosition` 削除 |
| `package.json` | v1.2.14、predist/prebuild スクリプト追加 |
| `scripts/build-daemon.sh` | daemon.swift 変更時のみ再コンパイル |
| `scripts/install.sh` | daemon inode 保持インストール |

### コミット: なし (全て未コミット)

---

## 7. 次のアクション（優先順位順）

1. **v1.2.12 との差分検証**: `git stash` して v1.2.12 のパッケージ版をインストール、パッケージ版の snap/unsnap 速度を計測。v1.2.12 がそもそもどのくらいの速度だったか確認。変更前のベースラインを持っていないのが問題。

2. **問題の切り分け**: dev モードで快適なら、パッケージ版固有の問題は daemon AX 権限のみ。daemon AX が使えない場合の osascript 速度を改善するか、daemon AX 権限問題を根本解決するか。

3. **daemon AX 権限の根本解決**: 以下を検討:
   - daemon を Electron main process に組み込む (N-API addon)
   - daemon を app bundle の `Contents/MacOS/` に配置 (TCC 継承の可能性)
   - `SMAppService` / `launchd` で daemon を登録 (正規の helper tool 方式)

4. **安全な差分だけコミット**: 確実に良い変更 (atomicWriteJSON 非同期化、findWorkspace O(1)、poll 最適化、タイトル表示修正、vibrancy) だけ先にコミット。問題のある変更は revert。

---

## 8. 再開時の手順

1. `electron-mcp-server` が使える。`take_screenshot`, `send_command_to_electron`, `read_electron_logs`, `get_electron_window_info` の4ツール。
2. dev モード: `npm start` or `npm run dev` (--dev flag で DevTools 開く)
3. パッケージビルド: `npm run dist` → `bash scripts/install.sh`
4. daemon ビルド: `bash scripts/build-daemon.sh` (daemon.swift 変更時のみ再コンパイル)
5. **重要**: `rm -rf /Applications/TiN.app` でインストールすると daemon の Accessibility 権限が消える。`scripts/install.sh` を使う。

---

## 9. コンテキスト・メモ

### ユーザーの強い不満
- 「全然appが良くない」「v1.2.5 相当の方がずっと良かった」
- 高速化のつもりで raise-all / retile を削ったのが裏目に出た
- **ユーザーが求めているのは「workspace に固定された」感覚** — snap したターミナルが workspace と一体で動く
- 細かい最適化より **動作の安定性と一体感** が最優先

### dev モード vs パッケージ版の断絶
- dev モード: daemon AX trusted → snap 3ms, unsnap 5ms (完璧に動く)
- パッケージ版: daemon AX untrusted → osascript fallback → 300-1500ms (使い物にならない)
- **この断絶を解決しない限り、main.js の最適化は無意味**

### AtelierX は無罪
- ユーザー確認: AtelierX は TiN と競合していない
- snapped.json 先行書き出し等の競合対策は不要だった可能性あり

### electron-mcp-server の使い方
- port 9222 で CDP 接続。AtelierX と競合する可能性あり
- `take_screenshot` でUI確認、`send_command_to_electron` でCDP操作、`read_electron_logs` でログ取得
- ただし main process の console.log は取得できない (renderer のみ)
- main process ログは dev モードの stdout で取得

### ビルド手順メモ
```bash
# daemon ビルド (変更時のみ)
bash scripts/build-daemon.sh

# パッケージビルド
npm run dist

# インストール (daemon 権限保持)
bash scripts/install.sh

# dev モードテスト
npm run dev
# or stdout をファイルに: npx electron . --dev > /tmp/tin-dev.log 2>&1
```
