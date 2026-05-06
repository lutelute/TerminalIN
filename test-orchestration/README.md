# TiN Orchestration API — テスト

このディレクトリは TiN の Orchestration API を使って
複数ターミナルを自動配置するテスト用ディレクトリです。

## 実行前の準備

TiN の Preferences > Developer > **Orchestration API を有効化** にチェックを入れてください。

## テスト一覧

| ファイル | 内容 |
|---|---|
| `test-5slots.sh` | 5つのターミナルを 3+2 グリッドに配置 |
| `test-6slots.sh` | 6つのターミナルを 3×2 グリッドに配置 |
| `test-snap-existing.sh` | 既存ウィンドウを拾って並べる |
| `orchestrate.py` | Python版 — 5〜10スロット可変 |

## 実行方法

```bash
cd test-orchestration
bash test-6slots.sh
# または
python3 orchestrate.py --slots 8
```
