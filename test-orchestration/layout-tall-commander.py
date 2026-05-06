#!/usr/bin/env python3
"""
レイアウト A: 縦長指示台 + 右グリッド

┌──────────┬────┬────┐
│          │ 1  │ 2  │
│  指示台  ├────┼────┤
│  (tall)  │ 3  │ 4  │
│          ├────┼────┤
│          │ 5  │ 6  │
└──────────┴────┴────┘

使い方:
  python3 layout-tall-commander.py
  python3 layout-tall-commander.py --project ~/myproject --agents 4
  python3 layout-tall-commander.py --keep   # スナップ状態を維持

オプション:
  --project PATH  ターミナルを開くディレクトリ
  --agents  N     右グリッドのターミナル数 2〜6 (デフォルト 4)
  --ws-id   N     ワークスペース ID (デフォルト: 自動選択)
  --keep          クリーンアップしない
"""
import argparse, subprocess, time, shlex, os, sys

try:
    import requests
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "requests"])
    import requests

BASE = "http://127.0.0.1:37123"

def tin(method, path, **kw):
    return requests.request(method, BASE+path, timeout=10, **kw).json()

def open_term(label, project):
    cd = "cd " + shlex.quote(project)
    cmd = f"{cd} && echo '[{label}]'"
    as_cmd = cmd.replace("\\","\\\\").replace('"','\\"')
    script = (
        'tell application "Terminal"\n'
        '    set oldIDs to id of every window\n'
        f'    do script "{as_cmd}"\n'
        '    delay 0.6\n'
        '    set newID to 0\n'
        '    repeat with w in every window\n'
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
    r = subprocess.run(["osascript","-e",script], capture_output=True, text=True, timeout=12)
    return int(r.stdout.strip()) if r.returncode==0 and r.stdout.strip().lstrip("-").isdigit() else None

def snap(wn, slot, ws_id):
    return tin("POST","/api/v1/snap",json={"windowNumber":wn,"slot":slot,"workspaceId":ws_id})

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--project", default=os.getcwd())
    p.add_argument("--agents",  type=int, default=4)
    p.add_argument("--ws-id",   type=int, default=None)
    p.add_argument("--keep",    action="store_true")
    args = p.parse_args()

    project = os.path.expanduser(args.project)
    n_agents = max(2, min(6, args.agents))

    # cols=3 固定、rows はエージェント数から決定
    import math
    rows = math.ceil(n_agents / 2)
    cols = 3

    print("=" * 54)
    print("  縦長指示台 + 右グリッド レイアウト")
    print(f"  指示台 × 1  +  エージェント × {n_agents}  ({cols}×{rows})")
    print("=" * 54)

    # API 確認
    d = tin("GET","/api/v1/status")
    if not d.get("ok"):
        print("❌ TiN API に接続できません"); sys.exit(1)

    ws_id = args.ws_id or sorted(d["workspaces"], key=lambda w: len(w["snapped"]))[0]["id"]
    ws_name = next(w["name"] for w in d["workspaces"] if w["id"]==ws_id)
    print(f"\n対象 workspace: '{ws_name}' (id={ws_id})")

    # レイアウト設定
    # 左列 (col=0) を rowSpan=rows で縦全幅に結合
    # 右 2列 × rows 行 = エージェント席
    print(f"\n📐 レイアウト設定: {cols}×{rows}  左列縦結合")
    r = tin("POST","/api/v1/layout", json={
        "cols": cols, "rows": rows,
        "workspaceId": ws_id,
        "merges": [{"col":0, "row":0, "colSpan":1, "rowSpan":rows}]
    })
    print(f"   → {r.get('cols')}×{r.get('rows')}  cells={len(r.get('slotLayout') or [])}")
    time.sleep(0.4)

    # スロット ID を計算
    # 左列結合: id = 0*cols+0 = 0
    # 右側セル: col=1,2 の各行
    right_slots = []
    for row in range(rows):
        for col in [1, 2]:
            right_slots.append(row * cols + col)

    snapped_wns = []

    # 指示台 (slot 0)
    print(f"\n🖥  [Commander] 指示台を起動...")
    wn = open_term("Commander", project)
    if wn:
        r = snap(wn, 0, ws_id)
        mark = "✅" if r.get("ok") else "⚠️ "
        print(f"   {mark} slot 0 (縦長)  wn={wn}")
        if r.get("ok"): snapped_wns.append(wn)
    time.sleep(1.2)

    # エージェント
    agent_labels = [f"Agent-{chr(65+i)}" for i in range(n_agents)]
    for i, (slot, label) in enumerate(zip(right_slots[:n_agents], agent_labels)):
        print(f"\n⚙️  [{label}] 起動...")
        wn = open_term(label, project)
        if wn:
            r = snap(wn, slot, ws_id)
            mark = "✅" if r.get("ok") else "⚠️ "
            print(f"   {mark} slot {slot}  wn={wn}")
            if r.get("ok"): snapped_wns.append(wn)
        time.sleep(1.5)

    # 結果
    time.sleep(1)
    d2 = tin("GET","/api/v1/status")
    ws = next(w for w in d2["workspaces"] if w["id"]==ws_id)
    total = 1 + n_agents
    print(f"\n{'='*54}")
    print(f"📊 {len(ws['snapped'])}/{total} スナップ済み")
    for s in sorted(ws["snapped"], key=lambda x: x["slot"]):
        role = "Commander" if s["slot"]==0 else f"Agent slot-{s['slot']}"
        print(f"   slot {s['slot']:2d} ({role}): {s['title'][:40]}")

    if args.keep:
        print(f"\n🏁 配置完了。TiN の '{ws_name}' を確認してください。")
        print(f"   クリーンアップ: python3 cleanup-ws.py --ws-id {ws_id}")
        return

    # クリーンアップ
    print(f"\n🧹 クリーンアップ...")
    for wn in snapped_wns:
        tin("POST","/api/unsnap",json={"windowNumber":wn})
        time.sleep(0.1)
    ids = ", ".join(str(w) for w in snapped_wns)
    subprocess.run(["osascript","-e",
        f'tell application "Terminal"\n'
        f'  repeat with w in every window\n'
        f'    if (id of w) is in {{{ids}}} then close w\n'
        f'  end repeat\n'
        f'end tell'], capture_output=True, timeout=8)
    print(f"   ✅ 完了")

if __name__ == "__main__":
    main()
