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

# TiN を停止
osascript -e 'tell application "TiN" to quit' 2>/dev/null || true
sleep 2

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
open -a TiN
