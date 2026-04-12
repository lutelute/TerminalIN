#!/bin/bash
# daemon.swift が変更された場合のみ再コンパイルする。
# CDHash を安定させ、Accessibility 権限の再追加を不要にする。
set -e
cd "$(dirname "$0")/.."

SWIFT_SRC="daemon.swift"
DAEMON_BIN="daemon"
HASH_FILE=".daemon-src-hash"

# daemon.swift のハッシュを取得
CURRENT_HASH=$(shasum -a 256 "$SWIFT_SRC" | awk '{print $1}')

# 前回のハッシュと比較
if [ -f "$HASH_FILE" ] && [ -f "$DAEMON_BIN" ]; then
  PREV_HASH=$(cat "$HASH_FILE")
  if [ "$CURRENT_HASH" = "$PREV_HASH" ]; then
    echo "[build-daemon] daemon.swift unchanged — skipping compile"
    exit 0
  fi
fi

echo "[build-daemon] daemon.swift changed — recompiling..."
swiftc -O -o "$DAEMON_BIN" "$SWIFT_SRC" -framework Cocoa -framework ApplicationServices
echo "$CURRENT_HASH" > "$HASH_FILE"
echo "[build-daemon] done (⚠ CDHash changed — re-add daemon to Accessibility if needed)"
