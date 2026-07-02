#!/bin/bash
# PreToolUse hook (matcher: Bash).
# Before a `git commit`, syntax-check the inline JS of every analysis_*.html.
# Blocks the commit (exit 2) if any script has a syntax error.
# Any non-commit Bash command is allowed silently (exit 0).
#
# Notes for this environment:
#  - jq is NOT installed on this Windows/Git Bash setup, so the hook JSON on stdin
#    is parsed with node (which is guaranteed available for this project).
#  - The heavy lifting (extract <script> blocks + parse) lives in check-html-js.js.

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
  if ! node "$SCRIPT_DIR/check-html-js.js" "$f"; then
    FAIL=1
  fi
done

if [ "$FOUND" -eq 0 ]; then
  echo "pre-commit-check: no analysis_*.html found; nothing to check." >&2
  exit 0
fi

if [ "$FAIL" -ne 0 ]; then
  echo "pre-commit-check: JS syntax check FAILED — commit blocked. Fix the error above and retry." >&2
  exit 2
fi

echo "pre-commit-check: analysis_*.html inline JS syntax OK." >&2
exit 0
