#!/usr/bin/env bash
# SIC Engine — Validation Harness v2
# Properly distinguishes "tool not found" from "tool found errors"
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

FILES=()
TARGET_DIR=""
STRICT=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --path) TARGET_DIR="$2"; shift 2 ;;
    --files) shift; while [[ $# -gt 0 && ! "$1" =~ ^-- ]]; do FILES+=("$1"); shift; done ;;
    --strict) STRICT=true; shift ;;
    -h|--help)
      echo "Usage: validate.sh --path <dir> --files <file1> <file2> ... [--strict]"
      exit 0
      ;;
    *) shift ;;
  esac
done

if [[ ${#FILES[@]} -eq 0 && -z "$TARGET_DIR" ]]; then
  echo "Error: Provide --path <dir> or --files <file1> <file2>"
  exit 1
fi

TARGET="${FILES[*]:-$TARGET_DIR}"
PASS=0
FAIL=0
WARN=0
NOT_FOUND=0

report() {
  local status="$1" check="$2" detail="${3:-}"
  case $status in
    pass) echo -e "  ${GREEN}✓${NC} ${check}"; ((PASS++)) ;;
    fail) echo -e "  ${RED}✗${NC} ${check}: ${detail}"; ((FAIL++)) ;;
    warn) echo -e "  ${YELLOW}⚠${NC} ${check}: ${detail}"; ((WARN++)) ;;
    notfound) echo -e "  ${BLUE}?${NC} ${check}: not found"; ((NOT_FOUND++)) ;;
  esac
}

echo "═══ SIC VALIDATION HARNESS v2 ═══"
echo ""
echo "Target: ${TARGET}"
echo ""

# ── Stage 1: Lint ──
echo "Stage 1: Lint"

LINTER=""
LINTER_CMD=""

if [[ -f "package.json" ]]; then
  if grep -q '"lint"' package.json 2>/dev/null; then
    LINTER="npm"
    LINTER_CMD="npm run lint"
  elif [[ -f ".eslintrc" || -f ".eslintrc.js" || -f ".eslintrc.json" || -f ".eslintrc.yml" || -f "eslint.config.js" || -f "eslint.config.mjs" ]]; then
    LINTER="eslint"
    LINTER_CMD="npx eslint ${TARGET}"
  elif [[ -f "biome.json" || -f "biome.jsonc" ]]; then
    LINTER="biome"
    LINTER_CMD="npx biome check ${TARGET}"
  fi
elif [[ -f "pyproject.toml" || -f "setup.py" ]]; then
  if command -v ruff &>/dev/null; then
    LINTER="ruff"
    LINTER_CMD="ruff check ${TARGET}"
  elif command -v flake8 &>/dev/null; then
    LINTER="flake8"
    LINTER_CMD="flake8 ${TARGET}"
  fi
elif [[ -f "Cargo.toml" ]]; then
  LINTER="clippy"
  LINTER_CMD="cargo clippy -- -D warnings"
elif [[ -f "go.mod" ]]; then
  if command -v golangci-lint &>/dev/null; then
    LINTER="golangci-lint"
    LINTER_CMD="golangci-lint run"
  fi
fi

if [[ -n "$LINTER_CMD" ]]; then
  echo "  Tool: $LINTER"
  echo "  Command: $LINTER_CMD"
  if eval "$LINTER_CMD" 2>&1; then
    report pass "$LINTER"
  else
    report fail "$LINTER" "lint errors found"
  fi
else
  report notfound "lint"
fi

echo ""

# ── Stage 2: Type Check ──
echo "Stage 2: Types"

TYPECHECK=""
TYPECHECK_CMD=""

if [[ -f "tsconfig.json" ]]; then
  TYPECHECK="tsc"
  TYPECHECK_CMD="npx tsc --noEmit"
elif [[ -f "pyproject.toml" ]] && command -v mypy &>/dev/null; then
  TYPECHECK="mypy"
  TYPECHECK_CMD="mypy ${TARGET}"
elif [[ -f "Cargo.toml" ]]; then
  TYPECHECK="cargo"
  TYPECHECK_CMD="cargo check"
elif [[ -f "go.mod" ]]; then
  TYPECHECK="go-vet"
  TYPECHECK_CMD="go vet ./..."
fi

