'use strict';
/**
 * synthetic-data-generator.js
 * ------------------------------------------------------------------------
 * パチンコホール分析アプリ（analysis_*.html）の分析コア
 * （PredictionEngine2 / SpecMatch / PredictorAudit）を単体検証するための、
 * 再利用可能な合成データ生成モジュール。
 *
 * 目的：
 *  - 一部の台に「持続的な良い挙動（＝翌特定日に高設定になりやすい）」を
 *    深度勾配つきで仕込み、コアがそのシグナルを拾えるか（MHゲート通過・
 *    仕込み台の上位独占・連続スコア分離）を検証する。
 *
 * ★連続値化（重要）：
 *  各台の指標（RB確率・合成確率・総回転数・差枚）を 12,13,14 のような整数刻みでは
 *  なく、実データに近い連続値で生成する。エンジンがランキングに使う実測レート
 *  （総回転数 / 回数）は「総回転数を連続的に振る」ことで 247.3, 251.8 … のように
 *  連続化し、かつ RB・合成・回転を独立ノイズで相関を崩す。これにより 5バケット
 *  量子化下でも人工的な同率1位が起きにくくなる（整数刻みが原因の同点を回避）。
 *
 * 生成される行の形式（大東洋本店スプレッドシート正規化後と同じキー）：
 *   { 日付, 台番号, BB, RB, 総回転数, 合成確率, BB確率, RB確率, 差枚 }
 *
 * アプリ本体には依存しない（standalone）。検証時は生成した rows を
 * PredictionEngine2.compute 等へ渡す。
 * ------------------------------------------------------------------------
 */

// ── 決定論的PRNG（mulberry32）：seed固定で再現可能 ──
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// ── 標準正規乱数（Box-Muller）──
function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
function pad2(n) { return String(n).padStart(2, '0'); }

// ── 特定日判定（大東洋本店）──
const isSpecialCommon  = (day) => [1, 7, 17, 27].includes(day);          // 全機種共通
const isSpecialJuggler = (day) => [1, 5, 7, 15, 17, 25, 27].includes(day); // ジャグラー系（+5,15,25）

/**
 * 合成データを生成する。
 *
 * @param {object} opts
 *   machineCount   台数（既定 24）
 *   firstMachine   先頭台番号（既定 101）
 *   plantedCount   仕込み台数（先頭から、既定 6）
 *   year, months   対象年・月配列（既定 2026, [1,2,3,4]）
 *   daysPerMonth   各月の日数（既定 28）
 *   isSpecial      day(1-31)=>bool（既定 isSpecialCommon）
 *   seed           PRNGシード（既定 20260703）
 *   criteria       高設定基準 { rotation, gosei, rb }（既定 マイジャグラーV相当 5000/125/280）
 *   targetDate     目標日（既定：最終データ日の翌特定日を自動算出）
 * @returns {{ rows, machineIds, plantedIds, specialDates, normalDates, targetDate, criteria }}
 */
