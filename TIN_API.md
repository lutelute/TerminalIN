# TiN Orchestration API

AI エージェントがこのドキュメントを読んで、TiN のグリッドを即座に制御できるようにするためのリファレンスです。

## 前提条件

- TiN.app が起動済みであること
- Preferences > Developer > **Orchestration API を有効化** にチェックが入っていること
- ベース URL: `http://127.0.0.1:37123`

有効化確認:
```bash
curl -s http://127.0.0.1:37123/api/v1/status | python3 -m json.tool
```
`{"ok": true, ...}` が返れば OK。

---

## クイックスタート（AI 向け 3 ステップ）

```bash
# Step 1: 現在の状態を確認
curl -s http://127.0.0.1:37123/api/v1/status

# Step 2: グリッドを設定（例: 3列1行）
curl -s -X POST http://127.0.0.1:37123/api/v1/layout \
  -H 'Content-Type: application/json' \
  -d '{"cols":3,"rows":1}'

# Step 3: アプリを起動してスロットに配置
curl -s -X POST http://127.0.0.1:37123/api/v1/launch \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"open -a iTerm2","slot":0}'
```

---

## API リファレンス

### GET /api/v1/status
現在のワークスペース・グリッド・スナップ状態を返す。

```bash
curl -s http://127.0.0.1:37123/api/v1/status
```

レスポンス例:
```json
{
  "ok": true,
  "version": "1",
  "port": 37123,
  "workspaces": [
    {
      "id": 1,
      "name": "Workspace 1",
      "grid": {
        "cols": 2,
        "rows": 2,
        "slotLayout": null
      },
      "snapped": [
        {"windowNumber": 123, "app": "iTerm2", "title": "bash", "slot": 0}
      ]
    }
  ]
}
```

---

### GET /api/v1/windows
現在画面にある全ウィンドウの一覧（TiN 自身を除く）。

```bash
curl -s http://127.0.0.1:37123/api/v1/windows
```

レスポンス例:
```json
{
  "ok": true,
  "windows": [
    {
      "windowNumber": 123,
      "app": "iTerm2",
      "title": "bash — ~/project",
      "pid": 4567,
      "x": 0, "y": 25, "width": 960, "height": 540,
      "snapped": false
    }
  ]
}
```

---

### POST /api/v1/layout
グリッドサイズと結合レイアウトを設定する。**ウィンドウの再配置まで自動で行われる。**

```bash
# 均等 2×2
curl -s -X POST http://127.0.0.1:37123/api/v1/layout \
  -H 'Content-Type: application/json' \
  -d '{"cols":2,"rows":2}'

# 3列1行
curl -s -X POST http://127.0.0.1:37123/api/v1/layout \
  -H 'Content-Type: application/json' \
  -d '{"cols":3,"rows":1}'

# 上段を横全幅にした 3×2 (slotLayout で結合を指定)
curl -s -X POST http://127.0.0.1:37123/api/v1/layout \
  -H 'Content-Type: application/json' \
  -d '{
    "cols": 3,
    "rows": 2,
    "layout": [
      {"id":0,"col":0,"row":0,"colSpan":3,"rowSpan":1},
      {"id":3,"col":0,"row":1,"colSpan":1,"rowSpan":1},
      {"id":4,"col":1,"row":1,"colSpan":1,"rowSpan":1},
      {"id":5,"col":2,"row":1,"colSpan":1,"rowSpan":1}
    ]
  }'
```

リクエストボディ:

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `cols` | number | ✓ | 列数 (1–20) |
| `rows` | number | ✓ | 行数 (1–20) |
| `layout` | array | — | セル結合定義（省略時は均等分割） |
| `workspaceId` | number | — | 対象 workspace ID（省略時は最初の ws） |

`layout` の各要素:

| フィールド | 説明 |
|---|---|
| `id` | スロット ID = `row * cols + col` |
| `col` | 左端の列インデックス (0始まり) |
| `row` | 上端の行インデックス (0始まり) |
| `colSpan` | 横に占めるセル数 |
| `rowSpan` | 縦に占めるセル数 |

レスポンス例:
```json
{"ok": true, "cols": 3, "rows": 2, "slotLayout": [...]}
```

---

### POST /api/v1/snap
既に起動しているウィンドウを指定スロットにスナップする。

```bash
# windowNumber で指定
curl -s -X POST http://127.0.0.1:37123/api/v1/snap \
  -H 'Content-Type: application/json' \
  -d '{"windowNumber": 123, "slot": 0}'

# PID で指定
curl -s -X POST http://127.0.0.1:37123/api/v1/snap \
  -H 'Content-Type: application/json' \
  -d '{"pid": 4567, "slot": 1}'

# slot 省略 → 空きスロットに自動配置
curl -s -X POST http://127.0.0.1:37123/api/v1/snap \
  -H 'Content-Type: application/json' \
  -d '{"pid": 4567}'
```

リクエストボディ:

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `windowNumber` | number | いずれか | `/api/v1/windows` で取得する値 |
| `pid` | number | いずれか | プロセス ID |
| `slot` | number | — | スロット ID（省略時: 空き自動選択） |
| `workspaceId` | number | — | 対象 workspace |

レスポンス例:
```json
{"ok": true, "slot": 0, "windowNumber": 123}
```

---

### POST /api/v1/launch
コマンドを実行し、**出現したウィンドウを自動でスナップする**。起動完了を待たず 202 を即返す。

