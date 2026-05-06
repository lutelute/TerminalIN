#!/usr/bin/env python3
"""
指定した workspace の全スナップを解除してターミナルを閉じる

使い方:
  python3 cleanup-ws.py              # 全 workspace クリーンアップ
  python3 cleanup-ws.py --ws-id 1   # 特定 workspace のみ
  python3 cleanup-ws.py --unsnap-only  # 閉じずに unsnap だけ
"""
import argparse, subprocess, time, sys

try:
    import requests
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "requests"])
    import requests

BASE = "http://127.0.0.1:37123"

def tin(method, path, **kw):
    return requests.request(method, BASE+path, timeout=10, **kw).json()

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--ws-id",       type=int, default=None, help="対象 workspace ID (省略=全て)")
    p.add_argument("--unsnap-only", action="store_true",    help="ウィンドウを閉じない")
    args = p.parse_args()

    d = tin("GET", "/api/v1/status")
    if not d.get("ok"):
        print("❌ TiN API に接続できません"); sys.exit(1)

    targets = [w for w in d["workspaces"]
               if args.ws_id is None or w["id"] == args.ws_id]

    all_wns = []
    for ws in targets:
        wns = [s["windowNumber"] for s in ws["snapped"]]
        if not wns:
            print(f"ws {ws['id']} '{ws['name']}': スナップなし")
            continue
        print(f"ws {ws['id']} '{ws['name']}': {len(wns)} 件を解除...")
        for wn in wns:
            r = tin("POST", "/api/unsnap", json={"windowNumber": wn})
            print(f"  {'✅' if r.get('ok') else '⚠️ '} wn={wn}")
            time.sleep(0.1)
        all_wns.extend(wns)

    if not args.unsnap_only and all_wns:
        # 逆順ループ + saving no で確認ダイアログをスキップして確実に閉じる
        ids = ", ".join(str(w) for w in all_wns)
        subprocess.run(["osascript", "-e",
            f'tell application "Terminal"\n'
            f'  activate\n'
            f'  repeat with i from (count of windows) to 1 by -1\n'
            f'    set w to window i\n'
            f'    if (id of w) is in {{{ids}}} then\n'
            f'      close w saving no\n'
            f'    end if\n'
            f'  end repeat\n'
            f'end tell'], capture_output=True, timeout=15)
        print(f"\n✅ {len(all_wns)} ターミナルを閉じました")
    elif all_wns:
        print(f"\n✅ {len(all_wns)} 件を unsnap しました (ウィンドウは残っています)")

if __name__ == "__main__":
    main()