function generateSyntheticData(opts) {
  opts = opts || {};
  const machineCount = opts.machineCount || 24;
  const firstMachine = opts.firstMachine || 101;
  const plantedCount = opts.plantedCount != null ? opts.plantedCount : 6;
  const year         = opts.year || 2026;
  const months       = opts.months || [1, 2, 3, 4];
  const daysPerMonth = opts.daysPerMonth || 28;
  const isSpecial    = opts.isSpecial || isSpecialCommon;
  const seed         = opts.seed || 20260703;
  const criteria     = opts.criteria || { rotation: 5000, gosei: 125, rb: 280 };
  // 指標ごとの独立ノイズ強度。大きいほど RB/合成/回転の相関が崩れ、
  // PredictionEngine2 の5バケット量子化下でもスコアが分離しやすくなる（同着減）。
  const metricNoise  = opts.metricNoise != null ? opts.metricNoise : 0.10;
  const rng = mulberry32(seed);

  const machineIds = [];
  for (let i = 0; i < machineCount; i++) machineIds.push(firstMachine + i);
  const plantedIds = machineIds.slice(0, plantedCount);
  const plantedSet = new Set(plantedIds);

  // 台ごとの「深度」d∈(0,1)：仕込み台は 0.55〜0.95 に連続的に散らす（＋微小ジッタで一意）。
  // 全て非仕込み台のノイズより明確に上になる帯に置き、仕込み台が上位を独占するようにする。
  // 非仕込み台は 0.01〜0.06 の極低深度（＝ omen/follow をほぼ拾わない）。
  const depth = {};
  plantedIds.forEach((m, k) => {
    const base = plantedCount > 1 ? 0.55 + (0.95 - 0.55) * (k / (plantedCount - 1)) : 0.9;
    depth[m] = clamp(base + gaussian(rng) * 0.012, 0.5, 0.98);
  });
  machineIds.slice(plantedCount).forEach((m) => {
    depth[m] = clamp(0.01 + Math.abs(gaussian(rng)) * 0.02, 0, 0.08);
  });

  // 深度→翌特定日の高設定確率（単調増加）。非仕込み（浅い）はほぼ0、仕込みは深いほど高頻度。
  const pHigh = (d) => clamp(0.92 * d, 0.01, 0.96);

  // レート帯（連続値のターゲット）。実測レートは「総回転数を連続的に振る」ことで連続化する。
  const RB_LO = 235, RB_HI = 460;     // RB確率の分母（小さいほど良い）：良い台235〜、悪い台〜460
  const GO_LO = 128, GO_HI = 205;     // 合成確率の分母
  const RB_HI_SPEC = criteria.rb  - 6;   // 特定日・高設定時のRB分母上限側（<=criteria.rb）
  const GO_HI_SPEC = criteria.gosei - 4; // 特定日・高設定時の合成分母上限側（<=criteria.gosei）

  const rows = [];
  const specialDates = [];
  const normalDates = [];
  const seenDates = new Set();

  for (const mo of months) {
    for (let day = 1; day <= daysPerMonth; day++) {
      const date = `${year}-${pad2(mo)}-${pad2(day)}`;
      const special = isSpecial(day);
      if (!seenDates.has(date)) {
        seenDates.add(date);
        (special ? specialDates : normalDates).push(date);
      }
      for (const m of machineIds) {
        const d = depth[m];
        // 指標ごとに独立ノイズ → RB/合成/回転の相関を崩す（同一バケット集中を防ぐ）
        const qRb    = clamp(d + gaussian(rng) * metricNoise, 0, 1);
        const qGosei = clamp(d + gaussian(rng) * metricNoise, 0, 1);

        let rotation, BB, RB, sagai;

        if (special) {
          const high = rng() < pHigh(d);
          if (high) {
            // 高設定：総回転数>=criteria.rotation、RB分母<=criteria.rb、合成分母<=criteria.gosei
            const rbRate = RB_HI_SPEC - qRb * 40;                 // 例 234〜194（連続）
            const goRate = GO_HI_SPEC - qGosei * 18;              // 例 121〜103（連続）
            rotation = Math.round(criteria.rotation + 800 + rng() * 3200); // >=5000 を連続的に
            RB = Math.max(criteria.rb ? 1 : 1, Math.round(rotation / rbRate));
            BB = Math.max(1, Math.round(rotation / goRate) - RB);
            sagai = Math.round(400 + d * 1600 + gaussian(rng) * 250);
          } else {
            // 非高設定：総回転数<criteria.rotation（回転数で落とす）
            rotation = Math.round(3400 + rng() * (criteria.rotation - 3500)); // <5000
            const rbRate = RB_LO + 90 + qRb * 90;
            const goRate = GO_LO + 40 + qGosei * 40;
            RB = Math.max(1, Math.round(rotation / rbRate));
            BB = Math.max(1, Math.round(rotation / goRate) - RB);
            sagai = Math.round(-200 + gaussian(rng) * 400);
          }
        } else {
          // 通常日：直近3通常日のRB/合成ランクが omen(rb3/gosei3) の入力になる。
          // 深い台ほどレート分母が小さい（良い）＝機種内ベスト1/3に入る。
          const rbRate = RB_HI - qRb    * (RB_HI - RB_LO);   // 連続
          const goRate = GO_HI - qGosei * (GO_HI - GO_LO);   // 連続
          // RBは実台らしい整数帯、総回転数を rbRate×RB で連続的に決める → 実測レート連続
          RB = Math.max(4, Math.round(9 + rng() * 5));        // 9〜14
          rotation = Math.round(rbRate * RB);                 // 連続（rbRate連続のため）
          BB = Math.max(1, Math.round(rotation / goRate) - RB);
          sagai = Math.round((d - 0.15) * 1200 + gaussian(rng) * 500);
        }

        RB = Math.max(1, RB);
        BB = Math.max(1, BB);
        rotation = Math.max(1, rotation);
        const goseiDen = Math.round(rotation / (BB + RB));
        const bbDen = Math.round(rotation / BB);
        const rbDen = Math.round(rotation / RB);

        rows.push({
          日付: date,
          台番号: String(m),
          BB: String(BB),
          RB: String(RB),
          総回転数: String(rotation),
          合成確率: '1/' + goseiDen,
          BB確率: '1/' + bbDen,
          RB確率: '1/' + rbDen,
          差枚: String(sagai),
        });
      }
    }
  }

  // 目標日：最終データ日の翌・同タイプ特定日を既定に（forward-only 前提）
  let targetDate = opts.targetDate;
  if (!targetDate) {
    const lastMonth = months[months.length - 1];
    targetDate = `${year}-${pad2(lastMonth + 1)}-01`; // 翌月1日（=特定日）
  }

  return { rows, machineIds, plantedIds, specialDates, normalDates, targetDate, criteria };
}

