#!/bin/bash
# TiN スモークテスト — クラッシュ耐性・復元・診断基盤の回帰検証
#
# 使い方: bash scripts/smoke-test.sh   (TiN が起動していること。install.sh の後に実行)
#
# 検証項目:
#   1. main プロセスの存在
#   2. ログ基盤 (~/Library/Logs/TiN/main.log) が機能している
#   3. REST API 応答 + Accessibility 権限
#   4. 状態ファイル (snapped.json / workspaces.json) が壊れていない
#   5. renderer を kill -9 しても自動 reload で復旧する (2026-06-11 クラッシュ対策の回帰)
#
# 注意: 項目 5 は実際に renderer を殺す。snap 状態は hydrate-snapped で復元されるが、
#       grid terminal (内蔵 PTY) を開いている場合は実行しないこと (PTY renderer は対象外)。

set -u
PASS=0; FAIL=0
ok() { echo "  ✅ $1"; PASS=$((PASS+1)); }
ng() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

LOG="$HOME/Library/Logs/TiN/main.log"
APPDATA="$HOME/Library/Application Support/TiN"

echo "[1/5] main プロセス"
MAIN_PID=$(pgrep -f "TiN.app/Contents/MacOS/TiN$" | head -1)
if [ -n "$MAIN_PID" ]; then ok "main process (pid $MAIN_PID)"; else ng "TiN が起動していない"; echo "結果: PASS=$PASS FAIL=$((FAIL))"; exit 1; fi

echo "[2/5] ログ基盤"
if [ -f "$LOG" ]; then ok "main.log 存在"; else ng "main.log なし"; fi
if grep -q "===== starting (pid $MAIN_PID)" "$LOG" 2>/dev/null; then
  ok "現プロセスの起動バナー記録"
else
  ng "起動バナーが main.log にない (ログ tee が壊れている?)"
fi

echo "[3/5] REST API / Accessibility 権限"
AX=""
for i in 1 2 3; do
  AX=$(curl -s --max-time 3 http://localhost:37123/api/ax-trust 2>/dev/null)
  [ -n "$AX" ] && break
  sleep 2
done
if echo "$AX" | grep -q '"trusted":true'; then
  ok "REST 応答 + AX trusted"
elif [ -n "$AX" ]; then
  ng "AX 権限なし: $AX (システム設定で TiN を OFF→ON)"
else
  ng "REST API 不応答 (orchApi 無効 or 起動失敗)"
fi

echo "[4/5] 状態ファイル整合性"
if python3 - <<'EOF'
import json, os, sys
base = os.path.expanduser('~/Library/Application Support/TiN')
for f in ['snapped.json', 'workspaces.json']:
    p = os.path.join(base, f)
    if os.path.exists(p):
        json.load(open(p))
EOF
then ok "snapped.json / workspaces.json は有効な JSON"; else ng "状態ファイルが破損"; fi

echo "[5/5] renderer クラッシュ自動復旧 (kill -9 → reload)"
R_PID=$(pgrep -f "TiN Helper .Renderer." | head -1)
if [ -z "$R_PID" ]; then
  ng "renderer プロセスが見つからない"
else
  BEFORE=$(grep -c "renderer gone — reloading" "$LOG" 2>/dev/null || echo 0)
  kill -9 "$R_PID"
  RECOVERED=0; ELAPSED=0
  for i in $(seq 1 10); do
    sleep 1; ELAPSED=$i
    AFTER=$(grep -c "renderer gone — reloading" "$LOG" 2>/dev/null || echo 0)
    NEW_PID=$(pgrep -f "TiN Helper .Renderer." | head -1)
    if [ "$AFTER" -gt "$BEFORE" ] && [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$R_PID" ]; then
      RECOVERED=1; break
    fi
  done
  if [ "$RECOVERED" = "1" ]; then
    ok "renderer 自動復旧 (${ELAPSED}s, pid $R_PID → $NEW_PID)"
  else
    ng "renderer が ${ELAPSED}s 以内に自動復旧しない"
  fi
fi

echo
echo "結果: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
