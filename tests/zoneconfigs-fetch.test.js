'use strict';
/**
 * zoneconfigs-fetch.test.js — 「GAS取得後の処理でのみ発生するバグ」を
 * CI上で検出するための回帰テスト。
 *
 * 背景：Step3（大東洋独自4ページ削除）で、無関係な `const ZONE_CONFIGS = {...}` が
 * 削除範囲に巻き込まれて消失した。`node --check` は通り、既存のCIテスト（合成データを
 * allData に直接代入してエンジンだけを呼ぶ形）も通っていたため、実データ投入
 * （fetchSheetData経由）時にのみ ReferenceError が発生するまで気づけなかった。
 *
 * このテストは、実際のGASレスポンス形式（生JSON配列：日付/曜日/台番/差枚/G数/BB/RB/
 * 合成/BB率/RB率）を模したfixtureを用意し、`fetch` をモックした上で
 * **本物の fetchSheetData() を呼び出し**、
 *   fetchSheetData → 列名変換 → ZONE_CONFIGS参照 → renderAllPages
 *     → renderZone → getCurrentZones/getCurrentCorners
 * という実運用のデータ取得後の処理経路を丸ごと実行する。
 * fetchSheetData は内部で try/catch しているため、失敗しても例外は外に伝播しない
 * （＝「例外が飛ばないこと」だけでは検証にならない）。そのため load-status の文言と
 * allData の中身を直接検査する。
 */
const path = require('path');
const GEN = require('./fixtures/synthetic-data-generator.js');

const HTML = path.join(__dirname, '..', 'analysis_大東洋本店.html');
const app = GEN.loadAppScript(HTML);
// allData はスクリプト内で `let` 宣言のため、ホスト側から直接 app.allData では
// 読めない（Node vm の仕様。詳細は exposeGlobal のコメント参照）。ブリッジ経由で読む。
const getAllData = GEN.exposeGlobal(app, 'allData');

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!cond) failed++;
}

console.log('=== fetchSheetData 実経路（ZONE_CONFIGS参照）回帰テスト ===');

// マイジャグラーVの実ZONE_CONFIGS有効台番号は 105〜132（28台）。
// これに加えて「旧ゾーン構成の残骸」を模した範囲外台番号（90〜94）も混ぜ、
// 除外フィルターが実際に機能することも検証する。
const { rows: validRows } = GEN.generateSyntheticData({ firstMachine: 105, machineCount: 28, plantedCount: 4 });
const { rows: staleRows } = GEN.generateSyntheticData({ firstMachine: 90, machineCount: 5, plantedCount: 0, seed: 999 });
const allSynthRows = validRows.concat(staleRows);
const rawGasRows = GEN.toRawGasRows(allSynthRows);

// getSheets / getData の両方に応答するフェイクGAS。
app.fetch = (url) => {
  const u = String(url);
  if (u.includes('action=getSheets')) {
    return Promise.resolve({ json: () => Promise.resolve({ status: 'ok', sheets: ['マイジャグラーV'] }) });
  }
  if (u.includes('action=getData')) {
    return Promise.resolve({ json: () => Promise.resolve({ status: 'ok', data: rawGasRows }) });
  }
  return Promise.reject(new Error('unexpected fetch: ' + u));
};

(async () => {
  try {
    // 本番ではシート選択の onchange ハンドラが `sheetName = select.value;` を副作用的に
    // 設定してから loadSheetData()→fetchSheetData() を呼ぶ。UIを経由しないテストでは
    // 同じ前提（getCurrentZones/getCurrentCorners が参照する sheetName）を明示的に揃える。
    GEN.setGlobal(app, 'sheetName', 'マイジャグラーV');
    // 本物の fetchSheetData を、本物の実行経路（列名変換→ZONE_CONFIGS→renderAllPages）で呼ぶ。
    await app.fetchSheetData('https://fake-gas.example/exec', 'マイジャグラーV');
  } catch (e) {
    check('fetchSheetData が例外を投げずに完走する', false, e.name + ': ' + e.message);
    console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' CHECK(S) FAILED');
    process.exit(1);
  }

  const status = (() => { try { return app.document.getElementById('load-status').textContent; } catch (e) { return '(取得失敗)'; } })();
  check('1) load-status にエラー文言が出ていない（ReferenceError等の握りつぶし検出）', !/エラー/.test(status), 'status="' + status + '"');
  const allData = getAllData();
  check('2) allData が実際に読み込まれている', Array.isArray(allData) && allData.length > 0, 'allData.length=' + (allData ? allData.length : 'undefined'));

  // ZONE_CONFIGS フィルターが機能：範囲外(90-94)は除外され、範囲内(105-132)は残る。
  const machines = allData ? [...new Set(allData.map((r) => parseInt(r['台番号'], 10)))].sort((a, b) => a - b) : [];
  const inRange = machines.every((m) => m >= 105 && m <= 132);
  const staleExcluded = !machines.some((m) => m >= 90 && m <= 94);
  check('3) ZONE_CONFIGSフィルター：範囲外(90-94)の残骸台番号が除外されている', staleExcluded, 'machines=' + machines.join(','));
  check('4) ZONE_CONFIGSフィルター：範囲内(105-132)の台番号は保持されている', inRange && machines.length === 28, 'machines.length=' + machines.length);

  // fetchSheetData 内で参照した列名変換（G数→総回転数 等）が効いているか。
  const sample = allData && allData[0];
  check('5) 列名変換：総回転数キーが存在する（G数からの変換）', !!(sample && sample['総回転数'] != null), sample ? JSON.stringify(Object.keys(sample)) : 'n/a');

  // renderAllPages 経由で renderZone → getCurrentZones/getCurrentCorners まで実行済みのはず。追加で直接も呼ぶ。
  try {
    const zones = app.getCurrentZones();
    const corners = app.getCurrentCorners();
    check('6) getCurrentZones() が例外なく実データ構造を返す', Array.isArray(zones) && zones.length === 3, 'zones=' + (zones ? zones.length : 'n/a'));
    check('7) getCurrentCorners() が例外なく実データ構造を返す', Array.isArray(corners) && corners.length === 6, 'corners=' + (corners ? corners.length : 'n/a'));
  } catch (e) {
    check('6/7) getCurrentZones/getCurrentCorners が例外なく実行される', false, e.name + ': ' + e.message);
  }

  console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' CHECK(S) FAILED');
  process.exit(failed ? 1 : 0);
})();
