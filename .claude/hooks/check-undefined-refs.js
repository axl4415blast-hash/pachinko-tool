'use strict';
/**
 * check-undefined-refs.js
 * ------------------------------------------------------------------------
 * 軽量な静的チェック：analysis_*.html の埋め込みJSの中で、
 * 「参照されているのに、ファイル内のどこにも定義（宣言）がない識別子」を検出する。
 *
 * 目的：Step3で実際に起きたバグ（`const ZONE_CONFIGS = {...}` を無関係な
 * relatedブロックと一緒に誤って削除。呼び出し側は残ったため node --check
 * も通り、CIも通り、実データ投入時にのみ ReferenceError になった）を、
 * コミット時に機械的に検出するためのガード。
 *
 * 設計方針（意図的な単純化・既知の限界）：
 *  - スコープは「フラット（ファイル全体でまとめて1つの宣言集合）」。
 *    ブロックスコープや変数シャドーイングは区別しない。
 *    → シャドーイングのバグは捕まえないが、「定義ごと消えた」バグは
 *      100%捕まえる（このツールが狙う失敗パターンに一致）。
 *  - フルのJSパーサーではない。文字列・コメント・正規表現リテラルは
 *    ヒューリスティックに除去してから識別子をスキャンする。
 *  - オブジェクトリテラルのキー（`{foo: 1}` の foo）とみなせる、
 *    直後に `:` が続く識別子は使用としてカウントしない（三項演算子の
 *    `cond ? a : b` の a も同様に除外される＝安全側に倒す＝偽陽性より
 *    偽陰性を優先）。
 *  - 分割代入は単純な形（`const {a,b,c} = expr`、リネームなし）のみ対応。
 *
 * 使い方： node check-undefined-refs.js <file.html> [file2.html ...]
 * 終了コード：問題なし=0 / 未定義参照あり=2 / 引数不備等=1
 */
const fs = require('fs');

const KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'return',
  'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'async', 'await', 'static', 'get', 'set',
  'null', 'true', 'false', 'undefined', 'of',
]);

// ブラウザ／JS標準の既知グローバル＋このアプリが使う外部ライブラリ名。
const GLOBAL_ALLOWLIST = new Set([
  'window', 'document', 'self', 'globalThis', 'console', 'localStorage',
  'sessionStorage', 'fetch', 'Promise', 'Array', 'Object', 'JSON', 'Math',
  'Date', 'Number', 'String', 'Boolean', 'RegExp', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'Symbol', 'Proxy', 'Reflect', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'alert',
  'confirm', 'prompt', 'requestAnimationFrame', 'cancelAnimationFrame',
  'structuredClone', 'Intl', 'Chart', 'Node', 'HTMLElement', 'Event',
  'CustomEvent', 'NaN', 'Infinity', 'arguments', 'XMLHttpRequest',
  'FormData', 'Blob', 'File', 'FileReader', 'crypto', 'performance',
  'navigator', 'location', 'history', 'screen', 'module', 'exports',
  'require', 'process', 'Function',
]);

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

// 文字列・コメント・正規表現リテラルをスペースに置換（改行は保持＝行番号を維持）。
// テンプレートリテラルの `${...}` の中身は「通常のJSコード」として同じ規則で
// 再帰的に処理する（＝中の文字列・コメント・ネストしたテンプレートリテラルも
// 正しく除去する）。スタックベースの状態機械：
//   'code'          … 通常のJS（トップレベル、または ${...} の中）
//   'template'      … テンプレートリテラルのリテラル文字部分
// 'code' フレームのうち ${...} 由来のものは braceDepth を持ち、対応する
// `}` に達したら 'template' フレームへ戻る。
function stripNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  const prevSignificant = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const c = out[k];
      if (c !== ' ' && c !== '\n' && c !== '\t') return c;
    }
    return '';
  };
  // スタック要素：{type:'code', braceDepth:number|null} | {type:'template'}
  const stack = [{ type: 'code', braceDepth: null }];

  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];

    if (top.type === 'template') {
      if (c === '`') { out += ' '; i++; stack.pop(); continue; }
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '$' && src[i + 1] === '{') {
        out += '  '; i += 2;
        stack.push({ type: 'code', braceDepth: 1 });
        continue;
      }
      out += blank(c); i++;
      continue;
    }

    // top.type === 'code'
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += blank(src[i]); i++; }
      out += '  '; i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c; out += ' '; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += blank(src[i]); i++;
      }
      out += ' '; i++;
      continue;
    }
    if (c === '`') {
      out += ' '; i++;
      stack.push({ type: 'template' });
      continue;
    }
    if (top.braceDepth != null && c === '{') { top.braceDepth++; out += c; i++; continue; }
    if (top.braceDepth != null && c === '}') {
      top.braceDepth--;
      if (top.braceDepth === 0) { out += ' '; i++; stack.pop(); continue; }
      out += c; i++; continue;
    }
    // 正規表現リテラル（ヒューリスティック：直前の非空白トークンが式の終端でない記号なら / は正規表現開始とみなす）
    if (c === '/') {
      const pv = prevSignificant();
      const looksLikeRegexStart = pv === '' || '(,=:[!&|?{;\n+-*%<>'.includes(pv) ||
        /return$|typeof$|case$/.test(out.slice(-8));
      if (looksLikeRegexStart) {
        let j = i + 1; let inClass = false; let ok = false;
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '\n') break;
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) { ok = true; break; }
          j++;
        }
        if (ok) {
          let k = j + 1; while (k < n && /[a-z]/i.test(src[k])) k++; // flags
          for (let m = i; m < k; m++) out += blank(src[m]);
          i = k;
          continue;
        }
      }
    }
    out += c; i++;
  }
  return out;
}