/**
 * analysis_*.html の埋め込みインラインJS（PredictionEngine2 / SpecMatch /
 * PredictorAudit / isHighSetting / isSpecialDay / parseFraction 等）を、
 * 最小DOMスタブの vm サンドボックス上でロードして返す。
 * Step4/5 のテストでも SpecMatch / PredictorAudit を取り出すのに再利用する。
 * @param {string} htmlPath analysis_*.html への絶対パス
 * @returns {object} sandbox（app のグローバルが乗ったオブジェクト）
 */
function loadAppScript(htmlPath) {
  const fs = require('fs');
  const vm = require('vm');
  const html = fs.readFileSync(htmlPath, 'utf8');
  // src なしのインライン <script> を全て連結（外部CDNはスキップ）
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, code = '';
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1] || '')) continue;
    code += m[2] + '\n';
  }
  const elCache = new Map();
  const stubEl = (id) => {
    if (elCache.has(id)) return elCache.get(id);
    // getContext/destroy は Chart.js（createChart()）が、appendChild/classList は
    // テーブル・ページ切替（showPage等）が実際に叩くDOM APIのため no-op を用意する。
    const el = {
      style: {}, value: '', textContent: '', innerHTML: '',
      getContext: () => ({}), destroy: () => {}, appendChild: () => {},
      classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    };
    const proxy = new Proxy(el, {
      get(t, p) { if (p in t) return t[p]; if (typeof p === 'string' && (p.startsWith('add') || p === 'onchange' || p === 'onclick')) return () => {}; return t[p]; },
      set(t, p, v) { t[p] = v; return true; },
    });
    elCache.set(id, proxy);
    return proxy;
  };
  let anonElCount = 0;
  const sandbox = {
    console,
    // id ごとに同一の要素（プロキシ）を返す（実DOMのgetElementByIdと同様、
    // 状態が呼び出しをまたいで保持される。以前は毎回新規オブジェクトを返しており、
    // setLoadStatus 等で書き込んだ内容をホスト側から読み戻せなかった）。
    document: {
      getElementById: (id) => stubEl(id),
      querySelector: (sel) => stubEl('__qs:' + sel),
      querySelectorAll: () => [],
      createElement: () => stubEl('__ce:' + (anonElCount++)),
      addEventListener: () => {},
    },
    localStorage: { _s: {}, getItem(k) { return this._s[k] != null ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); } },
    fetch: () => Promise.reject(new Error('no network in test sandbox')),
    alert: () => {}, Chart: function () { return {}; },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: htmlPath });
  return sandbox;
}

