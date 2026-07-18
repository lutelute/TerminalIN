#!/bin/bash
# slot 占有一本化 (方針C) のリグレッションテスト。
# 隔離 userData (.tin-test-userdata-*) で main.js を起動するため、稼働中の TiN.app と共存できる
# (single instance lock は userData 単位)。ダミー外部窓は tin-test-w* フォルダを開いた Finder 窓。
#
#   シナリオA (.tin-test-wrapper-a.js): グリッド縮小時の evict が PTY slot を踏まないこと
#   シナリオB (.tin-test-wrapper-b.js): クラッシュ復元で PTY 占有 slot を避け、
#                                       空きゼロの窓が missing 報告+書き戻しで保持されること
set -e
cd "$(dirname "$0")/.."

SCRATCH=$(mktemp -d /tmp/tin-slot-test.XXXXXX)
LOG_A="$SCRATCH/scenario-a.log"
LOG_B="$SCRATCH/scenario-b.log"

cleanup() {
  # Finder は whose フィルタ付き close を受け付けない (-10010) ため repeat で1枚ずつ閉じる
  osascript <<'AS' 2>/dev/null || true
tell application "Finder"
  set wl to every Finder window
  repeat with w in wl
    try
      if (name of w) starts with "tin-test-w" then close w
    end try
  end repeat
end tell
AS
  rm -rf "$SCRATCH" .tin-test-userdata-a .tin-test-userdata-b
}
trap cleanup EXIT

# ── ダミー Finder 窓 (一意タイトルで自分の窓だけを識別) ──
mkdir -p "$SCRATCH/tin-test-w1" "$SCRATCH/tin-test-w2" "$SCRATCH/tin-test-w3"
open "$SCRATCH/tin-test-w1" "$SCRATCH/tin-test-w2" "$SCRATCH/tin-test-w3"
sleep 2

echo "── シナリオA: evict の PTY 占有考慮 ──"
rm -rf .tin-test-userdata-a
npx electron .tin-test-wrapper-a.js > "$LOG_A" 2>&1 || true
grep "\[SCENARIO\]" "$LOG_A"
if grep -q "FAIL" "$LOG_A" || ! grep -q "DONE: 6/6" "$LOG_A"; then
  echo "scenario A FAILED (log: $LOG_A)"; cp "$LOG_A" /tmp/tin-slot-test-a-failed.log; exit 1
fi

echo "── シナリオB: 復元経路の占有考慮 + no-slot 保持 ──"
rm -rf .tin-test-userdata-b && mkdir -p .tin-test-userdata-b
node -e "
const ax = require('./build/Release/ax_helper.node');
const wins = ax.listWindows().filter(w => w.app === 'Finder' && /^tin-test-w/.test(w.title || ''));
if (wins.length < 2) { console.error('dummy windows missing:', wins.length); process.exit(1); }
const [w1, w2] = wins;
const mk = (w, slot) => ({ windowNumber: w.windowNumber, app: w.app, pid: w.pid, title: w.title,
  windowIndex: w.windowIndex || 0, slot, origX: w.x, origY: w.y, origW: w.width, origH: w.height, snappedAt: Date.now() });
const payload = { version: 1, savedAt: Date.now(), workspaces: [{
  name: 'TestB',
  sidebar: { x: 80, y: 80, width: 1100, height: 650 },
  sidebarWidth: 300,
  grid: { cols: 2, rows: 1, colRatios: null, rowRatios: null, slotLayout: null },
  colorIndex: 0,
  // w1: PTY(slot0) と競合する persisted slot0 / w2: 無効 slot5 → 空きゼロで no-slot になる
  snappedExternals: [ mk(w1, 0), mk(w2, 5) ],
  gridTerminals: [ { slot: 0, sessionId: 'tin-test-bogus-session', cwd: '' } ],
  spaceId: 0, memo: '',
}]};
require('fs').writeFileSync('.tin-test-userdata-b/workspaces.json', JSON.stringify(payload));
require('fs').writeFileSync('$SCRATCH/wn2.txt', String(w2.windowNumber));
"
npx electron .tin-test-wrapper-b.js > "$LOG_B" 2>&1 || true
grep "\[SCENARIO\]" "$LOG_B"
if grep -q "FAIL" "$LOG_B" || ! grep -q "RUNTIME DONE: 2/2" "$LOG_B"; then
  echo "scenario B FAILED (log: $LOG_B)"; cp "$LOG_B" /tmp/tin-slot-test-b-failed.log; exit 1
fi
# B3: no-slot の窓が quit 後の workspaces.json に書き戻されている (旧実装は黙って永久消滅)
WN2=$(cat "$SCRATCH/wn2.txt")
python3 -c "
import json, sys
d = json.load(open('.tin-test-userdata-b/workspaces.json'))
snaps = d['workspaces'][0]['snappedExternals']
kept = any(s['windowNumber'] == int('$WN2') for s in snaps)
print('B3:', 'PASS — no-slot エントリが書き戻されている' if kept else 'FAIL — 消滅')
sys.exit(0 if kept else 1)
"

echo "ALL PASS"
