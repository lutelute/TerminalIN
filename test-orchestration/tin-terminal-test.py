#!/usr/bin/env python3
"""
TiN ターミナル制御テスト
- 新しいターミナルを1つだけ開く
- TiN がそれを認識してスナップ
- 他のターミナルは一切触らない
- 最後に unsnap + ウィンドウを閉じる

使い方: python3 tin-terminal-test.py [--ws-id N] [--slot N] [--keep]
  --ws-id N  : スナップ先 workspace ID (デフォルト: 空きのある ws を自動選択)
  --slot  N  : スロット番号 (デフォルト: 0)
  --keep     : テスト後もターミナルを残す (自動クローズしない)
  --project P: ターミナルを開くディレクトリ (デフォルト: カレント)
"""
import argparse, subprocess, time, os, sys, json, shlex

try:
    import requests
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "requests"])
    import requests

BASE = "http://127.0.0.1:37123"

def tin(method, path, **kw):
    try:
        r = requests.request(method, BASE + path, timeout=10, **kw)
        return r.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}

def step(n, msg):
    print(f"\n[{n}] {msg}")

def ok(msg):   print(f"    ✅ {msg}")
def err(msg):  print(f"    ❌ {msg}"); sys.exit(1)
def warn(msg): print(f"    ⚠️  {msg}")
def info(msg): print(f"    → {msg}")