/**
 * loadAppScript() で読み込んだサンドボックスの、トップレベル `let`/`const`
 * 変数をホスト側から読めるようにする。
 *
 * 背景（Node vm の既知の挙動）：vm.runInContext で実行したスクリプトの
 * トップレベル `let`/`const` は、そのコンテキストの「グローバル字句環境」に
 * 束縛され、コンテキストの「グローバルオブジェクト」のプロパティにはならない。
 * そのため `sandbox.allData = [...]`（ホスト側からの代入）や `sandbox.allData`
 * （ホスト側からの読み取り）は、スクリプト内部の `let allData` とは別物になる
 * （関数宣言や `var` は逆にグローバルオブジェクトのプロパティになるため、
 * `app.fetchSheetData(...)` のような呼び出しは問題なく機能する）。
 *
 * この関数は、同じコンテキスト内でクロージャ経由のgetter（`configurable`な
 * プロパティ `__exposed_<name>`）を定義し、スクリプト内部の実行中の値を
 * ホスト側からポーリングできるようにする。
 *
 * @param {object} sandbox loadAppScript() の戻り値
 * @param {string} name 読みたいトップレベル変数名（例: 'allData'）
 * @returns {() => any} 現在値を返す関数
 */
function exposeGlobal(sandbox, name) {
  const vm = require('vm');
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) throw new Error('invalid identifier: ' + name);
  const prop = '__exposed_' + name;
  vm.runInContext(
    'Object.defineProperty(globalThis, ' + JSON.stringify(prop) + ', ' +
    '{ get(){ return typeof ' + name + " !== 'undefined' ? " + name + ' : undefined; }, configurable:true });',
    sandbox
  );
  return () => sandbox[prop];
}

/**
 * exposeGlobal() の書き込み版。トップレベル `let` 変数へホスト側から値を
 * セットする（例：`sheetName` — 本番では sheet-select の onchange ハンドラが
 * `sheetName = select.value;` として副作用的に設定するもので、
 * fetchSheetData() 自体は書き換えない。UIを経由せずテストする場合はこれで補う）。
 *
 * @param {object} sandbox loadAppScript() の戻り値
 * @param {string} name 書き込みたいトップレベル変数名
 * @param {*} value セットする値（JSON化できる値のみ）
 */
function setGlobal(sandbox, name, value) {
  const vm = require('vm');
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) throw new Error('invalid identifier: ' + name);
  vm.runInContext(name + ' = ' + JSON.stringify(value) + ';', sandbox);
}

const WEEKDAY_KANJI = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * generateSyntheticData() が返す内部形式（総回転数/BB確率/合成確率/台番号...）の
 * rows を、大東洋本店GASの生レスポンス形式（実際に script.google.com から返る
 * キー名：日付='M/D'・曜日・台番・差枚・G数・BB・RB・合成・BB率・RB率）に変換する。
 * fetchSheetData() の列名変換（G数→総回転数 等）をCIで実地に通すためのfixture生成用。
 * ※日付はアプリの `2026-` 固定変換に合わせて年を落とす（'2026-01-07' → '1/7'）。
 */
