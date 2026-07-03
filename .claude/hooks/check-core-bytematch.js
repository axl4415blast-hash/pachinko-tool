'use strict';
// 埋め込み計算コアのバイト一致ガード（軽量・pre-commit向け）。
// 大東洋本店の埋め込みコア（PredictionEngine2 / SpecMatch / PredictorAudit …）が、
// グラン本店（source of truth）の同名コアと **バイト一致**（改行LF正規化後）で
// あり続けることを保証する。CLAUDE.md の「計算コアはバイト一致を quality gate に」を
// コミット毎に自動執行する。差異があれば exit 2 でコミットをブロック。
//
// 抽出規則：各コアのセクション見出しコメント（marker）を含む行から、その後最初に
// 現れる行頭 "});"（UMD IIFE の閉じ）までを 1 ブロックとして取り出す。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'analysis_グラン本店.html');   // source of truth
const DST = path.join(ROOT, 'analysis_大東洋本店.html');   // 移植先

// 監視するコア（marker はセクション見出しの一部・一意な文字列）
const CORES = [
  { name: 'PredictionEngine2', marker: '予測統合エンジン（案Y土台' },
  { name: 'SpecMatch',         marker: '解析値マッチ 計算コア（specmatch_core.js' },
  { name: 'PredictorAudit',    marker: '予兆発見監査 実データ版コア' },
];

function readLF(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n'); }
  catch (e) { return null; }
}
// marker を含む行から最初の行頭 "});" までを抽出（見つからなければ null）
function extractCore(lines, marker) {
  if (!lines) return null;
  let start = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].indexOf(marker) !== -1) { start = i; break; } }
  if (start === -1) return null;
  for (let j = start; j < lines.length; j++) {
    if (/^\}\);\s*$/.test(lines[j])) return lines.slice(start, j + 1).join('\n');
  }
  return null; // 閉じが見つからない＝構造破損
}
function sha256(s) { return require('crypto').createHash('sha256').update(s, 'utf8').digest('hex'); }

const gLines = readLF(SRC);
const dLines = readLF(DST);
if (!gLines) { console.error('core-bytematch: source ' + SRC + ' を読めません'); process.exit(2); }
if (!dLines) { console.error('core-bytematch: ' + DST + ' を読めません'); process.exit(2); }

let failed = 0, checked = 0, skipped = 0;
for (const core of CORES) {
  const g = extractCore(gLines, core.marker);
  const d = extractCore(dLines, core.marker);
  if (g === null && d === null) { console.log('  [skip] ' + core.name + '（両ファイルに未存在）'); skipped++; continue; }
  if (d === null) { console.log('  [skip] ' + core.name + '（大東洋に未移植）'); skipped++; continue; }
  if (g === null) { console.error('  [FAIL] ' + core.name + '：グラン本店に見つからない（source欠落）'); failed++; continue; }
  const hg = sha256(g), hd = sha256(d);
  if (hg === hd) { console.log('  [MATCH] ' + core.name + ' ' + hg.slice(0, 16)); checked++; }
  else { console.error('  [FAIL] ' + core.name + ' バイト不一致  グラン=' + hg.slice(0, 16) + ' 大東洋=' + hd.slice(0, 16)); failed++; }
}
console.log('core-bytematch: checked=' + checked + ' skipped=' + skipped + ' failed=' + failed);
process.exit(failed ? 2 : 0);
