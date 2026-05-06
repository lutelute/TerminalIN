#!/usr/bin/env python3
"""
TiN Orchestration API デモスクリプト (汎用)

使い方:
  python3 orchestrate.py --project /path/to/project
  python3 orchestrate.py --slots 8 --label "Agent" --project ~/myproject
  python3 orchestrate.py --snap-only          # 起動せず既存ウィンドウを並べる
  python3 orchestrate.py --workspace-name "My Session"

オプション:
  --project PATH      各ターミナルを開くディレクトリ (デフォルト: カレント)
  --slots N           ターミナル数 5〜10 (デフォルト: 6)
  --label PREFIX      ターミナルラベルのプレフィックス (デフォルト: Agent)
  --merge-top         上段を横全幅に結合してオーケストレーター席にする
  --workspace-name    新規 TiN ワークスペース名 (デフォルト: Orchestration)
  --workspace-id N    既存ワークスペース ID を使う (新規作成しない)
  --snap-only         ターミナルを起動せず、既存の未スナップウィンドウを並べる
  --api               TiN API の URL (デフォルト: http://127.0.0.1:37123)
"""
import argparse, math, time, os, sys

try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "requests"])
    import requests

def parse_args():
    p = argparse.ArgumentParser(description="TiN Orchestration デモ")
    p.add_argument("--project", default=os.getcwd(), help="ターミナルを開くディレクトリ")
    p.add_argument("--slots", type=int, default=6, help="ターミナル数 (5〜10)")
    p.add_argument("--label", default="Agent", help="ラベルプレフィックス")
    p.add_argument("--merge-top", action="store_true", help="上段を横全幅に結合")
    p.add_argument("--workspace-name", default="Orchestration", help="新規ワークスペース名")
    p.add_argument("--workspace-id", type=int, default=None, help="既存ワークスペース ID")
    p.add_argument("--snap-only", action="store_true", help="既存ウィンドウを並べるだけ")
    p.add_argument("--api", default="http://127.0.0.1:37123", help="TiN API URL")
    return p.parse_args()

def tin(base, method, path, **kw):
    try:
        return requests.request(method, base+path, timeout=12, **kw).json()
    except Exception as e:
        return {"ok": False, "error": str(e)}

def best_grid(n, merge_top=False):
    """n スロットに最適なグリッドを計算"""
    if merge_top:
        # 上段1行 + 下段 n-1 列
        cols = n - 1
        return cols, 2
    cols = math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    return cols, rows

def build_merges(cols, rows, merge_top):
    if not merge_top:
        return []
    return [{"col": 0, "row": 0, "colSpan": cols, "rowSpan": 1}]

def get_slot_ids(cols, rows, merge_top):
    """実際に使うスロット ID のリスト"""
    if not merge_top:
        return list(range(cols * rows))
    # 上段 = id 0 (全幅結合), 下段 = ids [cols, cols+1, ...]
    return [0] + list(range(cols, cols + cols))

def check_api(base):
    d = tin(base, "GET", "/api/v1/status")
    if not d.get("ok"):
        print("❌ TiN API に接続できません")
        print(f"   URL: {base}")
        print("   Preferences > Developer > Orchestration API を有効化してください")
        sys.exit(1)
    ws_names = [w["name"] for w in d["workspaces"]]
    print(f"✅ TiN 接続 OK  workspaces={ws_names}")
    return d

def get_or_create_workspace(base, args, status):
    if args.workspace_id:
        ws = next((w for w in status["workspaces"] if w["id"] == args.workspace_id), None)
        if not ws:
            print(f"❌ workspace id={args.workspace_id} が見つかりません")
            sys.exit(1)
        print(f"   既存ワークスペース使用: {ws['name']} (id={ws['id']})")
        return ws["id"]
    r = tin(base, "POST", "/api/v1/workspace/new", json={"name": args.workspace_name})
    if r.get("ok"):
        print(f"✅ 新規ワークスペース: {r['name']} (id={r['id']})")
        time.sleep(0.8)
        return r["id"]
    print(f"⚠️  workspace 作成失敗 ({r.get('error')})、最初の ws を使用")
    return status["workspaces"][0]["id"]

