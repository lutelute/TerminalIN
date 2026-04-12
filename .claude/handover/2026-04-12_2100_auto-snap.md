# 引き継ぎ: TiN (TerminalIN)

> 作成日時: 2026-04-12 21:00
> セッションID: auto-snap
> ステータス: 進行中 — feat/auto-snap-group ブランチ、未マージ機能あり

---

## 1. ブランチ状態

- **main**: v1.2.15 リリース済み + beta/grid-resize-fix マージ済み (cc0c2ce)
- **feat/auto-snap-group** (現在): Auto Snap 機能実装済み (0a73359)、未マージ
- **beta/grid-resize-fix**: main にマージ済み

---

## 2. 今回のセッション全体の成果 (v1.2.12 → 現在)

### パフォーマンス
- **daemon を `Contents/MacOS/` に配置** → TCC 権限継承、Accessibility 個別追加不要
- パッケージ版 snap: 300-3000ms → **8-56ms**
- sidebar ドラッグ: fire-and-forget + positionOnly + 16ms throttle + poll スキップ
- atomicWriteJSON 非同期化、findWorkspace O(1)、poll identity skip

### UI
- sidebar 白背景 + 非アクティブ時灰色マスク (CSS ::after)
- workspace 固有色 (6色パレット)、「→ xxx」バッジに他 workspace 色
- snapped ウィンドウのタイトル表示バグ修正

### Grid overlay (#4)
- overlay リサイズが sidebar 操作でリセットされない
- gridHeight 永続化
- overlay resize → 即座に retile

### Auto Snap (#6)
- `Cmd+Shift+G` or メニュー Shell > Auto Snap (AI) でトリガー
- `claude` CLI (-p --model haiku) で呼び出し → サブスク内、追加コストなし
- auto-snap.yml でユーザールール + コンテキスト設定
- snap-history.jsonl に履歴蓄積 → 学習して精度向上

---

## 3. 未実装タスク (優先順)

### 3.1 コンソール固定タブ + Claude Code 呼び出し
- sidebar 下部の CONSOLE セクションをスクロールに関係なく常時表示する固定タブに
- そこから claude code を呼び出せるインターフェース
- 現在の CONSOLE は折りたたみ式の embedded terminal

### 3.2 Finder / Terminal タブの表示/非表示トグル
- AVAILABLE セクションの TERMINAL / FINDER サブセクションを個別に表示/非表示
- ユーザーが「Finder は要らない」等で非表示にできる

### 3.3 feat/auto-snap-group を main にマージ → リリース
- Auto Snap + grid resize fix をまとめて v1.2.16 としてリリース

### 3.4 #5 workspace ごとディスプレイ移動
- `Cmd+Shift+→/←` で workspace + snapped ターミナル丸ごと別ディスプレイに移動

---

## 4. ファイル構成 (主要)

```
main.js          — Electron メインプロセス (~1750行)
auto-snap.js     — Claude CLI によるターミナルクラスタリング
daemon.swift     — Swift daemon (list/move/raise/wobble/verify)
daemon           — コンパイル済みバイナリ
workspace.html   — サイドバー UI (renderer)
grid-overlay.html — グリッドオーバーレイ
package.json     — v1.2.15 + auto-snap.js
scripts/
  build-daemon.sh  — 条件付き daemon コンパイル
  install.sh       — daemon inode 保持インストール
  clean-xattr.js   — afterPack xattr 除去
.claude/CLAUDE.md — TCC 知見、ビルド手順
```

---

## 5. ビルド・開発手順

```bash
# dev モード (基本こちらで開発)
npx electron . --dev

# daemon ビルド (daemon.swift 変更時のみ)
bash scripts/build-daemon.sh

# パッケージビルド
npm run dist

# インストール (rm -rf 禁止! daemon 権限が消える)
bash scripts/install.sh
```

---

## 6. コンテキスト・メモ

### ユーザーの好み・方針
- 「基本 Electron (dev) で開発」→ dev で確認してからパッケージ版
- 動作の一体感が最重要。raise-all / retile を削ると UX が壊れる
- API は金がかかるから嫌 → Claude CLI (サブスク) を使う
- AtelierX は TiN と競合していない
- コミットまで自動で許可

### 技術的教訓
- daemon は `Contents/MacOS/` 配置が必須 (TCC 継承)
- `Contents/Resources/` だと個別 Accessibility 追加が必要で、ビルドごとに消える
- `rm -rf /Applications/TiN.app` は daemon の TCC を壊す → `scripts/install.sh` を使う
- Terminal.app の AX set size は拡大方向で silent fail → unsnap は batchMove で OK (daemon trusted なら)
- compositor verify は false-fail する → AXError 戻り値のみで判定
- sidebar ドラッグ中は poll をスキップ (daemon 競合防止)
- overlay の高さは sidebar と独立管理 (gridHeight)

### Open Issues
- #4 grid overlay リサイズ — 修正済み (cc0c2ce)、main マージ済み
- #5 workspace ごとディスプレイ移動 — 未着手
- #6 Auto Snap (AI クラスタリング) — 実装済み (0a73359)、未マージ
