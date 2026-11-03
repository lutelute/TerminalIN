'use strict';
// TiN ごと、スナップした端末を別のデスクトップ (macOS の Space) へ運ぶ。
//
// なぜ「運ぶ」のか (2026-11-03, macOS 26.7.2 で実測):
//   他アプリの窓を Space 間で動かす private API は全部塞がれている —
//   SLSMoveWindowsToManagedSpace / 互換 ID の回避策 (yabai が SA 無しで使う手) /
//   SLSAddWindowsToSpaces+Remove のどれも効かず、yabai `window --space` は exit 0 の偽成功。
//   最小化→切替→最小化解除も元のデスクトップに戻る。他アプリの窓に sticky も付けられない。
//   動くのは人の操作の再現だけ: 「タイトルバーを掴んだまま、デスクトップ切替のショートカットを押す」。
//   TiN 自身の窓 (本体・内蔵端末) は自プロセスなので SLS で画面を切り替えずに送れる。
//
// 手順 (外部の端末 1 枚ごと):
//   元のデスクトップに居る → 端末を最前面へ → 掴む点の最前面が本当にその端末か確かめる →
//   押す・少し動かす → 切替キー → 行き先に着いたのを待つ → 離す → 窓の Space を確かめる →
//   (次の窓があれば) 元のデスクトップへ戻る。
//   全部終えたら TiN 本体と内蔵端末を送り、行き先に居ることを確かめる。

// spaces: [{ id, index, type, display, isCurrent }] (getSpacesList、全ディスプレイ)
// 戻り値: { ok, source, target, steps, path } / { ok:false, reason }
//   path は source から target までに通る Space ID (両端を含む)。
//   切替キーは隣へ 1 つずつしか動けず、途中のフルスクリーンも 1 つと数える。
//   行き先にフルスクリーン (type 4) は選べない (窓を運び込めない)。端は折り返さない。
function planCarry(spaces, activeId, { direction, targetSpaceId } = {}) {
  const list0 = Array.isArray(spaces) ? spaces : [];
  const cur = list0.find(s => Number(s.id) === Number(activeId));
  if (!cur) return { ok: false, reason: 'no-active-space' };
  const list = list0.filter(s => s.display === cur.display);
  const i = list.indexOf(cur);
  let j = -1;
  if (targetSpaceId != null) {
    j = list.findIndex(s => Number(s.id) === Number(targetSpaceId));
    if (j < 0) return { ok: false, reason: list0.some(s => Number(s.id) === Number(targetSpaceId)) ? 'other-display' : 'no-target' };
    if (j === i) return { ok: false, reason: 'same-space' };
    if (Number(list[j].type) !== 0) return { ok: false, reason: 'fullscreen-target' };
  } else {
    const d = Math.sign(Number(direction) || 0);
    if (!d) return { ok: false, reason: 'no-direction' };
    for (let k = i + d; k >= 0 && k < list.length; k += d) {
      if (Number(list[k].type) === 0) { j = k; break; }
    }
    if (j < 0) return { ok: false, reason: 'edge' };
  }
  const step = j > i ? 1 : -1;
  const path = [];
  for (let k = i; k !== j + step; k += step) path.push(Number(list[k].id));
  // barIndex / barCount: Mission Control のスペースバーでの行き先の位置と並びの数 (同じ画面、フルスクリーンも含む)
  return { ok: true, source: Number(cur.id), target: Number(list[j].id), steps: j - i, path, barIndex: j, barCount: list.length };
}

// ── Mission Control でまとめて運ぶ ──
// Mission Control を 1 回開き、端末の縮小表示を 1 枚ずつスペースバーの行き先へ合成ドラッグで落とす。
// 画面は切り替わらない (切替キーで運ぶ方式は 1 枚ごとに元のデスクトップと行き来する)。
// 縮小表示は題名でしか見分けられないので、掴む点は「その点に重なる縮小表示が全部、運ぶ端末」の所に限る。
// こうすると重なりの手前がどれでも運ぶ端末のどれかを掴むことになり、関係ない窓を動かさない。
// 同じ題名の窓が運ぶ端末より多い題名 (関係ない窓と同名) は運ぶ端末と見なさない (切替キーの方式に回す)。

