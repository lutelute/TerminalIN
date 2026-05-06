# TiN レイアウトパターン集

AI オーケストレーションでよく使うグリッド構成のリファレンス。

---

## レイアウト A — 縦長指示台 + 右グリッド

```
┌──────────┬────┬────┐
│          │ 1  │ 2  │
│  指示台  ├────┼────┤
│  (tall)  │ 3  │ 4  │
│          ├────┼────┤
│          │ 5  │ 6  │
└──────────┴────┴────┘
  cols=3, rows=3
  slot 0: col=0, rowSpan=3  ← 縦長指示台
  slots 1-6: 右 2×3 グリッド
```

```bash
python3 layout-tall-commander.py --project ~/myproject
```

---

## レイアウト B — 上段ワイド + 下段グリッド

```
┌────────────────────┐
│    Orchestrator    │  ← 横全幅
├──────┬──────┬──────┤
│  A   │  B   │  C   │
└──────┴──────┴──────┘
  cols=3, rows=2
  slot 0: colSpan=3      ← 上段全幅
  slots 3,4,5: 下段 3列
```

```bash
python3 layout-wide-top.py --project ~/myproject
```

---

## レイアウト C — 均等グリッド (比較用)

```
┌──────┬──────┬──────┐
│  A   │  B   │  C   │
├──────┼──────┼──────┤
│  D   │  E   │  F   │
└──────┴──────┴──────┘
  cols=3, rows=2  (均等6分割)
```

```bash
python3 orchestrate.py --slots 6 --project ~/myproject
```

---

## レイアウト D — 1対1 比較

```
┌──────────┬──────────┐
│    A     │    B     │
└──────────┴──────────┘
  cols=2, rows=1
```

```bash
python3 orchestrate.py --slots 2 --project ~/myproject
```

---

## スロット ID の計算

均等グリッドの場合: `slot_id = row * cols + col`

```
3×3 グリッド:
  0 | 1 | 2
  3 | 4 | 5
  6 | 7 | 8

4×2 グリッド:
  0 | 1 | 2 | 3
  4 | 5 | 6 | 7
```

結合レイアウトの場合は `slotLayout` 内の `id` フィールドがスロット番号。

---

## merges クイックリファレンス

```python
# 左列を縦全幅に結合 (cols=3, rows=3)
merges = [{"col":0, "row":0, "colSpan":1, "rowSpan":3}]
# → slot 0 が縦長、残り slots 1,2,4,5,7,8

# 上段を横全幅に結合 (cols=3, rows=2)
merges = [{"col":0, "row":0, "colSpan":3, "rowSpan":1}]
# → slot 0 が横全幅、残り slots 3,4,5

# 左上 2×2 を大きく (cols=4, rows=2)
merges = [{"col":0, "row":0, "colSpan":2, "rowSpan":2}]
# → slot 0 が大きく、残り slots 2,3,6,7
```
