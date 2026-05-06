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
import argparse, subprocess, time, os, sys, json

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
        # スナップが少ない ws を優先
        ws_id = sorted(d["workspaces"], key=lambda w: len(w["snapped"]))[0]["id"]
    ws_name = next((w["name"] for w in d["workspaces"] if w["id"] == ws_id), "?")
    info(f"対象 workspace: '{ws_name}' (id={ws_id})")

    # ── Step 2: 起動前のウィンドウ番号を記録 ──────────
    step(2, "起動前のウィンドウ一覧を記録")
    wins_before = tin("GET", "/api/windows").get("windows", [])
    before_wns = {w["windowNumber"] for w in wins_before}
    info(f"既存ウィンドウ数: {len(before_wns)}")

    # ── Step 3: 新ターミナルを開く ─────────────────────
    step(3, f"新ターミナルを起動  ({project})")
    # open -na で強制的に新規ウィンドウ
    cmd = f'open -na Terminal "{project}"'
    subprocess.Popen(["/bin/sh", "-c", cmd], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    info("起動コマンド送信完了、ウィンドウ出現を待機...")

    # ── Step 4: 新しいウィンドウを検出 ────────────────
    step(4, "新ターミナルウィンドウを検出")
    new_win = None
    for attempt in range(15):  # 最大 6 秒
        time.sleep(0.4)
        wins_now = tin("GET", "/api/windows").get("windows", [])
        candidates = [
            w for w in wins_now
            if w["windowNumber"] not in before_wns
            and any(t in w.get("app", "") for t in ("ターミナル", "Terminal", "iTerm", "Warp", "Alacritty"))
        ]
        if candidates:
            new_win = candidates[0]
            break
        info(f"  待機中... ({(attempt+1)*0.4:.1f}s)")

    if not new_win:
        err("新ターミナルが検出できませんでした (タイムアウト)")

    ok(f"検出: wn={new_win['windowNumber']}  '{new_win['title'][:50]}'")

    # ── Step 5: TiN にスナップ ─────────────────────────
    step(5, f"slot {args.slot} にスナップ (workspace '{ws_name}')")
    r = tin("POST", "/api/v1/snap", json={
        "windowNumber": new_win["windowNumber"],
        "slot": args.slot,
        "workspaceId": ws_id,
    })
    if not r.get("ok"):
        err(f"スナップ失敗: {r.get('error','')}")
    ok(f"スナップ成功  slot={r['slot']}  wn={r['windowNumber']}")

    # ── Step 6: 確認 ──────────────────────────────────
    step(6, "スナップ状態を確認")
    time.sleep(1)
    d2 = tin("GET", "/api/v1/status")
    ws = next((w for w in d2["workspaces"] if w["id"] == ws_id), None)
    snapped_entry = next((s for s in ws["snapped"] if s["windowNumber"] == new_win["windowNumber"]), None)
    if snapped_entry:
        ok(f"TiN サイドバーに表示: slot {snapped_entry['slot']}  '{snapped_entry['title'][:45]}'")
    else:
        warn("サイドバーに見当たりません (retile 遅延の可能性)")

    if args.keep:
        print(f"\n🏁 テスト完了 (--keep 指定のためターミナルを残します)")
        print(f"   unsnap: curl -s -X POST {BASE}/api/unsnap -H 'Content-Type: application/json' -d '{{\"windowNumber\":{new_win['windowNumber']}}}'")
        return

    # ── Step 7: クリーンアップ ──────────────────────────
    step(7, "クリーンアップ (unsnap + ウィンドウを閉じる)")

    # unsnap
    r = tin("POST", "/api/unsnap", json={"windowNumber": new_win["windowNumber"]})
    if r.get("ok"):
        ok("unsnap 完了")
    else:
        warn(f"unsnap: {r.get('error','')}")
    time.sleep(0.3)

    # ターミナルウィンドウを閉じる
    wn = new_win["windowNumber"]
    close_script = f"""
    tell application "Terminal"
        set wList to every window
        repeat with w in wList
            try
                if (id of w) = {wn} then close w
            end try
        end repeat
    end tell
    """
    try:
        subprocess.run(["osascript", "-e", close_script],
                       capture_output=True, timeout=3)
        ok("ターミナルウィンドウを閉じました")
    except Exception:
        warn("自動クローズできませんでした (手動で閉じてください)")

    # ── 最終確認 ──────────────────────────────────────
    time.sleep(0.5)
    d3 = tin("GET", "/api/v1/status")
    ws3 = next((w for w in d3["workspaces"] if w["id"] == ws_id), None)
    still_snapped = any(s["windowNumber"] == wn for s in ws3["snapped"])

    print(f"\n{'='*52}")
    if not still_snapped:
        print("🎉 テスト完了 — 起動・認識・スナップ・削除 全て成功")
    else:
        print("⚠️  ターミナルはまだ snapped 状態です (手動で unsnap してください)")
    print(f"{'='*52}")

if __name__ == "__main__":
    main()