const inRect = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

// 縮小表示と窓を見比べるための題名。端末の題名は動いている間ずっと変わる:
//   claude の印 (◐◓◑◒ ✳ ✶ ⠂ …) が回り、前面の処理名も「— node ◂」「— caffeinate ◂」と入れ替わる。
// その部分を除いて比べる。除いた結果が同じになる窓どうしは見分けられない窓として扱う (安全側)。
function mcTitleKey(t) {
  return String(t || '')
    .replace(/[\u2800-\u28FF\u25D0-\u25D3\u2722-\u273D\u00B7\u2219\u22C5]/g, '')
    .replace(/—[^—◂]*◂/g, '—◂')
    .replace(/\s+/g, ' ')
    .trim();
}

// 縮小表示の中で掴む点の候補。真ん中から外へ向かう順 (細く覗いているだけの縁も拾えるよう細かく)
function mcGrabPoints(t) {
  const pts = [];
  const N = 12;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const fx = i / N, fy = j / N;
    pts.push({ x: Math.round(t.x + 2 + (t.w - 4) * fx), y: Math.round(t.y + 2 + (t.h - 4) * fy), d: (fx - 0.5) ** 2 + (fy - 0.5) ** 2 });
  }
  return pts.sort((a, b) => a.d - b.d);
}

// thumbs: mcSnapshot の windows (手前から奥)。ours: [{ wn, title }] (title は今の題名)
// hitOK(x, y): その点の最前面が Mission Control (Dock) か (KeyCastr などの浮いた窓を避ける)
// 戻り値: { thumb, x, y } / null
// 運ぶ端末と見なす縮小表示の集合 (題名で照合。同名の窓が運ぶ端末より多い題名は含めない)
function oursThumbs(thumbs, ours) {
  const ourCount = new Map(), thumbCount = new Map();
  for (const e of ours) { const k = mcTitleKey(e.title); if (k) ourCount.set(k, (ourCount.get(k) || 0) + 1); }
  const keyed = thumbs.map(t => ({ t, k: mcTitleKey(t.title) }));
  for (const { k } of keyed) thumbCount.set(k, (thumbCount.get(k) || 0) + 1);
  return new Set(keyed.filter(({ k }) => !!k && (ourCount.get(k) || 0) >= (thumbCount.get(k) || 0)).map(({ t }) => t));
}

// 縮小表示を重なりでまとめる。「アプリごとにまとめる」設定では同じアプリの窓が 1 つの山になり、
// 山の下端の真ん中にアプリのアイコンが出る。このアイコンを掴んで落とすと、山の窓が全部いっしょに移る
// (2026-11-03 実機。最初の 1 回は偶然ここを掴んで 4 枚が一斉に移った)。
function mcClusters(thumbs) {
  const parent = thumbs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (let i = 0; i < thumbs.length; i++) for (let j = i + 1; j < thumbs.length; j++) {
    if (overlap(thumbs[i], thumbs[j])) parent[find(i)] = find(j);
  }
  const groups = new Map();
  thumbs.forEach((t, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); });
  return [...groups.values()];
}
// 山のアイコンの中心 (実測: 外接矩形の下端の真ん中から 5〜6pt 上) と、その周り (掴むと山ごと動く範囲)
function mcIconPoint(cluster) {
  const x0 = Math.min(...cluster.map(t => t.x)), x1 = Math.max(...cluster.map(t => t.x + t.w));
  const y1 = Math.max(...cluster.map(t => t.y + t.h));
  return { x: Math.round((x0 + x1) / 2), y: Math.round(y1 - 6) };
}
const MC_ICON_HALF = 26;
const inIconZone = (p, x, y) => Math.abs(x - p.x) <= MC_ICON_HALF && Math.abs(y - p.y) <= MC_ICON_HALF;

