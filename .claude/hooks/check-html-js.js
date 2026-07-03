// Extract inline <script> blocks (those without a src= attribute) from an HTML
// file and syntax-check each one using V8's parser (equivalent to `node --check`,
// but works on an in-memory string). Exit 2 on any syntax error, 0 otherwise.
//
// Used by .claude/hooks/pre-commit-check.sh as a pre-commit quality gate for the
// single-file analysis apps (analysis_*.html).
const fs = require('fs');
const vm = require('vm');

const file = process.argv[2];
if (!file) { console.error('usage: check-html-js.js <file.html>'); process.exit(2); }

let html;
try { html = fs.readFileSync(file, 'utf8'); }
catch (e) { console.error('cannot read ' + file + ': ' + e.message); process.exit(2); }

const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m, idx = 0, failed = 0;
while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  if (/\bsrc\s*=/i.test(attrs)) continue;   // external script: nothing inline to check
  const code = m[2];
  if (!code.trim()) continue;                // empty block
  idx++;
  try {
    new vm.Script(code, { filename: file + ' [script#' + idx + ']' });
  } catch (e) {
    console.error(file + ' script#' + idx + ' syntax error: ' + e.message);
    failed++;
  }
}
process.exit(failed ? 2 : 0);
