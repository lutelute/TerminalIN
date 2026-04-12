# TiN (TerminalIN) — 開発ガイド

## macOS TCC と Helper バイナリの配置ルール

Electron アプリから spawn する helper バイナリ (daemon 等) が Accessibility API を使う場合:

- **`Contents/MacOS/` に配置** → 親アプリの TCC 権限を継承。個別の Accessibility 追加不要。
- `Contents/Resources/` に配置 → 独立プロセス扱い。ユーザーが手動で Accessibility に追加必要。`rm -rf` でインストールし直すと権限が消える。

**electron-builder 設定**:
```json
"extraFiles": [{ "from": "daemon", "to": "MacOS/daemon" }]
```
(`extraResources` ではなく `extraFiles` を使い、`MacOS/` に配置する)

**main.js のパス**:
```javascript
const DAEMON_BIN = app.isPackaged
  ? path.join(path.dirname(process.execPath), 'daemon')  // Contents/MacOS/
  : path.join(__dirname, 'daemon');                       // プロジェクトルート
```

## daemon ビルド

```bash
bash scripts/build-daemon.sh   # daemon.swift 未変更時はスキップ (CDHash 安定化)
```

## ビルド・インストール

```bash
npm run dist                   # predist で build-daemon.sh が自動実行
bash scripts/install.sh        # daemon inode 保持インストール (TCC 権限維持)
```

**`rm -rf /Applications/TiN.app` は使わない** → `scripts/install.sh` を使う

## 開発モード

```bash
npm run dev                    # --dev flag 付き (DevTools 開く)
npx electron . --dev > /tmp/tin-dev.log 2>&1   # stdout ログ取得用
```

## パフォーマンス計測で判明した知見

### sidebar ドラッグ中のリアルタイム追従
- `win.on('move')` で snapped ウィンドウを fire-and-forget で daemon に送信
- ドラッグ中は poll をスキップ (daemon 競合防止)
- 16ms throttle (60fps 上限)

### daemon の AXUIElement 制約
- Terminal.app の AX set size は **拡大方向で silent fail** する (macOS バグ)
- compositor verify (CGWindowList で位置検証) は AX 座標とオフセットがあり false-fail する → AXError 戻り値のみで判定

### osascript のコスト
- プロセス spawn: ~200ms、System Events IPC: ~100ms/操作
- daemon が使える場合は 3-50ms で完了するので、daemon 経路を最優先

## AtelierX との関係
- AtelierX は TiN と競合していない (ユーザー確認済み 2026-04-12)
- snapped.json ファイル IPC で連携
