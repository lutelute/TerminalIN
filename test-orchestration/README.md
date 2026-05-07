# TiN Orchestration — テスト & サンプル集

## 前提

TiN の **Preferences > Developer > Orchestration API を有効化** にチェックが入っていること。

```bash
curl -s http://127.0.0.1:37123/api/v1/status | python3 -m json.tool
```

---

## スクリプト一覧

| ファイル | 内容 |
|---|---|
| `tin-terminal-test.py` | 単体テスト — 1ターミナル起動・認識・スナップ・削除 |
| `layout-tall-commander.py` | **縦長指示台 + 右グリッド** |
| `layout-wide-top.py` | **上段ワイド指示台 + 下段グリッド** |
| `orchestrate.py` | 均等グリッド (5〜10 スロット可変) |
| `cleanup-ws.py` | workspace の全スナップ解除 + ターミナルを閉じる |
| `LAYOUTS.md` | レイアウトパターン集とスロット ID 計算 |

---

## よく使うコマンド

### 縦長指示台 + 右4エージェント (レイアウト A)

```
┌──────────┬────┬────┐
│          │ A  │ B  │
│ Commander├────┼────┤
│  (tall)  │ C  │ D  │
└──────────┴────┴────┘
```

```bash
# テストして確認
python3 layout-tall-commander.py --project ~/myproject --agents 4

# 確認後残す
python3 layout-tall-commander.py --project ~/myproject --agents 4 --keep
```

---

### 上段ワイド + 下段3分割 (レイアウト B)

```
┌────────────────────┐
│    Orchestrator    │
├──────┬──────┬──────┤
│  A   │  B   │  C   │
└──────┴──────┴──────┘
```

```bash
python3 layout-wide-top.py --project ~/myproject --agents 3 --keep
```

---

### 均等6分割 (比較用)

```bash
python3 orchestrate.py --slots 6 --project ~/myproject
```

---

### 単体テスト (1ターミナルだけ動作確認)

```bash
python3 tin-terminal-test.py --project ~/myproject
```

---

### クリーンアップ

```bash
# 特定 workspace を全解除
python3 cleanup-ws.py --ws-id 1

# 全 workspace を解除
python3 cleanup-ws.py

# unsnap だけ (ウィンドウは閉じない)
python3 cleanup-ws.py --ws-id 1 --unsnap-only
```

---

## API クイックリファレンス

```bash
BASE="http://127.0.0.1:37123"

# 状態確認
curl -s $BASE/api/v1/status | python3 -m json.tool

# グリッド設定 (3×2 均等)
curl -s -X POST $BASE/api/v1/layout \
  -H 'Content-Type: application/json' \
  -d '{"cols":3,"rows":2}'

# 結合レイアウト (上段全幅)
curl -s -X POST $BASE/api/v1/layout \
  -H 'Content-Type: application/json' \
  -d '{"cols":3,"rows":2,"merges":[{"col":0,"row":0,"colSpan":3,"rowSpan":1}]}'

# 既存ウィンドウをスナップ
curl -s -X POST $BASE/api/v1/snap \
  -H 'Content-Type: application/json' \
  -d '{"windowNumber":1234,"slot":0}'

# unsnap
curl -s -X POST $BASE/api/unsnap \
  -H 'Content-Type: application/json' \
  -d '{"windowNumber":1234}'
```