function toRawGasRows(rows) {
  return rows.map((r) => {
    const [, mo, day] = String(r.日付).split('-');
    const dateM_D = String(parseInt(mo, 10)) + '/' + String(parseInt(day, 10));
    const dow = WEEKDAY_KANJI[new Date(r.日付 + 'T00:00:00').getDay()];
    const fmtComma = (v) => Number(v).toLocaleString('en-US');
    return {
      日付: dateM_D,
      曜日: dow,
      台番: r.台番号,
      差枚: fmtComma(r.差枚),
      G数: fmtComma(r.総回転数),
      BB: String(r.BB),
      RB: String(r.RB),
      合成: r.合成確率,
      BB率: r.BB確率,
      RB率: r.RB確率,
    };
  });
}

module.exports = {
  generateSyntheticData,
  loadAppScript,
  exposeGlobal,
  setGlobal,
  toRawGasRows,
  isSpecialCommon,
  isSpecialJuggler,
  mulberry32,
  gaussian,
};

// ── 自己検証テスト（品質ゲート）：`node synthetic-data-generator.js`
//    条件を満たさなければ非ゼロ exit code で終了する。目視不要。 ──
if (require.main === module) {
  const path = require('path');

  // 品質ゲートのしきい値
  const MIN_DISTINCT_SCORES = 6; // 全台スコアの異なり数の下限（二値化していないことの目安。実測9）

  const htmlPath = path.join(__dirname, '..', '..', 'analysis_大東洋本店.html');
  const app = loadAppScript(htmlPath);
  if (typeof app.PredictionEngine2 !== 'object' || typeof app.PredictionEngine2.compute !== 'function') {
    console.error('FAIL - PredictionEngine2 を analysis_大東洋本店.html からロードできません');
    process.exit(1);
  }

  // 任意：SDG_OPTS 環境変数（JSON）で generator オプションを上書き（CI/負のテスト用）
  let genOpts = {};
  if (process.env.SDG_OPTS) { try { genOpts = JSON.parse(process.env.SDG_OPTS); } catch (e) { console.error('SDG_OPTS の JSON が不正:', e.message); process.exit(2); } }
  const { rows, plantedIds, targetDate } = generateSyntheticData(genOpts);
  const planted = new Set(plantedIds);
  app.allData = rows;
  app.sheetName = 'マイジャグラーV';

  const R = app.PredictionEngine2.compute(
    rows, targetDate,
    { isHighSetting: app.isHighSetting, isSpecialDay: app.isSpecialDay, parseFraction: app.parseFraction },
    { period: { mode: 'all' } }
  );

  const scores = R.ranking.map((x) => x.score);
  const plantedScores = R.ranking.filter((x) => planted.has(x.m)).map((x) => x.score);
  const otherScores = R.ranking.filter((x) => !planted.has(x.m)).map((x) => x.score);
  const minPlanted = Math.min.apply(null, plantedScores);
  const maxOther = otherScores.length ? Math.max.apply(null, otherScores) : -Infinity;
  const distinctCount = new Set(scores).size;

  let failed = 0;
  function check(name, cond, detail) {
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? '  (' + detail + ')' : ''));
    if (!cond) failed++;
  }

  console.log('=== PredictionEngine2 品質ゲート（合成データ・seed固定）===');
  console.log('btDayCount=' + R.btDayCount + ' passingCount=' + R.passingCount + ' targetType=' + R.targetType);
  check('1) passingCount > 0（MHゲート通過あり）', R.passingCount > 0, 'passingCount=' + R.passingCount);
  check('2) min(仕込み台) > max(非仕込み台)', plantedScores.length > 0 && minPlanted > maxOther, 'min planted=' + minPlanted + ' / max other=' + maxOther);
  check('3) スコア異なり数 >= ' + MIN_DISTINCT_SCORES + '（非二値）', distinctCount >= MIN_DISTINCT_SCORES, 'distinct=' + distinctCount);

  console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' CHECK(S) FAILED');
  process.exit(failed ? 1 : 0);
}
