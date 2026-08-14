// lib/snap-relink.js — 見失った snap エントリの引き継ぎ先探し (純粋ロジック)
//
// snap した窓の windowNumber は永続 ID ではない。アプリ再起動 / sleep 復帰 / TiN 再起動を
// またぐと変わるので、「windowNumber が live 一覧に無い」エントリは app + title で探し直して
// 繋ぎ直す。ここまでは元からある挙動。
//
// 問題はその探し直しが「まだ生きている、別のエントリが使っている窓」まで候補にしていたこと。
// ターミナルの title は設定と cwd が同じなら完全一致する:
//   ターミナル: shigenoburyuto — shigenoburyuto@Mac — ~ — -zsh — 52×38
// この状態で片方を閉じると、閉じた側のエントリが隣の生きている窓を引き継ぎ先として掴む。
// snappedExternals は windowNumber をキーにした Map なので、掴んだ瞬間に
//   ws.snappedExternals.set(生きている窓, 閉じた窓の info)
// が元エントリを上書きし、
//   - 生きている窓が閉じた窓の slot へ引っ越す (元の slot は空く)
//   - info の title/origX..H は閉じた窓のものなので、閉じたはずの端末が slot に残って見える
//   - unsnap すると閉じた窓の元サイズへ復元される
// という壊れ方をする。「消したはずの端末が snap に残っている」の正体がこれ。
//
// よって候補からは「すでに誰かの snap になっている窓」を必ず外す。誰が snap しているかは
// 呼び出し側 (main.js の _globalSnappedIndex) しか知らないので predicate で受け取る。
// 外した結果マッチが無くなるのは正しい — その窓はもう存在しないのだから、
// 生死判定 (lib/snap-liveness.js) に委ねて ghost → evict の経路へ送るべきエントリ。

// 候補から「他のエントリが既に使っている窓」を落とす。
function freeCandidates(liveWindows, isClaimed) {
  if (!Array.isArray(liveWindows)) return [];
  if (typeof isClaimed !== 'function') return liveWindows;
  return liveWindows.filter(w => w && !isClaimed(w.windowNumber));
}

// title の前方 N 文字。ターミナルは末尾 (行×桁やコマンド名) だけが変わることが多いので、
// 完全一致で外れても前方一致なら拾える。
function titlePrefix(title, n = 40) {
  return title.slice(0, Math.min(n, title.length));
}

// 稼働中の snap エントリ (info) の引き継ぎ先を探す。
// 使うのは app + title だけ — 稼働中は「同じ窓が別 ID になった」ケースしか無く、
// サイズ近似のような緩いルールは誤爆のほうが大きいため。
function findRelinkTarget(info, liveWindows, isClaimed) {
  if (!info || !info.title) return null;
  const free = freeCandidates(liveWindows, isClaimed);
  const exact = free.find(w => w.app === info.app && w.title === info.title);
  if (exact) return exact;
  const prefix = titlePrefix(info.title);
  return free.find(w => w.app === info.app && w.title && w.title.startsWith(prefix)) || null;
}

// 復元対象 (workspaces.json の 1 エントリ) を現在の live list に match させる。
// 優先度: windowNumber → title完全 → title前方40 → titleセクション(唯一時) → サイズ近似(唯一時)
// 下ほど緩いので、緩いルールは「候補が 1 つだけ」のときしか使わない。
// isClaimed で既に他エントリが使っている窓を全段から除外する — windowNumber 一致も例外にしない。
// 同じ windowNumber を指す重複エントリが残っていることがあり、それを通すと
// 後段で黙って捨てられて snap 情報が消えるため。
function matchPersistedToLive(persisted, liveWindows, isClaimed) {
  if (!persisted) return null;
  const free = freeCandidates(liveWindows, isClaimed);
  // 1. windowNumber で厳密一致
  const byNum = free.find(w => w.windowNumber === persisted.windowNumber);
  if (byNum) return byNum;
  // 2. app + title 完全一致
  const byFull = free.find(w => w.app === persisted.app && w.title === persisted.title);
  if (byFull) return byFull;
  // 3. app + title 前方 40 文字一致
  if (persisted.title && persisted.title.length > 0) {
    const prefix = titlePrefix(persisted.title);
    const byPrefix = free.find(w =>
      w.app === persisted.app &&
      w.title && w.title.startsWith(prefix)
    );
    if (byPrefix) return byPrefix;
  }
  // 4. app + タイトルの最初のセクション（em dash / ダッシュ区切り）
  // 誤マッチを防ぐため、同じsection名を持つliveウィンドウが1つだけの場合のみ適用
  // 例: "DevMaze — ✳ ... — 48×31" → "DevMaze" でマッチ
  if (persisted.title) {
    const pSection = persisted.title.split(/\s*[—\-–]\s*/)[0].trim();
    if (pSection.length >= 3) {
      const matches = free.filter(w =>
        w.app === persisted.app &&
        w.title && w.title.split(/\s*[—\-–]\s*/)[0].trim() === pSection
      );
      if (matches.length === 1) return matches[0];
    }
  }
  // 5. app + サイズ近似（±30px）: 同じ設定で起動したターミナルは同サイズになることが多い
  // 誤マッチを防ぐため、このappのliveウィンドウが1つだけの場合のみ適用
  if (persisted.origW > 0 && persisted.origH > 0) {
    const sameApp = free.filter(w => w.app === persisted.app);
    if (sameApp.length === 1) {
      const w = sameApp[0];
      if (Math.abs((w.width || 0) - persisted.origW) <= 30 &&
          Math.abs((w.height || 0) - persisted.origH) <= 30) {
        return w;
      }
    }
  }
  return null;
}

module.exports = { findRelinkTarget, matchPersistedToLive };
