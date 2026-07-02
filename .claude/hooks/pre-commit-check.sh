#!/bin/bash
# PreToolUse hook (matcher: Bash) — commit時の「軽量」品質ゲート。
# Before a `git commit`, 以下の速いチェックのみを実行し、失敗で commit をブロック(exit 2)：
#   1) 構文：analysis_*.html のインラインJS node --check
#   2) 構造：<div> 開閉バランス（|open-close| <= 1、CLAUDE.md 既定差1）
#   3) コア一致：埋め込み計算コア（PredictionEngine2/SpecMatch/PredictorAudit）が
#      グラン本店の同名コアとバイト一致（LF正規化）
# 重い計算（合成データによる engine/SpecMatch/PredictorAudit の単体テスト群）は
# コミット時には走らせない。GitHub Actions（.github/workflows/tests.yml、push/PR時）へ分離。
# Any non-commit Bash command is allowed silently (exit 0).
#
# Notes for this environment:
#  - jq is NOT installed on this Windows/Git Bash setup, so the hook JSON on stdin
#    is parsed with node (which is guaranteed available for this project).

INPUT=$(cat)

# Parse tool_input.command and cwd out of the hook payload using node.
PARSED=$(printf '%s' "$INPUT" | node -e '
let d="";
process.stdin.on("data",c=>d+=c).on("end",()=>{
  try {
    const j = JSON.parse(d);
    const cmd = (j.tool_input && j.tool_input.command) || "";
    process.stdout.write(cmd + "\n" + (j.cwd || ""));
  } catch (e) { process.stdout.write("\n"); }
});')
COMMAND=$(printf '%s' "$PARSED" | sed -n '1p')
CWD=$(printf '%s' "$PARSED" | sed -n '2p')

# Only gate `git commit`; allow everything else.
if ! printf '%s' "$COMMAND" | grep -qE 'git[[:space:]]+commit'; then
  exit 0
fi

# Work from the project directory.
if [ -n "$CWD" ] && [ -d "$CWD" ]; then cd "$CWD" || exit 0; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Degrade gracefully if node disappears.
if ! command -v node >/dev/null 2>&1; then
  echo "pre-commit-check: node not found; skipping JS syntax check." >&2
  exit 0
fi

FAIL=0
FOUND=0
for f in analysis_*.html; do
  [ -e "$f" ] || continue
  FOUND=1
  # 1) 構文チェック
  if ! node "$SCRIPT_DIR/check-html-js.js" "$f"; then
    FAIL=1
  fi
  # 2) div 開閉バランス（|diff| <= 1 を許容）
  o=$(grep -o '<div' "$f" | wc -l)
  c=$(grep -o '</div>' "$f" | wc -l)
  d=$((o - c)); [ "$d" -lt 0 ] && d=$(( -d ))
  if [ "$d" -gt 1 ]; then
    echo "pre-commit-check: [$f] div開閉バランス崩れ（open=$o close=$c diff=$((o-c))）" >&2
    FAIL=1
  fi
done

if [ "$FOUND" -eq 0 ]; then
  echo "pre-commit-check: no analysis_*.html found; nothing to check." >&2
  exit 0
fi

# 3) 埋め込み計算コアのバイト一致ガード
if ! node "$SCRIPT_DIR/check-core-bytematch.js"; then
  echo "pre-commit-check: 計算コアがグラン本店と不一致 — commit blocked。" >&2
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "pre-commit-check: FAILED — commit blocked. 上のエラーを直して再実行してください。" >&2
  exit 2
fi

echo "pre-commit-check: 構文OK / div balance OK / コア一致OK。" >&2
exit 0
