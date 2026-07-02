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

module.exports = {
  generateSyntheticData,
  isSpecialCommon,
  isSpecialJuggler,
  mulberry32,
  gaussian,
};

// ── CLI デモ：`node synthetic-data-generator.js` で要約を表示 ──
if (require.main === module) {
  const { rows, machineIds, plantedIds, specialDates, targetDate } = generateSyntheticData({});
  console.log('生成行数:', rows.length);
  console.log('台数:', machineIds.length, '| 仕込み台:', plantedIds.join(','));
  console.log('特定日数:', specialDates.length, '| 目標日:', targetDate);
  console.log('サンプル行:', JSON.stringify(rows[0], null, 0));
  // 連続性の簡易確認：ある特定日の RB確率分母がばらけているか
  const day = specialDates[3];
  const dens = rows.filter(r => r.日付 === day).map(r => parseInt(r.RB確率.split('/')[1]));
  const uniq = new Set(dens);
  console.log(`特定日 ${day} の RB分母 ${dens.length}台中 ユニーク値=${uniq.size}（連続なら台数に近い）`);
}
