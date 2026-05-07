#!/bin/bash
# 既存の未スナップウィンドウを拾って並べる
BASE="http://127.0.0.1:37123"
CYAN='\033[0;36m'; GREEN='\033[0;32m'; NC='\033[0m'

echo -e "${CYAN}[tin]${NC} 未スナップのターミナルを取得..."

curl -s "$BASE/api/v1/windows" | python3 - <<'PYEOF'
import sys, json, subprocess, time

BASE = "http://127.0.0.1:37123"
data = json.load(sys.stdin)
free = [w for w in data["windows"]
        if not w["snapped"] and any(t in w.get("app","") for t in ("Term","iterm","iTerm","Alacritty","Warp","Kitty"))]

if not free:
    print("未スナップのターミナルウィンドウが見つかりません")
    sys.exit(0)

import math, requests
n = len(free)
cols = math.ceil(math.sqrt(n))
rows = math.ceil(n / cols)
print(f"  {n} ウィンドウ発見 → {cols}×{rows} グリッドに配置します")

r = requests.post(f"{BASE}/api/v1/layout", json={"cols": cols, "rows": rows}).json()
print(f"  グリッド: {r['cols']}×{r['rows']}")
time.sleep(0.3)

for i, w in enumerate(free):
    r = requests.post(f"{BASE}/api/v1/snap",
                      json={"windowNumber": w["windowNumber"], "slot": i}).json()
    mark = "✅" if r.get("ok") else "⚠️ "
    print(f"  {mark} slot {i}: {w['app']} — {w['title'][:40]}")

print("\n完了")
PYEOF
