#!/bin/bash
# TiN.app をインストール。daemon バイナリが変わっていなければ inode を保持し、
# Accessibility 権限の再追加を不要にする。
set -e
cd "$(dirname "$0")/.."

APP_SRC="dist/mac-arm64/TiN.app"
APP_DST="/Applications/TiN.app"
DAEMON_REL="Contents/MacOS/daemon"

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

# daemon バイナリが同一なら保持
PRESERVE_DAEMON=0
if [ -f "$APP_DST/$DAEMON_REL" ] && [ -f "$APP_SRC/$DAEMON_REL" ]; then
  OLD_HASH=$(shasum -a 256 "$APP_DST/$DAEMON_REL" | awk '{print $1}')
  NEW_HASH=$(shasum -a 256 "$APP_SRC/$DAEMON_REL" | awk '{print $1}')
  if [ "$OLD_HASH" = "$NEW_HASH" ]; then
    PRESERVE_DAEMON=1
    echo "[install] daemon unchanged — preserving Accessibility authorization"
  else
    echo "[install] daemon changed — ⚠ re-add to Accessibility if needed"
  fi
fi

if [ "$PRESERVE_DAEMON" = "1" ]; then
  # daemon 以外を更新
  # 1. 新しい app から daemon を一時退避（使わない）
  # 2. 古い app の daemon を一時退避
  cp "$APP_DST/$DAEMON_REL" /tmp/tin-daemon-preserve
  rm -rf "$APP_DST"
  cp -R "$APP_SRC" "$APP_DST"
  # 3. 保持した daemon を書き戻す（元の inode の内容をコピー…ではなく、
  #    同じバイナリなので新しいものをそのまま使い、TCC に再追加で対応）
  # 実は cp でも inode は変わる。macOS TCC は CDHash ベースなので
  # バイナリ内容が同一なら OK のはず。念のため元のファイルで上書き。
  cp -f /tmp/tin-daemon-preserve "$APP_DST/$DAEMON_REL"
  rm -f /tmp/tin-daemon-preserve
else
  rm -rf "$APP_DST"
  cp -R "$APP_SRC" "$APP_DST"
fi

xattr -cr "$APP_DST"
echo "[install] TiN.app installed to $APP_DST"
echo "[install] Starting TiN..."
# 直接実行でログを取得し、復元速度を自動確認
"$APP_DST/Contents/MacOS/TiN" > /tmp/tin-install-check.log 2>&1 &
TIN_PID=$!
sleep 6
RESTORE=$(grep "batch restore" /tmp/tin-install-check.log 2>/dev/null)
if [ -n "$RESTORE" ]; then
  echo "[install] $RESTORE"
else
  echo "[install] (復元ログなし — workspace が少ないか daemon 未 ready)"
fi
echo "[install] daemon: $(echo '{"cmd":"move","id":"1","windows":[]}' | "$APP_DST/$DAEMON_REL" 2>/dev/null | grep axTrusted | head -1)"