def snap_existing(base, ws_id, slot_ids):
    """既存の未スナップターミナルを並べる"""
    status = tin(base, "GET", "/api/v1/status")
    snapped_wns = {s["windowNumber"] for w in status["workspaces"] for s in w["snapped"]}
    wins = tin(base, "GET", "/api/windows").get("windows", [])
    free = [w for w in wins
            if w["windowNumber"] not in snapped_wns
            and any(t in w.get("app", "") for t in ("ターミナル", "Terminal", "iTerm", "Warp", "Alacritty"))]
    if not free:
        print("⚠️  未スナップのターミナルが見つかりません")
        return 0
    count = 0
    for slot, w in zip(slot_ids, free):
        r = tin(base, "POST", "/api/v1/snap", json={
            "windowNumber": w["windowNumber"], "slot": slot, "workspaceId": ws_id
        })
        mark = "✅" if r.get("ok") else "⚠️ "
        print(f"  {mark} slot {slot}: {w.get('title','')[:50]}")
        if r.get("ok"): count += 1
        time.sleep(0.25)
    return count

def launch_and_snap(base, ws_id, slot_ids, labels, project, label_prefix):
    count = 0
    for slot, label in zip(slot_ids, labels):
        cmd = (f'osascript -e \'tell application "Terminal" to do script '
               f'"cd {project} && echo \'\\\'\'[{label}] 起動完了\'\\\'\' && exec zsh"\'')
        r = tin(base, "POST", "/api/v1/launch", json={
            "cmd": cmd, "slot": slot, "workspaceId": ws_id,
            "cwd": project, "timeoutMs": 10000,
        })
        mark = "✅" if r.get("ok") else "⚠️ "
        print(f"  {mark} slot {slot:2d} — {label}")
        if r.get("ok"): count += 1
        time.sleep(2.0)
    return count

def print_result(base, ws_id, total):
    time.sleep(2)
    d = tin(base, "GET", "/api/v1/status")
    ws = next((w for w in d["workspaces"] if w["id"] == ws_id), None)
    if not ws:
        return
    snapped = ws["snapped"]
    print(f"\n📊 結果: {len(snapped)}/{total} スナップ済み")
    for s in sorted(snapped, key=lambda x: x["slot"]):
        print(f"   slot {s['slot']:2d}: {s['app']:12s}  {s['title'][:50]}")
    if len(snapped) >= total:
        print(f"\n🎉 完了！ TiN の '{ws['name']}' ワークスペースを確認してください")
    else:
        miss = total - len(snapped)
        print(f"\n⚠️  {miss} 件未配置")
        print("   python3 orchestrate.py --snap-only --workspace-id", ws_id)

def main():
    args = parse_args()
    n = max(5, min(10, args.slots))
    project = os.path.expanduser(args.project)

    print("=" * 55)
    print(" TiN Orchestration API デモ")
    print("=" * 55)
    print(f"  project : {project}")
    print(f"  slots   : {n}")
    print(f"  merge-top: {args.merge_top}")

    status = check_api(args.api)

    # ワークスペース確保
    print(f"\n🪟 ワークスペース設定...")
    ws_id = get_or_create_workspace(args.api, args, status)

    # グリッドレイアウト
    cols, rows = best_grid(n, args.merge_top)
    merges = build_merges(cols, rows, args.merge_top)
    slot_ids = get_slot_ids(cols, rows, args.merge_top)[:n]
    labels = [f"{args.label}-{i}" if i > 0 or not args.merge_top else "Orchestrator"
              for i in range(n)]

    print(f"\n📐 グリッド設定: {cols}×{rows}", "(上段結合)" if args.merge_top else "")
    r = tin(args.api, "POST", "/api/v1/layout", json={
        "cols": cols, "rows": rows,
        "merges": merges if merges else None,
        "workspaceId": ws_id,
    })
    print(f"   → {r.get('cols')}×{r.get('rows')}  slotLayout={'あり' if r.get('slotLayout') else 'なし'}")
    time.sleep(0.5)

    if args.snap_only:
        print(f"\n📌 既存ウィンドウを並べます...")
        count = snap_existing(args.api, ws_id, slot_ids)
        print_result(args.api, ws_id, min(count, n))
    else:
        print(f"\n🚀 {n} ターミナルを {project} から起動...")
        launch_and_snap(args.api, ws_id, slot_ids, labels, project, args.label)
        # 未スナップ分を既存ウィンドウで補完
        d = tin(args.api, "GET", "/api/v1/status")
        ws_now = next(w for w in d["workspaces"] if w["id"] == ws_id)
        missing_slots = [s for s in slot_ids if not any(sn["slot"] == s for sn in ws_now["snapped"])]
        if missing_slots:
            print(f"\n📌 {len(missing_slots)} スロット未配置 → 既存ウィンドウで補完...")
            snap_existing(args.api, ws_id, missing_slots)
        print_result(args.api, ws_id, n)

if __name__ == "__main__":
    main()
