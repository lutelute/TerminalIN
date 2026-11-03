#!/bin/bash
# 実機テスト: TiN ごと端末を別デスクトップへ運ぶ (lib/space-carry.js)。
# 隔離 userData で開発版を起動するので、稼働中の TiN.app と共存できる。
#
# やること: 検証用のデスクトップを右端に 1 枚足す → 試験用の Terminal 窓を 3 枚開く →
#   開発版に内蔵端末 1 つ + 試験窓 2 枚を snap → 右のデスクトップへ運ぶ → 左へ戻す →
#   TiN だけを動かして追従を確かめる → 通し試験 (緑ボタンで広げる・ワークスペース 2 を右のデスクトップへ・
#   行き来しても外れない) → 試験窓と検証用デスクトップを片付ける。
# 画面が実際に何度か切り替わる。終わるまでマウスとキーボードに触らないこと。
# 前提: Mission Control の「左/右の操作スペースに移動」が有効であること。
#   右隣に通常デスクトップが無ければ検証用に足し、終わったらその 1 枚だけを消す。
set -e
cd "$(dirname "$0")/.."

LOG=$(mktemp /tmp/tin-space-carry.XXXXXX)
ADDED_DESKTOP=0   # 足した検証用デスクトップの Space ID (0 = 足していない)
WNS=""

active() { node -e "console.log(require('./build/Release/ax_helper.node').getActiveSpaceId())"; }
spaces_json() { node -e "console.log(JSON.stringify(require('./build/Release/ax_helper.node').getSpacesList()))"; }
has_right_desktop() {
  node -e "
const a = require('./build/Release/ax_helper.node');
const l = a.getSpacesList(); const cur = l.find(s => s.isCurrent);
const same = l.filter(s => s.display === cur.display); const i = same.indexOf(cur);
process.exit(same.slice(i + 1).some(s => s.type === 0) ? 0 : 1);"
}

mission_control() {   # $1 = add | remove <1 始まりの位置>
  osascript - "$1" "${2:-0}" <<'AS' >/dev/null 2>&1 || true
on run argv
  set mode to item 1 of argv
  set pos to (item 2 of argv) as integer
  do shell script "open -a 'Mission Control'"
  delay 0.9
  tell application "System Events"
    tell process "Dock"
      try
        if mode is "add" then
          repeat with b in (every button of group 2 of group 1 of group 1)
            try
              if description of b contains "追加" or description of b contains "add" then click b
            end try
          end repeat
        else if pos > 0 then
          perform action "AXRemoveDesktop" of button pos of list 1 of group 2 of group 1 of group 1
        end if
      end try
    end tell
    delay 0.6
    key code 53
  end tell
end run
AS
  sleep 1
}
# Space ID → Mission Control のスペースバーでの位置 (今のディスプレイ、1 始まり)。無ければ 0
space_pos() {
  node -e "
const l = require('./build/Release/ax_helper.node').getSpacesList(); const cur = l.find(s => s.isCurrent);
const same = l.filter(s => s.display === cur.display); console.log(same.findIndex(s => s.id === $1) + 1);"
}

cleanup() {
  for wn in ${WNS//,/ }; do osascript -e "tell application \"Terminal\" to close window id $wn" 2>/dev/null || true; done
  if [ "$ADDED_DESKTOP" != 0 ]; then
    # 足した Space ID の位置のボタンだけを消す (並びの最後はフルスクリーンのアプリのことがある)
    POS=$(space_pos "$ADDED_DESKTOP")
    if [ "$POS" -gt 0 ]; then mission_control remove "$POS"; fi
  fi
  rm -rf .tin-test-userdata-space
}
trap cleanup EXIT

if ! has_right_desktop; then
  echo "右隣に通常デスクトップが無いので検証用に 1 枚足す"
  ids_before=$(node -e "console.log(require('./build/Release/ax_helper.node').getSpacesList().map(s=>s.id).join(','))")
  mission_control add
  ADDED_DESKTOP=$(node -e "
const b = new Set('$ids_before'.split(',').map(Number));
const n = require('./build/Release/ax_helper.node').getSpacesList().find(s => !b.has(s.id));
console.log(n ? n.id : 0)")
  echo "added desktop id=$ADDED_DESKTOP"
fi
echo "spaces: $(spaces_json)"

# 試験用の Terminal 窓 (新しく開いた 3 枚の windowNumber を控える。2 枚は ws1、1 枚は通し試験の ws2)
before=$(node -e "console.log(require('./build/Release/ax_helper.node').listWindowsAllSpaces().filter(w=>/Terminal|ターミナル/.test(w.app)).map(w=>w.windowNumber).join(','))")
osascript -e 'tell application "Terminal" to do script "echo tin-space-carry-test-1"' >/dev/null
osascript -e 'tell application "Terminal" to do script "echo tin-space-carry-test-2"' >/dev/null
osascript -e 'tell application "Terminal" to do script "echo tin-space-carry-test-3"' >/dev/null
sleep 1.5
WNS=$(node -e "
const b = new Set('$before'.split(',').map(Number));
const a = require('./build/Release/ax_helper.node').listWindowsAllSpaces().filter(w=>/Terminal|ターミナル/.test(w.app) && !b.has(w.windowNumber));
console.log(a.map(w=>w.windowNumber).sort((x,y)=>x-y).slice(0,3).join(','))")
echo "test terminals: $WNS"
[ -n "$WNS" ] || { echo "試験窓が見つからない"; exit 1; }
# 題名: 1 と 3 は同じ (再リンクの横取りの回帰試験・Mission Control では見分けられないので切替キーの方式に回る)、
# 2 だけ固有 (Mission Control でまとめて運ぶ方式が使われる)
set_title() {
  osascript -e "tell application \"Terminal\"" -e "set title displays custom title of selected tab of window id $1 to true" \
    -e "set custom title of selected tab of window id $1 to \"$2\"" -e "end tell" >/dev/null 2>&1 || true
}
IFS=, read -r W1 W2 W3 <<< "$WNS"
set_title "$W1" "tin-carry-same"; set_title "$W2" "tin-carry-unique"; set_title "$W3" "tin-carry-same"

rm -rf .tin-test-userdata-space
TIN_TEST_WNS="$WNS" npx electron .tin-test-wrapper-space.js > "$LOG" 2>&1 || true
grep -E "\[SCENARIO\]|space-carry" "$LOG"
if grep -q "FAIL" "$LOG" || ! grep -q "DONE:" "$LOG"; then echo "FAILED (log: $LOG)"; exit 1; fi
echo "ALL PASS (log: $LOG)"
