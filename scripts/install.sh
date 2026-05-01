#!/bin/bash
# TiN.app をインストール。ax_helper N-API addon は親アプリの TCC 権限を
# 継承するため、Accessibility 追加は TiN.app 本体に対して 1 回だけで済む。
set -e
cd "$(dirname "$0")/.."

APP_SRC="dist/mac-arm64/TiN.app"
APP_DST="/Applications/TiN.app"

if [ ! -d "$APP_SRC" ]; then
  echo "Error: $APP_SRC not found. Run 'npm run dist' first." >&2
  exit 1
fi

# TiN を完全停止
osascript -e 'tell application "TiN" to quit' 2>/dev/null || true
pkill -f "TiN.app/Contents/MacOS/TiN" 2>/dev/null || true
pkill -f "electron.*--dev" 2>/dev/null || true
sleep 1
# port 9222 を使っているプロセスがあれば待つ
for i in 1 2 3; do
  lsof -ti:9222 >/dev/null 2>&1 || break
  sleep 1
done

rm -rf "$APP_DST"
cp -R "$APP_SRC" "$APP_DST"

xattr -cr "$APP_DST"
# ad-hoc 自己署名: 未署名だと macOS 26 beta が Accessibility 権限を毎回リセットする
codesign --deep --force --sign - "$APP_DST" 2>/dev/null && echo "[install] codesign: ok" || echo "[install] codesign: skipped"
echo "[install] TiN.app installed to $APP_DST"
echo "[install] Starting TiN..."
"$APP_DST/Contents/MacOS/TiN" > /tmp/tin-install-check.log 2>&1 &
TIN_PID=$!
sleep 6
RESTORE=$(grep "batch restore" /tmp/tin-install-check.log 2>/dev/null)
if [ -n "$RESTORE" ]; then
  echo "[install] $RESTORE"
else
  echo "[install] (復元ログなし — workspace が少ない可能性)"
fi