```bash
# iTerm2 を起動して slot 0 に配置
curl -s -X POST http://127.0.0.1:37123/api/v1/launch \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"open -a iTerm2","slot":0}'

# 新しい iTerm2 タブをコマンド付きで開く
curl -s -X POST http://127.0.0.1:37123/api/v1/launch \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"osascript -e '\''tell app \"iTerm2\" to create window with default profile command \"claude\"'\''","slot":1}'

# Finder を開いて slot 2 に
curl -s -X POST http://127.0.0.1:37123/api/v1/launch \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"open ~/Documents","slot":2}'
```

リクエストボディ:

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `cmd` | string | ✓ | シェルコマンド (`/bin/sh -c` で実行) |
| `slot` | number | — | スナップ先スロット（省略時: 空き自動選択） |
| `timeoutMs` | number | — | ウィンドウ出現待ちタイムアウト ms（デフォルト 8000, 最大 30000）|
| `workspaceId` | number | — | 対象 workspace |

レスポンス例:
```json
{"ok": true, "pid": 9876, "note": "launching, window will be snapped automatically"}
```

> **注意**: launch は非同期。コマンド送信後にウィンドウが TiN に届くまで数秒かかる。複数の launch を連続して呼ぶ場合は `sleep 1.5` などの待機を挟む。

---

## レシピ例（AI オーケストレーション）

### 3エージェント比較セットアップ

```bash
#!/bin/bash
BASE="http://127.0.0.1:37123"

# 1. 3列グリッドに変更
curl -s -X POST $BASE/api/v1/layout \
  -H 'Content-Type: application/json' \
  -d '{"cols":3,"rows":1}'

sleep 0.5

# 2. 各エージェントを起動
for slot in 0 1 2; do
  curl -s -X POST $BASE/api/v1/launch \
    -H 'Content-Type: application/json' \
    -d "{\"cmd\":\"osascript -e 'tell app \\\"iTerm2\\\" to create window with default profile'\",\"slot\":$slot}"
  sleep 1.5
done
```

### 既存ウィンドウを並べる

```bash
BASE="http://127.0.0.1:37123"

# ウィンドウ一覧を取得してターミナルだけ抽出
WINS=$(curl -s $BASE/api/v1/windows | python3 -c "
import sys, json
ws = json.load(sys.stdin)['windows']
terms = [w for w in ws if 'Term' in w.get('app','') and not w['snapped']]
for i, w in enumerate(terms[:3]):
    print(w['windowNumber'], i)
")

# 2×2 グリッドに変更してスナップ
curl -s -X POST $BASE/api/v1/layout \
  -H 'Content-Type: application/json' \
  -d '{"cols":2,"rows":2}'

echo "$WINS" | while read wn slot; do
  curl -s -X POST $BASE/api/v1/snap \
    -H 'Content-Type: application/json' \
    -d "{\"windowNumber\":$wn,\"slot\":$slot}"
done
```

### Python からの利用

```python
import requests, time, subprocess

BASE = "http://127.0.0.1:37123"

def tin(method, path, **kwargs):
    return requests.request(method, BASE + path, **kwargs).json()

# 3列に変更
tin("POST", "/api/v1/layout", json={"cols": 3, "rows": 1})
time.sleep(0.3)

# 3つのターミナルを起動
commands = ["claude", "gemini", "echo hello"]
for slot, cmd in enumerate(commands):
    tin("POST", "/api/v1/launch", json={
        "cmd": f"osascript -e 'tell app \"iTerm2\" to create window with default profile command \"{cmd}\"'",
        "slot": slot
    })
    time.sleep(1.5)
```

---

## スロット ID の計算

均等グリッド (`slotLayout` が `null`) の場合:

```
slot_id = row * cols + col

例: 3×2 グリッド
  slot 0 | slot 1 | slot 2
  slot 3 | slot 4 | slot 5
```

`slotLayout` がある場合は各セルの `id` フィールドが slot_id。

---

## エラーレスポンス

```json
{"ok": false, "error": "window not found"}
```

| HTTP Status | 意味 |
|---|---|
| 200 | 成功 |
| 202 | 受付（launch は非同期なので 202） |
| 400 | リクエスト不正 (cmd 未指定など) |
| 404 | 対象が見つからない |
| 409 | スロットが満杯 |

---

### POST /api/v1/workspace/new
新しい TiN ワークスペースウィンドウを作成する。

```bash
curl -s -X POST http://127.0.0.1:37123/api/v1/workspace/new \
  -H 'Content-Type: application/json' \
  -d '{"name":"AI-比較テスト"}'
```

レスポンス: `{"ok": true, "id": 4, "name": "AI-比較テスト"}`

---

### POST /api/v1/workspace/close
TiN ワークスペースウィンドウを閉じる。

```bash
curl -s -X POST http://127.0.0.1:37123/api/v1/workspace/close \
  -H 'Content-Type: application/json' \
  -d '{"id": 4}'
```

レスポンス: `{"ok": true, "id": 4}`

---

## 旧 API（後方互換）

以下は引き続き使用可能（v1 系の方が高機能）:

| エンドポイント | 説明 |
|---|---|
| `GET /api/status` | ワークスペース状態 |
| `GET /api/windows` | ウィンドウ一覧 |
| `POST /api/snap` | フロントウィンドウをスナップ |
| `POST /api/unsnap` | アンスナップ |
| `POST /api/focus` | TiN をフォーカス |
