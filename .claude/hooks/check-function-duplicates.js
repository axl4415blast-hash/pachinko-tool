'use strict';
// 関数名の重複（グローバルスコープでのfunction宣言の無言上書き）検出ガード。
//
// 背景：`let`/`const`の重複は構文エラーになり即検出されるが、`function`宣言の重複は
// JavaScriptの仕様上エラーにならず、後から読み込まれた定義が前の定義を無言で上書きする。
// 個別機能の移植（境界・配線・ハッシュ一致）の検証だけでは、この種の孤児混入
// （例：前回のコア四機能移植でPredictionEngine2コアの直前に紛れ込んだdriftFmt孤児）は
// 発見できない。そこで全機能結合後のファイル全体で自動検出する。
//
// 判定方式：グラン本店（source of truth）を「動的な許可リスト」として使う。
//   - 無言上書きが起きるのは、同一ファイル内で **同じ名前が2回以上** 定義されたときだけ。
//     よって「大東洋での出現回数が2以上（＝実際の重複）」かつ「グラン本店での出現回数を
//     超えている」場合のみ、大東洋にだけ余分な定義がある＝孤児/衝突の疑いとして FAIL(exit 1)。
//   - グラン本店にも同数存在する重複（addDays/compute/fmt/num/pDate/dayType/inPeriod/
//     windowVal 等、各IIFEコア内のスコープ付きローカルヘルパー）は、グラン側の
//     カウントと一致するため自動的に許容される（ハードコードの許可リスト不要）。
//   - 大東洋固有の関数（updateJugglerUI/isJugglerMachine/isSpecialCommon 等、グランに
//     存在しないが大東洋に1回だけ定義される正規の関数）は、出現回数が1なので重複ではなく、
//     誤検出しない。
//
// グラン本店にしか存在しない機能（大東洋へ未移植のもの）で大東洋のカウントが少ない
// 分には問題としない（移植は段階的に進むため）。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'analysis_グラン本店.html');   // source of truth（許可リスト）
const DST = path.join(ROOT, 'analysis_大東洋本店.html');   // 検査対象

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/\r/g, ''); }
  catch (e) { return null; }
}

// function宣言名の出現回数を集計（`function name(` 形式のみ。無名関数・メソッドは対象外）
function countFns(text) {
  const counts = {};
  const re = /function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  return counts;
}

// 指定名のfunction宣言が現れる行番号（1-indexed）を返す
function fnLines(text, name) {
  const lines = text.split('\n');
  const re = new RegExp('function\\s+' + name.replace(/[$]/g, '\\$&') + '\\s*\\(');
  const out = [];
  lines.forEach((l, i) => { if (re.test(l)) out.push(i + 1); });
  return out;
}

const gText = readText(SRC);
const dText = readText(DST);
if (gText === null) { console.error('fn-duplicates: source ' + SRC + ' を読めません'); process.exit(2); }
if (dText === null) { console.error('fn-duplicates: ' + DST + ' を読めません'); process.exit(2); }

const gCounts = countFns(gText);
const dCounts = countFns(dText);

let failed = 0;
for (const name of Object.keys(dCounts)) {
  const dc = dCounts[name];
  const gc = gCounts[name] || 0;
  // 実際の重複（大東洋で2回以上）かつグラン超過のときだけFAIL。
  // 大東洋固有の単発関数（dc=1, gc=0）は無言上書きが起きないので対象外。
  if (dc >= 2 && dc > gc) {
    failed++;
    const lines = fnLines(dText, name);
    console.error('  [FAIL] function ' + name + '：大東洋=' + dc + '回 / グラン=' + gc +
      '回（大東洋に余分な定義。孤児/衝突の疑い）  大東洋の定義行: ' + lines.join(', '));
  }
}

if (failed) {
  console.error('fn-duplicates: ' + failed + '件の余分なfunction定義を検出 — commit blocked。');
  console.error('  （グラン本店に無い重複はグローバルスコープでの無言上書きの疑いがあります。孤児定義を削除してください）');
  process.exit(1);
}
console.log('fn-duplicates: 大東洋にグラン超過のfunction重複なし。');
process.exit(0);