function splitTopLevel(text, sep) {
  const parts = []; let depth = 0; let buf = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === sep && depth === 0) { parts.push(buf); buf = ''; }
    else buf += c;
  }
  parts.push(buf);
  return parts;
}

function simpleNameFromParam(p) {
  let s = p.trim();
  if (!s) return null;
  if (s.startsWith('...')) s = s.slice(3).trim();
  if (s.startsWith('{') || s.startsWith('[')) return null; // 分割代入パラメータは非対応（限界として明記済み）
  const eq = s.indexOf('=');
  if (eq >= 0) s = s.slice(0, eq).trim();
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : null;
}

// const/let/var キーワード直後から、カンマ区切りの宣言子リストを depth 対応で
// 切り出す（`var a=1, b=2, c=foo(x,y);` や for(let i=0;...) の "i" のような
// 単一名も正しく扱う）。 `;` か、depth が負に戻る `)`/`]`/`}` で打ち切る。
function scanDeclaratorList(clean, startIdx) {
  let i = startIdx, depth = 0, buf = '';
  const segs = [];
  for (; i < clean.length; i++) {
    const c = clean[i];
    if ('([{'.includes(c)) { depth++; buf += c; continue; }
    if (')]}'.includes(c)) { if (depth === 0) break; depth--; buf += c; continue; }
    if (c === ';' && depth === 0) break;
    if (c === ',' && depth === 0) { segs.push(buf); buf = ''; continue; }
    buf += c;
  }
  segs.push(buf);
  return { segs, endIdx: i };
}

