// lib/snap-liveness.js — snapped エントリの生死判定 (純粋ロジック)
//
// 「しばらくすると snap が外れる」の原因は、CGWindowList から窓が消えた 1 サンプルを
// 「閉じられた」と解釈して snap を破棄していたこと。CGWindowList は
//   - display 抜き差し / 解像度変更 / クラムシェル
//   - sleep 復帰
//   - 別 Space への移動 / 最小化 / アプリの hide
// の最中に、生きている窓を平気で落とす。実際 display-metrics-changed のバースト直後に
// 9〜11 個がまとめて evict されるログが残っていた。
//
// そこで破棄は「確証が取れたときだけ」に限定する。確証の取得は OS 問い合わせなので、
// ここには判定の筋道だけを置き、問い合わせ結果 (probe) は main.js から渡す。
// これで実機のディスプレイ抜き差しを再現しなくても分岐を単体テストできる。

// 確証が取れないまま姿を消し続けたエントリを最終的に諦めるまでの猶予。
// 長めなのは「一瞬の揺れで外れる」を潰すのが主目的だから。これが無いと、
// 判定不能なアプリの閉じた窓が slot を永久占有して新規 snap を妨げる。
const ABSENT_EVICT_MS = 10 * 60 * 1000;

// 「その窓は生きているか / 閉じられたか / 分からないか」
//
// 3 値なのが要点。'alive' と 'unknown' を混ぜてはいけない —
//   'alive'   別 Space / 最小化。見えないだけで生きているので無期限に待てる
//   'unknown' 判定材料が揃わない。待つが、いつかは諦めないと slot が埋まったままになる
// 一緒くたにすると「別 Space に長く置いた窓が時間切れで外れる」か
// 「閉じた窓の slot が永久に空かない」のどちらかを踏む。
//
// probe の値はいずれも「判定不能」を null で表す。判定不能は保持側に倒す —
// 誤って保持しても slot が少し余分に埋まるだけだが、誤って破棄すると
// ユーザーが並べた配置が壊れる。損失が非対称なので迷ったら保持する。
//
//   windowNumber       : 対象の CGWindowID
//   processAlive       : true=生存 / false=消滅 / null=判定不能
//   axWindowIds        : AX が返したそのプロセスの窓 ID 配列 / null=判定不能
//   allSpaceWindowIds  : 全 Space の CGWindowList の窓 ID 配列 / null=判定不能
//
// 戻り値: 'gone' | 'alive' | 'unknown'
function livenessOf({ windowNumber, processAlive, axWindowIds, allSpaceWindowIds }) {
  // 1) プロセスごと消えていれば確実。
  if (processAlive === false) return 'gone';

  // 2) AX でそのプロセスの窓一覧が取れるなら、そこに居るかで判定する。
  //    AX は Space・最小化・CGWindowList の揺れに影響されないので最も信頼できる。
  //    空配列は「AX 応答なし / AXWindowID 非対応アプリ」＝判定不能として次へ。
  if (Array.isArray(axWindowIds) && axWindowIds.length > 0) {
    return axWindowIds.includes(windowNumber) ? 'alive' : 'gone';
  }

  // 3) 全 Space の CGWindowList に居るか (最後の手段)。
  //    空配列は CGWindowList 自体が壊れている瞬間なので判定不能扱い。
  if (Array.isArray(allSpaceWindowIds) && allSpaceWindowIds.length > 0) {
    return allSpaceWindowIds.includes(windowNumber) ? 'alive' : 'gone';
  }

  return 'unknown';
}

// 姿が見えないエントリをどう扱うか。
//
//   stabilizing : display 切替 / sleep 復帰の直後で CGWindowList 全体が信用できない
//   livenessFn  : livenessOf() を走らせる関数。stabilize 中は呼ばれない —
//                 信用できない瞬間に AX を叩いても答えが濁るだけで、コストも無駄。
//   absentSince : ghost になった時刻 (0/undefined ならまだ ghost 化していない)
//
// 戻り値:
//   'wait'  — 判断を見送る (stabilize 中。miss カウントもリセットする)
//   'ghost' — 見えないが生きている / まだ分からない。slot を占有したまま復帰を待つ
//   'evict' — 破棄してよい
function absentVerdict({ stabilizing, livenessFn, absentSince, now, evictAfterMs = ABSENT_EVICT_MS }) {
  if (stabilizing) return 'wait';
  const liveness = livenessFn();
  if (liveness === 'gone') return 'evict';
  // 別 Space / 最小化と分かっているものは期限を切らない。ユーザーが別 Space に
  // 置きっぱなしにした窓が、戻ったら slot から外れていた、では困る。
  if (liveness === 'alive') return 'ghost';
  // unknown: 確証が取れないまま消え続けている。待つが、猶予を過ぎたら諦める。
  if (absentSince && now - absentSince >= evictAfterMs) return 'evict';
  return 'ghost';
}

module.exports = { ABSENT_EVICT_MS, livenessOf, absentVerdict };