// 1 枚ずつ掴む点。アイコンの周りは避ける (関係ない窓も入った山ごと動かしてしまう)
function chooseMcGrab(thumbs, ours, hitOK = () => true) {
  const ours_ = oursThumbs(thumbs, ours);
  const icons = mcClusters(thumbs).map(mcIconPoint);
  for (const t of thumbs) {
    if (!ours_.has(t) || !(t.w > 8) || !(t.h > 8)) continue;
    for (const { x, y } of mcGrabPoints(t)) {
      if (thumbs.some(o => o !== t && !ours_.has(o) && inRect(o, x, y))) continue;
      if (icons.some(p => inIconZone(p, x, y))) continue;
      if (!hitOK(x, y)) continue;
      return { thumb: t, x, y };
    }
  }
  return null;
}

// 山ごと運ぶ: 縮小表示が全部運ぶ端末の山で、その窓のアプリの「今見えている窓」が全部運ぶ端末のとき
// (safeApps) だけ、山のアイコンを掴む点を返す。大きい山から。戻り値: { x, y, size } / null
// ours: [{ wn, title, app }]
function chooseMcGroupGrab(thumbs, ours, safeApps, hitOK = () => true, skipKeys = new Set()) {
  if (!safeApps || !safeApps.size) return null;
  const ours_ = oursThumbs(thumbs, ours);
  const appsOfKey = new Map();
  for (const e of ours) {
    const k = mcTitleKey(e.title);
    if (!appsOfKey.has(k)) appsOfKey.set(k, new Set());
    appsOfKey.get(k).add(e.app || '');
  }
  const clusters = mcClusters(thumbs)
    .filter(c => c.every(t => ours_.has(t)))
    .filter(c => c.every(t => [...(appsOfKey.get(mcTitleKey(t.title)) || [''])].every(a => safeApps.has(a))))
    .sort((a, b) => b.length - a.length);
  for (const c of clusters) {
    const key = c.map(t => mcTitleKey(t.title)).sort().join('\n');
    if (skipKeys.has(key)) continue;
    const p = mcIconPoint(c);
    if (thumbs.some(o => !c.includes(o) && inRect(o, p.x, p.y))) continue;   // 別の山の縮小表示がアイコンに被っている
    if (!hitOK(p.x, p.y)) continue;
    return { x: p.x, y: p.y, size: c.length, title: c[0].title, key };
  }
  return null;
}

// snapshot (mcSnapshot の戻り値) から運ぶ画面を選ぶ。1 画面ならそれ、複数なら frame が合うもの、
// それも無ければスペースバーの数が合うもの。
function pickMcDisplay(snapshot, displayFrame, barCount) {
  if (!Array.isArray(snapshot) || !snapshot.length) return null;
  if (snapshot.length === 1) return snapshot[0];
  if (displayFrame) {
    const d = snapshot.find(s => Math.abs(s.x - displayFrame.x) < 4 && Math.abs(s.y - displayFrame.y) < 4
      && Math.abs(s.w - displayFrame.width) < 4 && Math.abs(s.h - displayFrame.height) < 4);
    if (d) return d;
  }
  const byCount = snapshot.filter(s => (s.spaces || []).length === barCount);
  return byCount.length === 1 ? byCount[0] : null;
}