if [[ -n "$TYPECHECK_CMD" ]]; then
  echo "  Tool: $TYPECHECK"
  echo "  Command: $TYPECHECK_CMD"
  if eval "$TYPECHECK_CMD" 2>&1; then
    report pass "$TYPECHECK"
  else
    report fail "$TYPECHECK" "type errors found"
  fi
else
  report notfound "types"
fi

echo ""

# ── Stage 3: Format ──
echo "Stage 3: Format"

FORMATTER=""
FORMATTER_CMD=""

if [[ -f ".prettierrc" || -f ".prettierrc.json" || -f ".prettierrc.js" || -f "prettier.config.js" || -f "prettier.config.mjs" ]]; then
  FORMATTER="prettier"
  FORMATTER_CMD="npx prettier --check ${TARGET}"
elif [[ -f "biome.json" || -f "biome.jsonc" ]]; then
  FORMATTER="biome"
  FORMATTER_CMD="npx biome format --check ${TARGET}"
elif [[ -f "pyproject.toml" ]] && command -v ruff &>/dev/null; then
  FORMATTER="ruff"
  FORMATTER_CMD="ruff format --check ${TARGET}"
elif [[ -f "Cargo.toml" ]]; then
  FORMATTER="rustfmt"
  FORMATTER_CMD="cargo fmt --check"
elif [[ -f "go.mod" ]]; then
  FORMATTER="gofmt"
  FORMATTER_CMD="gofmt -l ${TARGET}"
fi

if [[ -n "$FORMATTER_CMD" ]]; then
  echo "  Tool: $FORMATTER"
  echo "  Command: $FORMATTER_CMD"
  OUTPUT=$(eval "$FORMATTER_CMD" 2>&1) || true
  if [[ $? -eq 0 && -z "$OUTPUT" ]] || eval "$FORMATTER_CMD" &>/dev/null; then
    report pass "$FORMATTER"
  else
    report warn "$FORMATTER" "formatting differences"
  fi
else
  report notfound "format"
fi

echo ""

# ── Stage 4: Scope Check (git) ──
echo "Stage 4: Scope Check"

if command -v git &>/dev/null && git rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
  CHANGED=$(git diff --name-only 2>/dev/null || true)
  if [[ -n "$CHANGED" ]]; then
    SCOPE_VIOLATIONS=0
    echo "  Files changed:"
    while IFS= read -r f; do
      # Skip session files
      if [[ "$f" == .pi/sessions/* ]]; then
        echo -e "    ${BLUE}○${NC} $f (session file, OK)"
        continue
      fi
      IN_SCOPE=false
      for target in "${FILES[@]}"; do
        if [[ "$f" == "$target" ]]; then
          IN_SCOPE=true
          break
        fi
      done
      if $IN_SCOPE; then
        echo -e "    ${GREEN}✓${NC} $f (in scope)"
      else
        echo -e "    ${RED}✗${NC} $f (OUT OF SCOPE)"
        ((SCOPE_VIOLATIONS++))
      fi
    done <<< "$CHANGED"

    if [[ $SCOPE_VIOLATIONS -gt 0 ]]; then
      if $STRICT; then
        report fail "scope" "$SCOPE_VIOLATIONS file(s) out of scope"
      else
        report warn "scope" "$SCOPE_VIOLATIONS file(s) out of scope"
      fi
    else
      report pass "scope"
    fi
  else
    report pass "scope" "no changes detected"
  fi
else
  report warn "scope" "not a git repository"
fi

echo ""

# ── Summary ──
echo "═══ SUMMARY ═══"
echo ""
echo -e "  ${GREEN}Passed:    $PASS${NC}"
echo -e "  ${RED}Failed:    $FAIL${NC}"
echo -e "  ${YELLOW}Warnings:  $WARN${NC}"
echo -e "  ${BLUE}Not found: $NOT_FOUND${NC}"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}VERDICT: FAIL${NC} — fix errors and re-run"
  exit 1
elif [[ $WARN -gt 0 && "$STRICT" == "true" ]]; then
  echo -e "${YELLOW}VERDICT: FAIL (strict mode)${NC} — fix warnings"
  exit 1
elif [[ $WARN -gt 0 ]]; then
  echo -e "${YELLOW}VERDICT: NEEDS_REVIEW${NC} — check warnings"
  exit 0
else
  echo -e "${GREEN}VERDICT: PASS${NC}"
  exit 0
fi
