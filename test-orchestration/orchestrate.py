#!/usr/bin/env python3
"""
TiN Orchestration API テスト
使い方: python3 orchestrate.py [--slots N] [--label PREFIX]
  --slots N     : 起動するターミナル数 (5〜10, デフォルト 6)
  --label PREFIX: 各ウィンドウのラベルプレフィックス (デフォルト "Agent")
"""
import argparse, math, time, subprocess, sys, json
try:
    import requests
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "requests"])
    import requests

BASE = "http://127.0.0.1:37123"

def tin(method, path, **kwargs):
    try:
        r = requests.request(method, BASE + path, timeout=5, **kwargs)
        return r.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}

def check_api():
    d = tin("GET", "/api/v1/status")
    if not d.get("ok"):
        print("❌ TiN API に接続できません")
        print("   Preferences > Developer > Orchestration API を有効化してください")
        sys.exit(1)
    ws = d["workspaces"][0]
    print(f"✅ TiN 接続 OK  workspace={ws['name']}  grid={ws['grid']['cols']}x{ws['grid']['rows']}")
    return d

def best_grid(n):
    """n スロットに最適なグリッド (cols, rows) を計算"""
    cols = math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    return cols, rows

def launch_terminals(slots, label):
    cols, rows = best_grid(slots)
    print(f"\n📐 グリッド設定: {cols}×{rows} ({slots} スロット)")

    r = tin("POST", "/api/v1/layout", json={"cols": cols, "rows": rows})
    if not r.get("ok"):
        print(f"❌ layout 設定失敗: {r}")
        sys.exit(1)
    print(f"   → {r['cols']}×{r['rows']} に変更しました")
    time.sleep(0.5)

    print(f"\n🚀 {slots} ターミナルを起動します...")
    for i in range(slots):
        slot_label = f"{label}-{i}"
        cmd = f"""osascript -e 'tell application "iTerm2"
            set w to (create window with default profile)
            tell current session of w
                write text "echo \\"{slot_label} — TiN Orchestration Test\\"; bash"
            end tell
        end tell'"""

        r = tin("POST", "/api/v1/launch", json={
            "cmd": cmd,
            "slot": i,
            "timeoutMs": 9000,
        })
        status = "✅" if r.get("ok") else "⚠️ "
        print(f"   {status} slot {i:2d} — {slot_label}  (pid={r.get('pid','?')})")
        time.sleep(1.8)

    print("\n⏳ 配置確定を待機中...")
    time.sleep(2)

    d = tin("GET", "/api/v1/status")
    ws = d["workspaces"][0]
    snapped = ws["snapped"]
    print(f"\n📊 結果: {len(snapped)}/{slots} スロットにスナップ済み")
    for s in sorted(snapped, key=lambda x: x["slot"]):
        print(f"   slot {s['slot']:2d}: {s['app']:12s}  {s['title'][:45]}")

    if len(snapped) == slots:
        print(f"\n🎉 完璧！ {slots} ターミナルが TiN に配置されました")
    else:
        miss = slots - len(snapped)
        print(f"\n⚠️  {miss} ウィンドウが未配置（ウィンドウ表示が遅れた可能性があります）")
        print("   test-snap-existing.sh で残りを手動スナップできます")

def main():
    parser = argparse.ArgumentParser(description="TiN Orchestration テスト")
    parser.add_argument("--slots", type=int, default=6,
                        help="ターミナル数 (5〜10, デフォルト 6)")
    parser.add_argument("--label", type=str, default="Agent",
                        help="ラベルプレフィックス (デフォルト Agent)")
    args = parser.parse_args()

    n = max(5, min(10, args.slots))
    if n != args.slots:
        print(f"⚠️  slots を {n} に丸めました (5〜10)")

    print("=" * 50)
    print(" TiN Orchestration API テスト")
    print("=" * 50)

    check_api()
    launch_terminals(n, args.label)

if __name__ == "__main__":
    main()
