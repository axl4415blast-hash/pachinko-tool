'use strict';
// HTML id属性の重複検出ガード。
//
// 背景：移植でHTMLブロックの範囲を誤ると（carryover HTML誤抽出事故＝page-carryoverの
// 直後に続くpage-heatmap/page-machinetrendまで巻き込んで挿入）、ページdivごと二重化し、
// 同一idが複数存在する不正なHTMLになる。`document.getElementById`は文書順の先頭要素だけを
// 返すため、後方の重複要素は死蔵され、しかも先頭が別バージョン（グラン版）だと大東洋固有UIが
// 使えなくなる実害が出る。この種の事故はfunction重複検出でも移植ハッシュ照合でも捕捉できず、
// ブラウザのIssuesパネル（Duplicate form field id）でしか見つからなかった。そこでコミット時に
// 機械検出する。
//
// 判定：analysis_大東洋本店.html 内の id="..." 属性を全て抽出し、2回以上出現するidがあれば
// exit=1（該当id名と全出現行番号を出力）。HTMLのid属性は本来ページ内で一意であるべきという
// W3C仕様に基づく素直なルール（check-function-duplicates.js と同じ設計思想）。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DST = path.join(ROOT, 'analysis_大東洋本店.html');

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n'); }
  catch (e) { return null; }
}

const lines = readLines(DST);
if (!lines) { console.error('html-id-duplicates: ' + DST + ' を読めません'); process.exit(2); }

// id="..." を全抽出（値は英数・アンダースコア・ハイフンを想定）。行番号も記録。
const idRe = /id="([a-zA-Z_][a-zA-Z0-9_-]*)"/g;
const occurrences = {}; // id -> [行番号(1-indexed), ...]
lines.forEach((line, i) => {
  let m;
  idRe.lastIndex = 0;
  while ((m = idRe.exec(line)) !== null) {
    const id = m[1];
    (occurrences[id] || (occurrences[id] = [])).push(i + 1);
  }
});

let failed = 0;
for (const [id, at] of Object.entries(occurrences)) {
  if (at.length >= 2) {
    failed++;
    console.error(`  [FAIL] id="${id}" が${at.length}箇所に重複（行 ${at.join(', ')}）。HTMLのidはページ内で一意であるべき（ページブロックの二重挿入を疑ってください）。`);
  }
}

if (failed) {
  console.error(`html-id-duplicates: ${failed}件のid重複を検出 — commit blocked。`);
  console.error('  （getElementById は先頭要素のみ返すため、後方の重複要素は死蔵され実害が出ます。ページブロックの範囲誤りを修正してください）');
  process.exit(1);
}
console.log('html-id-duplicates: id重複なし。');
process.exit(0);
