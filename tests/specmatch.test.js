'use strict';
/**
 * specmatch.test.js — SpecMatch（🎯解析値マッチ）計算コアの品質ゲート。
 * analysis_大東洋本店.html から SpecMatch をロードし、以下を assert（失敗時 exit 1）：
 *   A) RB重み0.6・合成重み0.4（非AT機）とRB専用（AT機）の使い分け
 *   B) プール確率化（Σ総回転数 / Σ回数）＝台ごとの単純平均ではない
 *   C) 信頼性収縮：pd（プール日数）が少ない台ほど adj が解析値ライン(1)へ収縮
 *   D) 生成器ベースの end-to-end：仕込み台（良い挙動）が adj 上位
 *
 * ※SpecMatch の収縮定数は shrinkK=3（adj = 1 + (combined-1)*pd/(pd+3)）。
 *   本テストはバイト厳密コピーした実コードの挙動をそのまま検証する。
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
function approx(a, b, tol) { return Math.abs(a - b) <= (tol != null ? tol : 1e-6); }

if (typeof app.SpecMatch !== 'object' || typeof app.SpecMatch.compute !== 'function') {
  console.error('FAIL - SpecMatch を analysis_大東洋本店.html からロードできません');
  process.exit(1);
}
app.sheetName = 'テスト機'; // 非ジャグラー扱い（特定日=1,7,17,27）
const deps = { isSpecialDay: app.isSpecialDay };

// 行生成ヘルパー
function row(date, m, rot, BB, RB) {
  return { 日付: date, 台番号: String(m), BB: String(BB), RB: String(RB), 総回転数: String(rot),
    合成確率: '1/' + Math.round(rot / (BB + RB)), BB確率: '1/' + Math.round(rot / Math.max(BB,1)),
    RB確率: '1/' + Math.round(rot / Math.max(RB,1)), 差枚: '0' };
}
const SPECIAL = ['2026-01-01','2026-01-07','2026-01-17','2026-01-27','2026-02-01','2026-02-07','2026-02-17','2026-02-27','2026-03-01','2026-03-07'];
const TARGET = '2026-05-01'; // 特定日・全データより後（forward-only）

console.log('=== SpecMatch 品質ゲート ===');

// ---------- A) 重み付け（非AT=0.6/0.4, AT=RB専用） ----------
(function testWeighting() {
  const dates = SPECIAL.slice(0, 4);
  const rows = dates.map(d => row(d, 101, 2000, 5, 8)); // rot2000,BB5,RB8 ×4日
  const sumRot = 2000*4, sumBB = 5*4, sumRB = 8*4;
  const pooledRBd = sumRot / sumRB;             // 250
  const pooledGoseid = sumRot / (sumBB + sumRB); // 153.8..
  const spec = { gosei: 170, rb: 300 };
  const ratioRB = spec.rb / pooledRBd;
  const ratioGosei = spec.gosei / pooledGoseid;
  const expNonAt = 0.6 * ratioRB + 0.4 * ratioGosei;
  const expAt = ratioRB;

  const Rn = app.SpecMatch.compute(rows, TARGET, deps, { spec, isAt: false, wRb: 0.6, wGosei: 0.4 });
  const Ra = app.SpecMatch.compute(rows, TARGET, deps, { spec, isAt: true, wRb: 0.6, wGosei: 0.4 });
  const cn = Rn.ranking[0], ca = Ra.ranking[0];

  check('A1 非AT combined = 0.6*ratioRB + 0.4*ratioGosei', cn && approx(cn.combined, Math.round(expNonAt*1000)/1000, 0.002),
    'combined=' + (cn&&cn.combined) + ' 期待=' + (Math.round(expNonAt*1000)/1000));
  check('A2 AT combined = ratioRB（合成無視）', ca && approx(ca.combined, Math.round(expAt*1000)/1000, 0.002),
    'combined=' + (ca&&ca.combined) + ' 期待=' + (Math.round(expAt*1000)/1000));
  check('A3 非AT と AT で combined が異なる（切替が効いている）', cn && ca && !approx(cn.combined, ca.combined, 0.01),
    '非AT=' + (cn&&cn.combined) + ' / AT=' + (ca&&ca.combined));
})();

// ---------- B) プール確率化（Σrot/Σrb、単純平均ではない） ----------
(function testPooling() {
  // 2日で日次レートが大きく異なる：day1=500, day2=300 / 単純平均=400 / プール=10000/32=312.5
  const rows = [ row('2026-01-01', 201, 1000, 3, 2), row('2026-01-07', 201, 9000, 3, 30) ];
  const spec = { gosei: 150, rb: 280 };
  const R = app.SpecMatch.compute(rows, TARGET, deps, { spec, isAt: false });
  const rec = R.ranking[0];
  const pooled = 10000 / 32;       // 312.5
  const simpleMean = (500 + 300) / 2; // 400
  check('B1 pooledRBd = Σrot/Σrb = 312.5（プール）', rec && approx(rec.pooledRBd, 312.5, 0.05),
    'pooledRBd=' + (rec && rec.pooledRBd));
  check('B2 単純平均(400)ではない', rec && Math.abs(rec.pooledRBd - simpleMean) > 1,
    'pooledRBd=' + (rec && rec.pooledRBd) + ' vs 単純平均=' + simpleMean);
})();

// ---------- C) 信頼性収縮（pd少 → adj が 1 へ収縮） ----------
(function testShrinkage() {
  // 10特定日。LOW台=2日、HIGH台=10日。同一の日次挙動（同じcombined）。dayFrac=0.1でLOWも採用。
  const rows = [];
  SPECIAL.forEach((d, i) => {
    rows.push(row(d, 301, 2000, 5, 8));           // HIGH: 全10日
    if (i < 2) rows.push(row(d, 302, 2000, 5, 8)); // LOW: 先頭2日のみ
  });
  const spec = { gosei: 170, rb: 300 }; // combined>1（解析値超え）→ bonus が収縮されるのを見る
  const R = app.SpecMatch.compute(rows, TARGET, deps, { spec, isAt: false, wRb: 0.6, wGosei: 0.4, dayFrac: 0.1 });
  const hi = R.ranking.find(x => x.m === 301);
  const lo = R.ranking.find(x => x.m === 302);
  // 期待値（実コード shrinkK=3）
  const combined = hi ? hi.combined : null;
  const expHi = combined != null ? Math.round((1 + (combined - 1) * 10 / (10 + 3)) * 1000) / 1000 : null;
  const expLo = combined != null ? Math.round((1 + (combined - 1) * 2 / (2 + 3)) * 1000) / 1000 : null;

  check('C0 LOW/HIGH 両台がランクに出現（pd=2 と pd=10）', !!hi && !!lo, 'hi.pd=' + (hi&&hi.pd) + ' lo.pd=' + (lo&&lo.pd));
  check('C1 両台の combined が同一（挙動は同じ）', hi && lo && approx(hi.combined, lo.combined, 0.001),
    'hi=' + (hi&&hi.combined) + ' lo=' + (lo&&lo.combined));
  check('C2 adj が公式 1+(combined-1)*pd/(pd+3) に一致', hi && lo && approx(hi.adj, expHi, 0.002) && approx(lo.adj, expLo, 0.002),
    'hi.adj=' + (hi&&hi.adj) + '(期待' + expHi + ') lo.adj=' + (lo&&lo.adj) + '(期待' + expLo + ')');
  check('C3 少サンプル台ほど 1 に近い（収縮で控えめ補正）', hi && lo && Math.abs(lo.adj - 1) < Math.abs(hi.adj - 1),
    '|lo.adj-1|=' + (lo && Math.abs(lo.adj-1).toFixed(4)) + ' < |hi.adj-1|=' + (hi && Math.abs(hi.adj-1).toFixed(4)));
})();

// ---------- D) 生成器ベース end-to-end（仕込み台が adj 上位） ----------
(function testEndToEnd() {
  const { rows, plantedIds, targetDate } = GEN.generateSyntheticData({});
  const planted = new Set(plantedIds);
  const spec = { gosei: 125, rb: 280 }; // マイジャグラーV 想定の解析値
  app.sheetName = 'マイジャグラーV';
  const R = app.SpecMatch.compute(rows, targetDate, { isSpecialDay: app.isSpecialDay },
    { spec, isAt: false, wRb: 0.6, wGosei: 0.4 });
  app.sheetName = 'テスト機';
  const ranked = R.ranking;
  const pAdj = ranked.filter(x => planted.has(x.m)).map(x => x.adj);
  const oAdj = ranked.filter(x => !planted.has(x.m)).map(x => x.adj);
  const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const top1Planted = ranked.length && planted.has(ranked[0].m);
  check('D1 ランキングが生成された（プール集計が動作）', ranked.length > 0, 'ranked=' + ranked.length + ' / sameTypeDays=' + R.sameTypeDayCount);
  check('D2 #1 が仕込み台', top1Planted, ranked.length ? ('#1=台' + ranked[0].m) : 'なし');
  check('D3 仕込み台の平均adj > 非仕込みの平均adj', pAdj.length && oAdj.length && mean(pAdj) > mean(oAdj),
    'planted=' + mean(pAdj).toFixed(3) + ' other=' + mean(oAdj).toFixed(3));
})();

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' CHECK(S) FAILED');
process.exit(failed ? 1 : 0);
