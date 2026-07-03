'use strict';
/**
 * predictoraudit.test.js — PredictorAudit（🔬予兆発見監査＋🎯発見狙い台）の品質ゲート。
 * analysis_大東洋本店.html から PredictorAudit をロードし、以下を assert（失敗時 exit 1）：
 *   A) walk-forward＋並べ替え検定(family-wise, perm=400)が例外なく走る／候補は機械生成30個
 *   B) 仕込みシグナルあり：壁を超えた予兆(discovered)のみが本物認定され、
 *      発見狙い台 picks() が次の同タイプ対象日に forward-only で点灯（仕込み台が上位）
 *   C) シグナルなし（純ノイズ）：壁超え0件 → picks() が isEmpty=true
 *      ＝「出せる台がありません」を正直に返す（グラン本店の isEmpty 挙動が移植後も保持）
 *
 * ※PredictorAudit の信頼性制御は「収縮定数」ではない（SpecMatch=+3, PredictionEngine2=+5 とは別方式）。
 *   実コード（バイト厳密コピー）は：最小サンプルゲート fY.length>=8＋family-wise 並べ替え壁
 *   （400回の最大帰無リフトの95パーセンタイル）＋walk-forward（前半 liftTrain>1）で本物を選別する。
 */
const path = require('path');
const GEN = require('./fixtures/synthetic-data-generator.js');

const HTML = path.join(__dirname, '..', 'analysis_大東洋本店.html');
const app = GEN.loadAppScript(HTML);

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!cond) failed++;
}

if (typeof app.PredictorAudit !== 'object' || typeof app.PredictorAudit.compute !== 'function') {
  console.error('FAIL - PredictorAudit を analysis_大東洋本店.html からロードできません');
  process.exit(1);
}
app.sheetName = 'テスト機'; // 非ジャグラー＝特定日は共通[1,7,17,27]（生成器と一致）
const deps = { isSpecialDay: app.isSpecialDay };
const spec = { gosei: 125, rb: 280 };

console.log('=== PredictorAudit 品質ゲート ===');

// ---------- A) & B) 仕込みシグナルあり ----------
(function testSignal() {
  // 統計的検出力のため月数を増やす（特定日を多く）＝生成器の months を拡張
  const gen = GEN.generateSyntheticData({ months: [1, 2, 3, 4, 5, 6], seed: 20260703 });
  const rows = gen.rows;
  const plantedIds = new Set(gen.plantedIds);
  app.allData = rows;

  let R;
  try {
    R = app.PredictorAudit.compute(rows, deps, { spec, isAt: false, targetType: 'special', perm: 400, seed: 20260701 });
  } catch (e) {
    check('A/B compute(perm=400) が例外なく走る', false, e.name + ': ' + e.message);
    return;
  }
  check('A1 compute(perm=400) が例外なく完走', !!R, 'nTargetDays=' + R.nTargetDays + ' nValidDays=' + R.nValidDays + ' nTestDays=' + R.nTestDays);
  check('A2 機械生成候補=30個（5指標×3窓×2方向）', R.nCand === 30, 'nCand=' + R.nCand);
  check('A3 偶然の壁 wall が算出されている（>=0）', typeof R.wall === 'number' && R.wall >= 0, 'wall=' + (R.wall != null ? R.wall.toFixed(4) : 'null'));

  // 壁超え予兆（discovered）＝ (liftTest-1)>wall かつ liftTrain>1 のみ
  check('B1 壁を超えた予兆(discovered)が1件以上認定される', R.discovered.length > 0, 'discovered=' + R.discovered.length + '/' + R.nCand);
  const allBeatWall = R.discovered.every(o => (o.liftTest - 1) > R.wall && o.liftTrain != null && o.liftTrain > 1);
  check('B2 discovered は全て「壁超え かつ 前半でもlift>1」（walk-forward）', R.discovered.length > 0 && allBeatWall,
    R.discovered.map(o => o.c.key + '(test' + o.liftTest.toFixed(2) + '/train' + (o.liftTrain||0).toFixed(2) + ')').slice(0, 4).join(' '));
  // 仕込みは RB/合成の良さ → rb/gosei 系が拾われるはず
  const hasRbGosei = R.discovered.some(o => o.c.metric === 'rb' || o.c.metric === 'gosei');
  check('B3 discovered に仕込みシグナル由来（rb/合成）の予兆が含まれる', hasRbGosei,
    'metrics=' + [...new Set(R.discovered.map(o => o.c.metric))].join(','));

  // 発見狙い台：次の同タイプ対象日へ forward-only 適用
  const lastDate = [...new Set(rows.map(r => String(r['日付']).substring(0, 10)))].sort().pop();
  const pickDate = app.auditNextDateOfType(lastDate, 'special', app.isSpecialDay);
  const PR = app.PredictorAudit.picks(rows, deps, {}, pickDate, R.discovered);
  check('B4 発見狙い台 picks() が点灯（forward-only、未来対象日）', !PR.isEmpty && PR.ranking.length > 0,
    'pickDate=' + pickDate + ' lit=' + PR.ranking.length);
  const top5 = PR.ranking.slice(0, 5).map(r => r.m);
  const plantedInTop5 = top5.filter(m => plantedIds.has(m)).length;
  check('B5 点灯上位に仕込み台が多い（仕込みシグナルを拾えている）', PR.ranking.length > 0 && plantedInTop5 >= 3,
    'top5=' + top5.join(',') + ' 仕込み' + plantedInTop5 + '/5');
})();

// ---------- C) シグナルなし → isEmpty ----------
(function testNoSignal() {
  // plantedCount:0 ＝ 全台が低深度ノイズ（予兆と到達度が無相関）→ 壁を超える候補は出ないはず
  const gen = GEN.generateSyntheticData({ months: [1, 2, 3, 4, 5, 6], plantedCount: 0, seed: 424242 });
  const rows = gen.rows;
  app.allData = rows;

  let R;
  try {
    R = app.PredictorAudit.compute(rows, deps, { spec, isAt: false, targetType: 'special', perm: 400, seed: 20260701 });
  } catch (e) { check('C compute(ノイズ) が例外なく走る', false, e.name + ': ' + e.message); return; }
  check('C1 ノイズデータでも compute が例外なく完走', !!R, 'nValidDays=' + R.nValidDays + ' nTestDays=' + R.nTestDays);
  check('C2 壁を超えた予兆は0件（偶然と区別できない）', R.discovered.length === 0, 'discovered=' + R.discovered.length);

  const lastDate = [...new Set(rows.map(r => String(r['日付']).substring(0, 10)))].sort().pop();
  const pickDate = app.auditNextDateOfType(lastDate, 'special', app.isSpecialDay);
  const PR = app.PredictorAudit.picks(rows, deps, {}, pickDate, R.discovered);
  check('C3 発見狙い台 picks() は isEmpty=true（＝「出せる台がありません」）', PR.isEmpty === true && PR.ranking.length === 0,
    'isEmpty=' + PR.isEmpty + ' ranking=' + PR.ranking.length);
})();

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' CHECK(S) FAILED');
process.exit(failed ? 1 : 0);