function collectDeclared(clean) {
  const declared = new Set(GLOBAL_ALLOWLIST);
  let m;

  // const/let/var 宣言：カンマ区切りの複数宣言子・単純分割代入{a,b,c}/[a,b,c]に対応
  // （リネーム/ネスト/デフォルト値付き分割代入は非対応＝既知の限界）。
  const declKwRe = /\b(?:const|let|var)\s+/g;
  while ((m = declKwRe.exec(clean))) {
    // for (const NAME of expr) / for (const NAME in expr) の特別扱い：
    // "of"/"in" はカンマ区切り宣言子リストの通常構文には現れないため、
    // これらが直後に来る場合は単一の識別子だけを宣言として扱う。
    const forOfIn = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+(?:of|in)\s/.exec(clean.slice(declKwRe.lastIndex, declKwRe.lastIndex + 60));
    if (forOfIn) { declared.add(forOfIn[1]); continue; }
    const { segs } = scanDeclaratorList(clean, declKwRe.lastIndex);
    segs.forEach((seg) => {
      let s = seg.trim(); if (!s) return;
      const eq = s.indexOf('='); if (eq >= 0) s = s.slice(0, eq).trim();
      if (s[0] === '{' || s[0] === '[') {
        const inner = s.slice(1, -1);
        splitTopLevel(inner, ',').forEach((sub) => {
          let t = sub.trim(); if (!t) return;
          const colon = t.indexOf(':'); if (colon >= 0) t = t.slice(colon + 1).trim(); // {a: renamed} → renamed
          const eq2 = t.indexOf('='); if (eq2 >= 0) t = t.slice(0, eq2).trim();
          if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t)) declared.add(t);
        });
      } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s)) {
        declared.add(s);
      }
    });
  }

  // UMD公開パターン： root.NAME = factory(); / window.NAME = ... / self.NAME = ...
  // このアプリの PredictionEngine2 / SpecMatch / PredictorAudit は全てこの形。
  const umdRe = /\b(?:root|window|self|globalThis)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
  while ((m = umdRe.exec(clean))) declared.add(m[1]);

  // function 宣言名・関数式名
  const fnRe = /\bfunction\s*([A-Za-z_$][A-Za-z0-9_$]*)?\s*\(([^)]*)\)/g;
  while ((m = fnRe.exec(clean))) {
    if (m[1]) declared.add(m[1]);
    splitTopLevel(m[2], ',').forEach((p) => { const n = simpleNameFromParam(p); if (n) declared.add(n); });
  }

  // アロー関数の引数： (a,b) => ... / a => ...
  // 単純な正規表現 `\(([^)]*)\)\s*=>` はネストした括弧（例: `foo(x, (a,b)=>...)`）で
  // 誤って外側の呼び出しの `(` から拾ってしまうため、`=>` から後方へ括弧の対応を
  // 取りながら引数リストの開始位置を探す方式にする。
  const arrowRe = /=>/g;
  while ((m = arrowRe.exec(clean))) {
    let p = m.index - 1;
    while (p >= 0 && clean[p] === ' ') p--;
    if (p < 0) continue;
    if (clean[p] === ')') {
      let depth = 1; let q = p - 1;
      while (q >= 0 && depth > 0) {
        if (clean[q] === ')') depth++;
        else if (clean[q] === '(') depth--;
        if (depth > 0) q--;
      }
      if (depth === 0) {
        const params = clean.slice(q + 1, p);
        splitTopLevel(params, ',').forEach((prm) => { const n = simpleNameFromParam(prm); if (n) declared.add(n); });
      }
    } else {
      let q = p;
      while (q >= 0 && /[A-Za-z0-9_$]/.test(clean[q])) q--;
      const name = clean.slice(q + 1, p + 1);
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) declared.add(name);
    }
  }

  // catch(e)
  const catchRe = /\bcatch\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g;
  while ((m = catchRe.exec(clean))) declared.add(m[1]);

  return declared;
}

function findUndefinedRefs(clean, declared) {
  const problems = [];
  IDENT_RE.lastIndex = 0;
  let m;
  while ((m = IDENT_RE.exec(clean))) {
    const name = m[0];
    const start = m.index;
    IDENT_RE.lastIndex = start + name.length;
    if (KEYWORDS.has(name)) continue;
    // 数値リテラルの一部（16進 0x.. / 2進 0b.. / 8進 0o.. / 指数 1e10 等）は除外
    if (start > 0 && /[0-9]/.test(clean[start - 1])) continue;
    // プロパティアクセス（.foo）は除外
    let p = start - 1; while (p >= 0 && (clean[p] === ' ')) p--;
    if (p >= 0 && clean[p] === '.') continue;
    // オブジェクトキー／三項演算子の "a : b" は除外（コロンが直後）
    let q = start + name.length; while (q < clean.length && clean[q] === ' ') q++;
    if (clean[q] === ':' && clean[q + 1] !== ':') continue;
    // 宣言そのもの（識別子直前が const/let/var/function/catch）は除外
    const before = clean.slice(Math.max(0, start - 20), start);
    if (/(const|let|var|function|catch)\s*\(?\s*$/.test(before)) continue;
    if (declared.has(name)) continue;
    const line = clean.slice(0, start).split('\n').length;
    problems.push({ name, line });
  }
  return problems;
}

function checkFile(file) {
  let html;
  try { html = fs.readFileSync(file, 'utf8'); }
  catch (e) { console.error('cannot read ' + file + ': ' + e.message); return 1; }

  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, idx = 0, totalProblems = 0;
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1] || '')) continue;
    const code = m[2];
    if (!code.trim()) continue;
    idx++;
    const clean = stripNoise(code);
    const declared = collectDeclared(clean);
    const problems = findUndefinedRefs(clean, declared);
    // 同じ名前は1回だけ報告（連呼を避ける）。行番号は最初の出現。
    const seen = new Map();
    problems.forEach((p) => { if (!seen.has(p.name)) seen.set(p.name, p.line); });
    if (seen.size) {
      totalProblems += seen.size;
      seen.forEach((line, name) => {
        console.error(file + ' script#' + idx + ':' + line + '  未定義の可能性がある識別子参照: `' + name + '`');
      });
    }
  }
  return totalProblems ? 2 : 0;
}

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: check-undefined-refs.js <file.html> [...]'); process.exit(1); }
let code = 0;
for (const f of files) { const r = checkFile(f); if (r) code = r; }
if (code === 0) console.log('check-undefined-refs: OK（未定義参照なし）');
process.exit(code);