// deps: { ax: { mcToggle, mcSnapshot, mcPressSpace, postMouse, getSpaceForWindows, hitTestPoint },
//         sleep, log, liveTitles() → Map(wn → 今の題名), onProgress? }
// job: { plan (barIndex/barCount 付き), externals: [{ wn, title, app }], displayFrame?, beforePress?() }
// すべて運べたら beforePress() のあと行き先のデスクトップを押して Mission Control を閉じる (= 行き先へ切り替わる)。
// 残りがあれば Mission Control を閉じて元のデスクトップに留まる (残りは呼び手が切替キーの方式で運ぶ)。
// 戻り値: { used, moved: [wn], rest: [external], pressed }
async function carryViaMissionControl(deps, job) {
  const { ax, sleep, log = () => {}, onProgress = () => {}, liveTitles = () => new Map() } = deps;
  const { plan, externals = [], displayFrame = null, beforePress = null } = job;
  const out = { used: false, moved: [], rest: [...externals], pressed: false, strays: [] };
  if (!ax.mcToggle || !ax.mcSnapshot || !ax.mcPressSpace || plan.barIndex == null) return out;
  const spaceOf = (wn) => Number((ax.getSpaceForWindows([wn])[0] || {}).spaceId || 0);
  const remaining = new Map();
  for (const e of externals) {
    if (spaceOf(e.wn) === plan.target) out.moved.push(e.wn);
    else remaining.set(e.wn, e);
  }
  out.rest = [...remaining.values()];
  if (!remaining.size) return out;
  // 開いたまま残っている Mission Control (前の運搬の名残など) は閉じてから始める。
  // 利用者が開いている間は呼び手 (main の追従) が閉じるのを待ってから呼ぶ。
  if (ax.mcSnapshot()) {
    // デスクトップを切り替えた直後は Dock が一瞬 Mission Control の要素を出すことがある。まず消えるのを待つ
    const tw = Date.now();
    while (ax.mcSnapshot() && Date.now() - tw < 800) await sleep(40);
  }
  if (ax.mcSnapshot()) {
    log('[space-carry/mc] Mission Control was open — close first');
    ax.mcToggle();
    const t0 = Date.now();
    while (ax.mcSnapshot() && Date.now() - t0 < 1500) await sleep(40);
    if (ax.mcSnapshot()) { log('[space-carry/mc] could not close Mission Control — skip'); return out; }
    await sleep(300);
  }

  const display = () => pickMcDisplay(ax.mcSnapshot(), displayFrame, plan.barCount);
  const rectsKey = (d) => d ? d.windows.map(w => `${Math.round(w.x)},${Math.round(w.y)},${Math.round(w.w)},${Math.round(w.h)}`).join('|') : '';
  // 開いた直後・落とした直後は並べ替えの動きが続くので、縮小表示の位置が 2 回続けて同じになるまで待つ
  const settled = async (minMs, timeoutMs) => {
    const t0 = Date.now();
    await sleep(minMs);
    let prev = null;
    while (Date.now() - t0 < timeoutMs) {
      const d = display();
      if (d && d.windows.length && prev !== null && rectsKey(d) === prev) return d;
      prev = d ? rectsKey(d) : null;
      await sleep(60);
    }
    return display();
  };
  const dragTo = async (from, to, steps, ms) => {
    for (let i = 1; i <= steps; i++) {
      ax.postMouse('drag', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
      await sleep(ms);
    }
  };
  const hitOK = (x, y) => { const h = ax.hitTestPoint(x, y); return !!h && h.app === 'Dock'; };

  // 山ごと運んでよいアプリ: 元のデスクトップで今見えているそのアプリの窓が、全部運ぶ端末のもの
  // (deps.sourceWindows が無ければ山ごとは使わない)。関係ない窓 (others) が一緒に移っていないかも後で確かめる。
  const extWns = new Set(externals.map(e => e.wn));
  let safeApps = null, others = [];
  if (deps.sourceWindows) {
    try {
      const vis = (deps.sourceWindows() || []).filter(w => w && w.windowNumber);
      const apps = new Set(externals.map(e => e.app).filter(Boolean));
      safeApps = new Set([...apps].filter(a => vis.filter(w => w.app === a).every(w => extWns.has(w.windowNumber))));
      others = vis.filter(w => !extWns.has(w.windowNumber) && !(job.ignoreWns || []).includes(w.windowNumber)).map(w => w.windowNumber);
    } catch (err) { log(`[space-carry/mc] sourceWindows: ${err && err.message}`); }
  }
  out.strays = [];
  const checkStrays = () => {
    if (!others.length) return;
    for (const r of ax.getSpaceForWindows(others)) {
      if (Number(r.spaceId) === plan.target && !out.strays.includes(r.wn)) {
        out.strays.push(r.wn);
        log(`[space-carry/mc] STRAY wn=${r.wn} moved with the carried windows`);
      }
    }
  };

  ax.mcToggle();
  out.used = true;
  // 閉じるまで待つ。行き先を押したあとは自然に閉じるはずだが、落とした窓の動きの途中で押すと
  // 「Mission Control のままそのデスクトップを表示」になることがある (実機) ので、残っていたら閉じる。
  const close = async (graceMs = 0) => {
    const t0 = Date.now();
    while (ax.mcSnapshot() && Date.now() - t0 < graceMs) await sleep(40);
    if (ax.mcSnapshot()) ax.mcToggle();
    const t1 = Date.now();
    while (ax.mcSnapshot() && Date.now() - t1 < 1500) await sleep(40);
    await sleep(250);   // 閉じるアニメーションの間は窓の位置が揺れる
  };
  let pressedAt = 0;
  try {
    let d = await settled(380, 2500);
    if (!d || !d.spaces || !d.spaces[plan.barIndex]) {
      log(`[space-carry/mc] no display/bar (displays=${(ax.mcSnapshot() || []).length})`);
      return out;
    }
    const total = remaining.size;
    let tries = 0;
    const groupFailed = new Set();   // 山ごと掴んで動かなかった山 (以後 1 枚ずつ)
    const failedTitle = new Map();
    while (remaining.size && tries < total * 2 + 2) {
      tries++;
      const titles = liveTitles();
      const ours = [...remaining.values()]
        .map(e => ({ wn: e.wn, title: titles.get(e.wn) || e.title || '', app: e.app || '' }))
        .filter(e => (failedTitle.get(mcTitleKey(e.title)) || 0) < 2);
      // まず山ごと (アイコン)。アプリが複数なら山も複数 (アプリごとに 1 回ずつ)。動かなかった山は以後 1 枚ずつ
      let pick = null;
      const g = chooseMcGroupGrab(d.windows, ours, safeApps, hitOK, groupFailed);
      if (g) pick = { x: g.x, y: g.y, thumb: { title: g.title }, group: g.size, key: g.key };
      if (!pick) pick = chooseMcGrab(d.windows, ours, hitOK);
      if (!pick) { log(`[space-carry/mc] no safe grab point for ${remaining.size} window(s)`); break; }
      onProgress({ done: total - remaining.size, total, title: pick.thumb.title });

      const p = { x: pick.x, y: pick.y };
      ax.postMouse('move', p.x, p.y); await sleep(40);
      ax.postMouse('down', p.x, p.y); await sleep(100);
      let btn = d.spaces[plan.barIndex];
      const lift = { x: btn.x + btn.w / 2, y: 3 };
      await dragTo(p, lift, 6, 12);
      // スペースバーは上端に近づくと広がる。広がったあとの位置へ落とす
      const t0 = Date.now();
      while (Date.now() - t0 < 1200) {
        const nd = display();
        const b = nd && nd.spaces && nd.spaces[plan.barIndex];
        if (b && b.y >= 0 && b.h >= 30) { btn = b; break; }
        await sleep(50);
      }
      const drop = { x: btn.x + btn.w / 2, y: btn.y + btn.h / 2 };
      if (!(btn.y >= 0)) log('[space-carry/mc] space bar did not expand');
      await dragTo(lift, drop, 5, 14);
      await sleep(150);
      ax.postMouse('up', drop.x, drop.y);

      // どれが着いたか (手前の重なりのどれを掴んだかは分からないので、残り全部を見る)
      let got = [];
      const t1 = Date.now();
      while (Date.now() - t1 < 1000) {
        got = [...remaining.keys()].filter(wn => spaceOf(wn) === plan.target);
        if (got.length) break;
        await sleep(50);
      }
      checkStrays();
      if (got.length) {
        for (const wn of got) { remaining.delete(wn); out.moved.push(wn); log(`[space-carry/mc] wn=${wn} OK${pick.group ? ` (group of ${pick.group})` : ''}`); }
      } else if (pick.group) {
        groupFailed.add(pick.key);
        log(`[space-carry/mc] group drop did not move (${pick.group} windows) — one by one`);
      } else {
        const fk = mcTitleKey(pick.thumb.title);
        failedTitle.set(fk, (failedTitle.get(fk) || 0) + 1);
        log(`[space-carry/mc] drop did not move "${String(pick.thumb.title).slice(0, 40)}"`);
      }
      if (!remaining.size) break;
      d = await settled(120, 1500);
      if (!d || !d.spaces || !d.spaces[plan.barIndex]) break;
    }
    out.rest = [...remaining.values()];
    if (!remaining.size) {
      if (beforePress) { try { await beforePress(); } catch (err) { log(`[space-carry/mc] beforePress: ${err && err.message}`); } }
      await settled(250, 1200);   // 最後に落とした窓が行き先へ吸い込まれる動きが終わってから押す
      const snap = ax.mcSnapshot() || [];
      const target = pickMcDisplay(snap, displayFrame, plan.barCount);
      const idx = target ? snap.indexOf(target) : -1;
      if (idx >= 0 && ax.mcPressSpace(idx, plan.barIndex)) {
        out.pressed = true;
        pressedAt = Date.now();
        while (Number(ax.getActiveSpaceId ? ax.getActiveSpaceId() : plan.target) !== plan.target && Date.now() - pressedAt < 2000) await sleep(40);
      }
    }
    return out;
  } finally {
    await close(pressedAt ? 1200 : 0);
  }
}

// 掴む点の候補 (タイトルバー上)。左の信号機ボタン (〜70px) と右端は避ける。
// 狭い窓 (29 桁の端末で 240px 前後) でも 2 点以上は残るようにする。
function grabCandidates(frame) {
  if (!frame || !(frame.width > 0)) return [];
  const y = Math.round(frame.y + 10);
  const minX = frame.x + 78, maxX = frame.x + frame.width - 16;
  const out = [];
  for (const r of [0.85, 0.7, 0.55, 0.4, 0.3]) {
    const x = Math.round(frame.x + frame.width * r);
    if (x >= minX && x <= maxX && !out.some(p => Math.abs(p.x - x) < 8)) out.push({ x, y });
  }
  if (!out.length && maxX >= minX) out.push({ x: Math.round((minX + maxX) / 2), y });
  return out;
}

const REASON_TEXT = {
  'covered': '掴む場所が別の窓に隠れていた',
  'no-frame': '窓の位置が取れなかった',
  'not-on-source': '元のデスクトップに居なかった',
  'not-carried': '掴めなかった (タイトルバーの無い窓など)',
  'switch-timeout': 'デスクトップの切り替えが終わらなかった',
  'lost-source': '元のデスクトップに戻れなかった',
  'mouse-busy': 'マウスのボタンが押されていた',
  'stray': 'TiN に繋いでいない窓が一緒に移ってしまった',
};

// deps: {
//   ax: { getActiveSpaceId, getSpaceForWindows, getWindowBounds, hitTestPoint, raiseWindows,
//         activateApp, postMouse, postHotkey, getCursorPosition, warpCursor,
//         moveWindowsToSpaceId, isMouseButtonDown },
//   sleep(ms), log(msg), onProgress?({ done, total, title })
// }
// job: { plan, hotkeys:{left,right}, externals:[{ wn, pid, app, title, windowIndex }], ownWns:[wid] }
// 戻り値: { ok, target, moved:[wn], failed:[{ wn, title, reason }], tinMoved, endedOn }
async function carryToSpace(deps, job) {
  const { ax, sleep, log = () => {}, onProgress = () => {} } = deps;
  const { plan, hotkeys, externals = [], ownWns = [] } = job;
  const fwd = plan.steps > 0 ? hotkeys.right : hotkeys.left;
  const back = plan.steps > 0 ? hotkeys.left : hotkeys.right;
  const path = plan.path;
  const spaceOf = (wn) => Number((ax.getSpaceForWindows([wn])[0] || {}).spaceId || 0);
  const active = () => Number(ax.getActiveSpaceId());

  const waitActive = async (id, timeoutMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (active() === id) return true;
      await sleep(25);
    }
    return active() === id;
  };
  // path に沿って 1 つずつ切り替える (切替キーは隣へしか動けない)
  const walk = async (toEnd) => {
    const ids = toEnd ? path : [...path].reverse();
    const hk = toEnd ? fwd : back;
    let at = ids.indexOf(active());
    if (at < 0) return false;
    for (let k = at + 1; k < ids.length; k++) {
      ax.postHotkey(hk.keyCode, hk.modifiers);
      if (await waitActive(ids[k], 1500)) continue;
      // 押下が落ちることがある (切替の直後など)。元の所に留まっているときだけ 1 回押し直す。
      // 予定外の所へ動いていたら押し直さない (行き過ぎる)。
      if (active() !== ids[k - 1]) return false;
      log(`[space-carry] hotkey dropped at ${ids[k - 1]} — retry`);
      ax.postHotkey(hk.keyCode, hk.modifiers);
      if (!await waitActive(ids[k], 1500)) return false;
    }
    return true;
  };

  const moved = [], failed = [];
  const cursor = ax.getCursorPosition();
  // TiN 本体と内蔵端末 (自分の窓) は画面を切り替えずに送れる。Mission Control で全部運べたときは
  // 行き先へ切り替える前に送る (着いたときに TiN が先に居るように)。
  let ownDone = false, tinMoved = 0;
  const moveOwn = () => {
    if (ownDone) return;
    ownDone = true;
    if (!ownWns.length) return;
    try { ax.moveWindowsToSpaceId(ownWns, plan.target); } catch (err) { log(`[space-carry] own move failed: ${err && err.message}`); }
    tinMoved = ownWns.filter(w => spaceOf(w) === plan.target).length;
  };
  try {
    // まず Mission Control でまとめて運ぶ (画面を行き来しない)。残りだけ切替キーの方式で 1 枚ずつ運ぶ。
    let list = externals;
    if (job.useMissionControl !== false && ax.mcToggle && externals.length) {
      let atSource = active() === plan.source;
      if (!atSource) { atSource = await walk(false); if (atSource) await sleep(120); }
      if (atSource) {
        const mc = await carryViaMissionControl(
          { ax, sleep, log, onProgress, liveTitles: deps.liveTitles, sourceWindows: deps.sourceWindows },
          { plan, externals, displayFrame: job.displayFrame, beforePress: moveOwn, ignoreWns: ownWns });
        if (mc.used || mc.moved.length) {
          moved.push(...mc.moved);
          list = mc.rest;
          // 一緒に移ってしまった関係ない窓 (起きないはずだが、起きたら知らせる)
          const titles = deps.liveTitles ? deps.liveTitles() : new Map();
          for (const wn of mc.strays || []) failed.push({ wn, title: titles.get(wn) || '', reason: 'stray' });
          log(`[space-carry/mc] moved=${mc.moved.length} rest=${mc.rest.length} pressed=${mc.pressed}`);
        }
      }
    }
    // 切替キーの方式は Mission Control の上では掴めない (Dock の窓が手前に来る)。開いていたら閉じる
    if (list.length && ax.mcSnapshot && ax.mcSnapshot()) {
      ax.mcToggle();
      const t0 = Date.now();
      while (ax.mcSnapshot() && Date.now() - t0 < 1500) await sleep(40);
      await sleep(300);
    }
    for (let n = 0; n < list.length; n++) {
      const e = list[n];
      const fail = (reason, by) => {
        failed.push({ wn: e.wn, title: e.title || e.app || '', reason, ...(by ? { by: by.app || String(by.wn) } : {}) });
        log(`[space-carry] wn=${e.wn} FAIL ${reason}`);
      };
      onProgress({ done: moved.length, total: externals.length, title: e.title || e.app || '' });

      if (active() !== plan.source) {
        if (!await walk(false)) {
          for (const r of list.slice(n)) failed.push({ wn: r.wn, title: r.title || r.app || '', reason: 'lost-source' });
          log('[space-carry] could not return to source — stop');
          break;
        }
        await sleep(120);   // 切替アニメーションの名残で窓の位置が揺れるのを待つ
      }
      const where = spaceOf(e.wn);
      if (where === plan.target) { moved.push(e.wn); continue; }
      if (where !== plan.source) { fail('not-on-source'); continue; }
      if (ax.isMouseButtonDown && ax.isMouseButtonDown()) { fail('mouse-busy'); continue; }

      // 最前面へ。TiN の上部バーや他の端末がタイトルバーに被っていると、そちらを掴んでしまう。
      // デスクトップを切り替えた直後は前面化が遅れて効くことがあるので、被っていたら上げ直して 1 回だけ待つ。
      let p = null, frame = null, blocker = null;
      for (let attempt = 0; attempt < 2 && !p; attempt++) {
        try { ax.raiseWindows([{ windowNumber: e.wn, pid: e.pid, app: e.app, title: e.title || '', windowIndex: e.windowIndex || 0 }]); } catch {}
        try { ax.activateApp(e.pid); } catch {}
        await sleep(attempt ? 350 : 160);
        frame = (ax.getWindowBounds([e.wn]) || [])[0];
        if (!frame) break;
        for (const c of grabCandidates(frame)) {
          const hit = ax.hitTestPoint(c.x, c.y);
          if (hit && Number(hit.wn) === e.wn) { p = c; break; }
          if (!blocker && hit) blocker = hit;
        }
      }
      if (!frame) { fail('no-frame'); continue; }
      if (!p) {
        if (blocker) log(`[space-carry] wn=${e.wn} covered by wn=${blocker.wn} app=${blocker.app || '?'} layer=${blocker.layer}`);
        fail('covered', blocker);
        continue;
      }

      ax.postMouse('move', p.x, p.y); await sleep(40);
      ax.postMouse('down', p.x, p.y); await sleep(90);
      for (let i = 1; i <= 4; i++) { ax.postMouse('drag', p.x + i, p.y); await sleep(18); }
      const arrived = await walk(true);
      await sleep(150);   // 着いた直後に離すと元のデスクトップに置いていかれることがある
      ax.postMouse('up', p.x + 4, p.y); await sleep(80);

      if (spaceOf(e.wn) === plan.target) { moved.push(e.wn); log(`[space-carry] wn=${e.wn} OK`); }
      else fail(arrived ? 'not-carried' : 'switch-timeout');
    }

    moveOwn();
    if (active() !== plan.target) await walk(true);
    onProgress({ done: externals.length, total: externals.length, title: '' });
    return { ok: failed.length === 0 && tinMoved === ownWns.length, target: plan.target, moved, failed, tinMoved, endedOn: active() };
  } finally {
    // 合成マウスで動かしたカーソルを、ボタンを押したときの位置へ戻す
    try { if (cursor) ax.warpCursor(cursor.x, cursor.y); } catch {}
  }
}

module.exports = { planCarry, grabCandidates, carryToSpace, carryViaMissionControl, chooseMcGrab, chooseMcGroupGrab, mcClusters, mcIconPoint, pickMcDisplay, mcTitleKey, REASON_TEXT };