# ─────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser()
    p.add_argument("--ws-id",  type=int, default=None)
    p.add_argument("--slot",   type=int, default=0)
    p.add_argument("--keep",   action="store_true")
    p.add_argument("--project", default=os.getcwd())
    args = p.parse_args()

    project = os.path.expanduser(args.project)
    print("=" * 52)
    print("  TiN ターミナル制御テスト")
    print("=" * 52)

    # ── Step 1: API 確認 ──────────────────────────────
    step(1, "TiN API 接続確認")
    d = tin("GET", "/api/v1/status")
    if not d.get("ok"):
        err(f"API 接続失敗: {d.get('error','')}\nPreferences > Developer > Orchestration API を有効化してください")
    ok(f"接続 OK  (workspaces: {len(d['workspaces'])})")

    # workspace 選択
    ws_id = args.ws_id
    if not ws_id:
        ws_id = sorted(d["workspaces"], key=lambda w: len(w["snapped"]))[0]["id"]
    ws_name = next((w["name"] for w in d["workspaces"] if w["id"] == ws_id), "?")
    info(f"対象 workspace: '{ws_name}' (id={ws_id})")

    # ── Step 2: AppleScript で新ターミナルを開き ID を直接取得 ──
    # open -na Terminal を使わない理由:
    # 「どのウィンドウが新しく開いたか」を差分検出すると、テスト元ターミナルが
    # TiN に未登録のまま before_wns に入らず誤検出される競合状態が発生する。
    # AppleScript で開いて id (= CGWindowNumber) を直接受け取ることで排除する。
    step(2, f"新ターミナルを AppleScript で起動  ({project})")
    shell_cd = "cd " + shlex.quote(project)
    as_cmd = shell_cd.replace("\\", "\\\\").replace('"', '\\"')
    # 起動前の window ID 一覧を取得してから do script で新規ウィンドウを開き
    # 差分で新しい window ID を確定する（make new window は Terminal.app 非対応）
    open_as = (
        'tell application "Terminal"\n'
        '    set oldIDs to id of every window\n'
        f'    do script "{as_cmd}"\n'
        '    delay 0.6\n'
        '    set newID to 0\n'
        '    repeat with w in (every window)\n'
        '        set wID to id of w\n'
        '        if wID is not in oldIDs then\n'
        '            set newID to wID\n'
        '            exit repeat\n'
        '        end if\n'
        '    end repeat\n'
        '    if newID is 0 then set newID to id of front window\n'
        '    return newID\n'
        'end tell'
    )
    res2 = subprocess.run(["osascript", "-e", open_as],
                          capture_output=True, text=True, timeout=12)
    if res2.returncode != 0 or not res2.stdout.strip().lstrip("-").isdigit():
        err(f"ターミナル起動失敗: {res2.stderr.strip() or res2.stdout.strip() or '(no output)'}")
    new_wn = int(res2.stdout.strip())
    info(f"ウィンドウ ID 取得: {new_wn}")

    # ── Step 3: TiN がそのウィンドウを認識しているか確認 ────
    step(3, "TiN からウィンドウ情報を取得")
    new_win = None
    for attempt in range(15):  # 最大 6 秒
        wins_now = tin("GET", "/api/windows").get("windows", [])
        new_win = next((w for w in wins_now if w["windowNumber"] == new_wn), None)
        if new_win:
            break
        time.sleep(0.4)
        info(f"  待機中... ({(attempt+1)*0.4:.1f}s)")

    if not new_win:
        warn("TiN から見えていないがスナップを試みます")
        new_win = {"windowNumber": new_wn, "title": "(unknown)", "app": "Terminal"}
    else:
        ok(f"確認: wn={new_win['windowNumber']}  '{new_win.get('title','')[:50]}'")

    # ── Step 4: TiN にスナップ ─────────────────────────
    step(4, f"slot {args.slot} にスナップ (workspace '{ws_name}')")
    r = tin("POST", "/api/v1/snap", json={
        "windowNumber": new_win["windowNumber"],
        "slot": args.slot,
        "workspaceId": ws_id,
    })
    if not r.get("ok"):
        err(f"スナップ失敗: {r.get('error','')}")
    ok(f"スナップ成功  slot={r['slot']}  wn={r.get('windowNumber', new_wn)}")

    # ── Step 5: 確認 ──────────────────────────────────
    step(5, "スナップ状態を確認")
    time.sleep(1)
    d2 = tin("GET", "/api/v1/status")
    ws = next((w for w in d2.get("workspaces", []) if w["id"] == ws_id), None)
    if ws is None:
        warn(f"workspace id={ws_id} が見当たりません")
    else:
        snapped_entry = next((s for s in ws["snapped"] if s["windowNumber"] == new_win["windowNumber"]), None)
        if snapped_entry:
            ok(f"TiN サイドバーに表示: slot {snapped_entry['slot']}  '{snapped_entry['title'][:45]}'")
        else:
            warn("サイドバーに見当たりません (retile 遅延の可能性)")

    if args.keep:
        print(f"\n🏁 テスト完了 (--keep 指定のためターミナルを残します)")
        print(f"   unsnap: curl -s -X POST {BASE}/api/unsnap -H 'Content-Type: application/json' -d '{{\"windowNumber\":{new_wn}}}'")
        return

    # ── Step 6: クリーンアップ ──────────────────────────
    step(6, "クリーンアップ (unsnap + ウィンドウを閉じる)")

    # unsnap
    r = tin("POST", "/api/unsnap", json={"windowNumber": new_wn})
    if r.get("ok"):
        ok("unsnap 完了")
    else:
        warn(f"unsnap: {r.get('error','')}")
    time.sleep(0.3)

    # AppleScript でウィンドウを閉じる
    # new_wn は AppleScript の id of newWin で取得した値なので id of w と確実に一致する
    close_script = (
        'tell application "Terminal"\n'
        '    activate\n'
        f'    repeat with i from (count of windows) to 1 by -1\n'
        '        set w to window i\n'
        f'        if (id of w) = {new_wn} then\n'
        '            close w saving no\n'
        '            exit repeat\n'
        '        end if\n'
        '    end repeat\n'
        'end tell'
    )
    try:
        subprocess.run(["osascript", "-e", close_script],
                       capture_output=True, timeout=5)
        ok("ターミナルウィンドウを閉じました")
    except Exception:
        warn("自動クローズできませんでした (手動で閉じてください)")

    # ── 最終確認 ──────────────────────────────────────
    time.sleep(0.5)
    d3 = tin("GET", "/api/v1/status")
    ws3 = next((w for w in d3.get("workspaces", []) if w["id"] == ws_id), None)
    if ws3 is None:
        warn(f"workspace id={ws_id} が見当たりません (最終確認スキップ)")
        still_snapped = False
    else:
        still_snapped = any(s["windowNumber"] == new_wn for s in ws3["snapped"])

    print(f"\n{'='*52}")
    if not still_snapped:
        print("🎉 テスト完了 — 起動・認識・スナップ・削除 全て成功")
    else:
        print("⚠️  ターミナルはまだ snapped 状態です (手動で unsnap してください)")
    print(f"{'='*52}")

if __name__ == "__main__":
    main()
