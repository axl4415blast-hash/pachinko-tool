#!/bin/bash
# PreToolUse hook (matcher: Bash) — Claude Code経由のBashツール呼び出しをgit commitかどうかで
# 判定し、該当すれば .claude/hooks/run-quality-checks.sh（実チェック本体）を実行する薄いラッパー。
#
# ⚠️ 既知の制約（2026-07-03判明）：Claude Codeの一部の実行環境では、settings.jsonに
# 正しく設定していてもPreToolUse/PostToolUseフックがBashツール呼び出しに対して
# 発火しないことがある（GitHub issue #6305, #11544 等で報告されている既知の不具合パターンと一致）。
# 実際に「ハッシュ不一致のコミットを試みたが本フックがブロックしなかった」事象が
# このセッションで2回再現し、環境非依存のBashコマンド1発でも本フックが一切発火しないことを
# デバッグマーカーで確認済み。そのため、確実な砦は .git/hooks/pre-commit（git本体のネイティブ
# フック。core.hooksPath未設定ならデフォルトの.git/hooks/pre-commitが常に呼ばれる）であり、
# 本ファイルはあくまで「効くこともある二重の安全網」という位置づけにとどめる。
# 実チェックのロジックは .claude/hooks/run-quality-checks.sh に一本化してあるので、
# 発火する環境では従来通りコミットをブロックできる。
#
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
bash "$SCRIPT_DIR/run-quality-checks.sh"
exit $?
