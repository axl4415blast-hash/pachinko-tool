'use strict';
// 7機能移植（大東洋本店）向けの抽出元ハッシュ照合ガード（軽量・pre-commit向け）。
//
// 各 Step で `analysis_グラン本店.html` からバイト厳密コピーしたブロック（HTML/関数）の
// sha256 を `.migration-hashes/<feature>.txt` に記録しておく運用にする。
// このスクリプトは、その記録値と `analysis_大東洋本店.html` 側の「現物」を突き合わせ、
// 移植後の配線・整形作業などで意図せずブロックが壊れていないかをコミット毎に検証する。
//
// 抽出規則：`start_marker` を含む最初の行を起点とし、そこから `lines` 行分（自身を含む）
// を取り出して1ブロックとする。行番号ではなくマーカー文字列で位置を探すため、他機能の
// 追加でファイル全体の行数がズレても機能する（check-core-bytematch.js と同じ考え方）。
//
// ハッシュファイル書式（`#`で始まる行はコメント。空行区切り不要）：
//   [html]
//   start_marker=<!-- 日別島図 -->
//   lines=32
//   sha256=492194983190dcc0...   ← 必ずCRLF→LF正規化後の値（下記と同じ計算式）。
//                                  生sed+sha256sum（CRLF込み）の値を書くと常に不一致になる。
//
//   [func]
//   start_marker=// ── 日別島図 ──────────────────────────────
//   lines=97
//   sha256=422d67efbce9f533...   ← 同上。LF正規化後の値。
//
// `.migration-hashes/` が存在しない、または *.txt が1件もなければ何もせず exit 0（skip）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const HASH_DIR = path.join(ROOT, '.migration-hashes');
const DST = path.join(ROOT, 'analysis_大東洋本店.html');

function readLF(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n'); }
  catch (e) { return null; }
}
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

// 簡易 INI ライクパーサ： [section] + key=value 行。# はコメント。
function parseHashFile(text) {
  const sections = {};
  let current = null;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const secMatch = line.match(/^\[(.+)\]$/);
    if (secMatch) { current = secMatch[1]; sections[current] = {}; continue; }
    const eq = line.indexOf('=');
    if (eq === -1 || !current) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1); // marker自体に'='を含む可能性を考慮し以降は切らない
    sections[current][key] = val;
  }
  return sections;
}

if (!fs.existsSync(HASH_DIR)) {
  console.log('migration-hashes: .migration-hashes/ 未作成 — skip.');
  process.exit(0);
}
const files = fs.readdirSync(HASH_DIR).filter(f => f.endsWith('.txt'));
if (files.length === 0) {
  console.log('migration-hashes: 記録済みハッシュファイルなし — skip.');
  process.exit(0);
}

const dstLines = readLF(DST);
if (!dstLines) {
  console.error('migration-hashes: ' + DST + ' を読めません');
  process.exit(2);
}

let failed = 0, checked = 0;
for (const file of files) {
  const feature = file.replace(/\.txt$/, '');
  const raw = fs.readFileSync(path.join(HASH_DIR, file), 'utf8');
  const sections = parseHashFile(raw);

  for (const [blockName, entry] of Object.entries(sections)) {
    const { start_marker, lines, sha256: expected } = entry;
    if (!start_marker || !lines || !expected) {
      console.error(`  [FAIL] ${feature}/${blockName}: start_marker/lines/sha256 のいずれかが未設定`);
      failed++;
      continue;
    }
    const n = parseInt(lines, 10);
    const startIdx = dstLines.findIndex(l => l.includes(start_marker));
    if (startIdx === -1) {
      console.error(`  [FAIL] ${feature}/${blockName}: マーカー "${start_marker}" が大東洋本店側に見つかりません`);
      failed++;
      continue;
    }
    if (startIdx + n > dstLines.length) {
      console.error(`  [FAIL] ${feature}/${blockName}: マーカー位置(行${startIdx + 1})から${n}行取れません（ファイル末尾まで${dstLines.length - startIdx}行）`);
      failed++;
      continue;
    }
    const block = dstLines.slice(startIdx, startIdx + n).join('\n');
    const actual = sha256(block);
    if (actual === expected) {
      console.log(`  [MATCH] ${feature}/${blockName} 行${startIdx + 1}〜${startIdx + n} ${actual.slice(0, 16)}`);
      checked++;
    } else {
      console.error(`  [FAIL] ${feature}/${blockName} 行${startIdx + 1}〜${startIdx + n} ハッシュ不一致`);
      console.error(`         記録値: ${expected}`);
      console.error(`         実測値: ${actual}`);
      failed++;
    }
  }
}

console.log(`migration-hashes: checked=${checked} failed=${failed}`);
process.exit(failed ? 2 : 0);
