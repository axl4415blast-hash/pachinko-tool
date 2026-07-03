#!/bin/bash
# commit時の「軽量」品質ゲート・本体（呼び出し元非依存）。
# .claude/hooks/pre-commit-check.sh（Claude Code PreToolUseフック経由）と
# .git/hooks/pre-commit（git本体のネイティブフック）の両方から呼ばれる共通ロジック。
# 呼び出し元がどちらであっても、リポジトリのルートに自分でcdしてから実行する。
#
#   1) 構文：analysis_*.html のインラインJS node --check
#   2) 構造：<div> 開閉バランス（|open-close| <= 1、CLAUDE.md 既定差1）
#   3) コア一致：埋め込み計算コア（PredictionEngine2/SpecMatch/PredictorAudit）が
#      グラン本店の同名コアとバイト一致（LF正規化）
#   4) 未定義参照：ファイル内のどこにも定義がない識別子への参照（check-undefined-refs.js）。
#      node --check は通るがブラウザ実行時にのみ ReferenceError になるバグ
#      （Step3で共有定義 ZONE_CONFIGS を巻き込み削除した実例）を検出するためのガード。
#   5) 移植ハッシュ照合：7機能移植で `.migration-hashes/<feature>.txt` に記録した
#      抽出元sha256と、大東洋本店側の現物ブロックが一致し続けているか
#      （check-migration-hashes.js）。記録ファイルが無ければ何もせずskip。
# 重い計算（合成データによる engine/SpecMatch/PredictorAudit の単体テスト群）は
# コミット時には走らせない。GitHub Actions（.github/workflows/tests.yml、push/PR時）へ分離。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# リポジトリのルートに移動（呼び出し元のcwdに依存しない）。
ROOT="$(cd "$SCRIPT_DIR/../.." && git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$ROOT" ]; then ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"; fi
cd "$ROOT" || exit 2

# Degrade gracefully if node disappears.
if ! command -v node >/dev/null 2>&1; then
  echo "run-quality-checks: node not found; skipping JS syntax check." >&2
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
    echo "run-quality-checks: [$f] div開閉バランス崩れ（open=$o close=$c diff=$((o-c))）" >&2
    FAIL=1
  fi
  # 4) 未定義参照チェック（軽量静的解析）
  if ! node "$SCRIPT_DIR/check-undefined-refs.js" "$f"; then
    FAIL=1
  fi
done

if [ "$FOUND" -eq 0 ]; then
  echo "run-quality-checks: no analysis_*.html found; nothing to check." >&2
  exit 0
fi

# 3) 埋め込み計算コアのバイト一致ガード
if ! node "$SCRIPT_DIR/check-core-bytematch.js"; then
  echo "run-quality-checks: 計算コアがグラン本店と不一致 — commit blocked。" >&2
  FAIL=1
fi

# 5) 7機能移植の抽出元ハッシュ照合
if ! node "$SCRIPT_DIR/check-migration-hashes.js"; then
  echo "run-quality-checks: 移植ブロックのハッシュ不一致 — commit blocked。" >&2
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "run-quality-checks: FAILED — commit blocked. 上のエラーを直して再実行してください。" >&2
  exit 2
fi

echo "run-quality-checks: 構文OK / div balance OK / コア一致OK / 未定義参照なし / 移植ハッシュOK。" >&2
exit 0
