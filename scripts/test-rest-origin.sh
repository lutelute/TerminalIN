#!/bin/bash
# REST API の Origin/Host 検証テスト。
# 隔離 userData + TIN_REST_PORT で起動するため、稼働中の TiN (37123) と共存できる。
#   - ネイティブクライアント (Origin なし) は従来通り 200
#   - localhost 系 Origin は 200 / それ以外・null Origin は 403
#   - DNS rebinding (Host が外部ドメイン) は 403
#   - 応答に Access-Control-Allow-Origin が付かない
set -e
cd "$(dirname "$0")/.."

PORT=37199
BASE="http://127.0.0.1:$PORT"
UD=.tin-test-userdata-rest
# macOS の mktemp はテンプレート末尾の X 列しか置換しない。
# 以前は '...XXXXXX.log' としていたためリテラル名のファイルが残り、2回目以降
# 「File exists」+ set -e でテスト本体が一度も走らない状態になっていた。
LOG=$(mktemp /tmp/tin-rest-test.XXXXXX)
PASS=0; FAIL=0

cleanup() {
  [ -n "$TIN_PID" ] && kill "$TIN_PID" 2>/dev/null || true
  sleep 1
  rm -rf "$UD"
}
trap cleanup EXIT

rm -rf "$UD" && mkdir -p "$UD"
printf '{"orchApi": true}\n' > "$UD/settings.json"

TIN_REST_PORT=$PORT npx electron .tin-test-wrapper-rest.js > "$LOG" 2>&1 &
TIN_PID=$!

# REST が上がるまで待つ (最大 20s)
for i in $(seq 1 40); do
  curl -s -o /dev/null "$BASE/api/status" && break
  sleep 0.5
done

check() { # <name> <expected_status> <actual_status>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1 (HTTP $3)";
  else FAIL=$((FAIL+1)); echo "FAIL: $1 (expected $2, got $3)"; fi
}

S=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/status")
check "Origin なし (ネイティブクライアント) は許可" 200 "$S"

S=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: http://127.0.0.1:$PORT" "$BASE/api/status")
check "localhost 系 Origin は許可" 200 "$S"

S=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: https://evil.example" "$BASE/api/status")
check "外部 Origin は拒否" 403 "$S"

S=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: null" "$BASE/api/status")
check "null Origin は拒否" 403 "$S"

S=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: evil.example" "$BASE/api/status")
check "DNS rebinding (外部 Host) は拒否" 403 "$S"

S=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Origin: https://evil.example" \
  -H 'Content-Type: application/json' -d '{"cmd":"true"}' "$BASE/api/v1/launch")
check "外部 Origin からの /api/v1/launch は拒否" 403 "$S"

ACAO=$(curl -s -D - -o /dev/null "$BASE/api/status" | grep -ci 'access-control-allow-origin' || true)
check "応答に Access-Control-Allow-Origin が無い" 0 "$ACAO"

echo "----"
echo "result: $PASS pass / $FAIL fail"
if [ "$FAIL" -gt 0 ]; then cp "$LOG" /tmp/tin-rest-test-failed.log; exit 1; fi
rm -f "$LOG"
echo "ALL PASS"
