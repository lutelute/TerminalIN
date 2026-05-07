#!/bin/bash
# TiN Orchestration API テスト — 6ターミナルを 3×2 グリッドに配置
set -e

BASE="http://127.0.0.1:37123"
WAIT=1.8  # 各ターミナルが開くまでの待機 (秒)

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${CYAN}[tin]${NC} $1"; }
ok()   { echo -e "${GREEN}[ok]${NC}  $1"; }
err()  { echo -e "${RED}[err]${NC} $1"; exit 1; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }

# ── 接続確認 ──
log "TiN API 確認中..."
STATUS=$(curl -s --max-time 2 "$BASE/api/v1/status" 2>/dev/null)
if [ -z "$STATUS" ] || echo "$STATUS" | grep -q '"ok":false'; then
  err "TiN API に接続できません。\nPreferences > Developer > Orchestration API を有効化してください。"
fi
ok "TiN API 接続 OK"
echo "$STATUS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ws=d['workspaces'][0]
print(f\"  workspace: {ws['name']}  grid: {ws['grid']['cols']}x{ws['grid']['rows']}  snapped: {len(ws['snapped'])}\")
" 2>/dev/null || true

echo ""
log "3×2 グリッドに変更..."
curl -s -X POST "$BASE/api/v1/layout" \
  -H 'Content-Type: application/json' \
  -d '{"cols":3,"rows":2}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  cols={d[\"cols\"]} rows={d[\"rows\"]}')" 2>/dev/null
sleep 0.5

# ── 6つのターミナルを起動 ──
LABELS=("Slot-0" "Slot-1" "Slot-2" "Slot-3" "Slot-4" "Slot-5")
CMDS=(
  "echo 'TiN Test: Slot 0'; bash"
  "echo 'TiN Test: Slot 1'; bash"
  "echo 'TiN Test: Slot 2'; bash"
  "echo 'TiN Test: Slot 3'; bash"
  "echo 'TiN Test: Slot 4'; bash"
  "echo 'TiN Test: Slot 5'; bash"
)

for i in "${!LABELS[@]}"; do
  log "起動: ${LABELS[$i]} → slot $i"
  # iTerm2 で新しいウィンドウを開き、コマンドを実行
  OSASCRIPT="tell application \"iTerm2\"
    set newWindow to (create window with default profile)
    tell current session of newWindow
      write text \"${CMDS[$i]}\"
    end tell
  end tell"

  RESULT=$(curl -s -X POST "$BASE/api/v1/launch" \
    -H 'Content-Type: application/json' \
    -d "{\"cmd\":\"osascript -e '${OSASCRIPT//\'/\\'}'\",\"slot\":$i,\"timeoutMs\":8000}")

  if echo "$RESULT" | grep -q '"ok":true'; then
    ok "  launch 受付 (slot $i)"
  else
    warn "  launch 応答: $RESULT"
  fi

  sleep "$WAIT"
done

echo ""
log "配置確認中..."
sleep 1
curl -s "$BASE/api/v1/status" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ws=d['workspaces'][0]
snapped=ws['snapped']
print(f'  snapped: {len(snapped)}/6')
for s in snapped:
    print(f'    slot {s[\"slot\"]}: {s[\"app\"]} — {s[\"title\"][:40]}')
" 2>/dev/null || true

echo ""
ok "テスト完了 — TiN サイドバーで 3×2 グリッドを確認してください"
