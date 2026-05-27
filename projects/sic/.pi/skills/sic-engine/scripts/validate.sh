#!/usr/bin/env bash
# SIC Engine — Validation Harness
# Runs static validation checks against implementation files
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse arguments
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

PASS=0
FAIL=0
WARN=0

report() {
  local status="$1" check="$2" detail="$3"
  case $status in
    pass) echo -e "  ${GREEN}✓${NC} ${check}"; ((PASS++)) ;;
    fail) echo -e "  ${RED}✗${NC} ${check}: ${detail}"; ((FAIL++)) ;;
    warn) echo -e "  ${YELLOW}⚠${NC} ${check}: ${detail}"; ((WARN++)) ;;
  esac
}

echo "═══ SIC VALIDATION HARNESS ═══"
echo ""
echo "Target: ${TARGET_DIR:-${FILES[*]}}"
echo ""

# ── Stage 1: Detect project type ──
echo "Stage 1: Static Validation"
echo ""

# TypeScript/JavaScript
if [[ -f "package.json" ]]; then
  # Lint
  if command -v npx &>/dev/null; then
    if npx eslint ${FILES[*]:-$TARGET_DIR} --quiet 2>/dev/null; then
      report pass "eslint" ""
    else
      report fail "eslint" "lint errors found"
    fi
  fi

  # Types
  if [[ -f "tsconfig.json" ]]; then
    if npx tsc --noEmit 2>/dev/null; then
      report pass "tsc --noEmit" ""
    else
      report fail "tsc --noEmit" "type errors found"
    fi
  fi

  # Format
  if [[ -f ".prettierrc" || -f ".prettierrc.json" || -f "prettier.config.js" ]]; then
    if npx prettier --check ${FILES[*]:-$TARGET_DIR} 2>/dev/null; then
      report pass "prettier" ""
    else
      report warn "prettier" "formatting differences"
    fi
  fi

# Python
elif [[ -f "pyproject.toml" || -f "setup.py" ]]; then
  # Lint
  if command -v ruff &>/dev/null; then
    if ruff check ${FILES[*]:-$TARGET_DIR} 2>/dev/null; then
      report pass "ruff check" ""
    else
      report fail "ruff check" "lint errors found"
    fi
  elif command -v flake8 &>/dev/null; then
    if flake8 ${FILES[*]:-$TARGET_DIR} 2>/dev/null; then
      report pass "flake8" ""
    else
      report fail "flake8" "lint errors found"
    fi
  fi

  # Types
  if command -v mypy &>/dev/null; then
    if mypy ${FILES[*]:-$TARGET_DIR} 2>/dev/null; then
      report pass "mypy" ""
    else
      report fail "mypy" "type errors found"
    fi
  fi

  # Format
  if command -v ruff &>/dev/null; then
    if ruff format --check ${FILES[*]:-$TARGET_DIR} 2>/dev/null; then
      report pass "ruff format" ""
    else
      report warn "ruff format" "formatting differences"
    fi
  fi

# Rust
elif [[ -f "Cargo.toml" ]]; then
  if cargo check 2>/dev/null; then
    report pass "cargo check" ""
  else
    report fail "cargo check" "compilation errors"
  fi
  if cargo clippy 2>/dev/null; then
    report pass "cargo clippy" ""
  else
    report warn "cargo clippy" "lint warnings"
  fi

# Go
elif [[ -f "go.mod" ]]; then
  if go vet ./... 2>/dev/null; then
    report pass "go vet" ""
  else
    report fail "go vet" "vet errors"
  fi
  if command -v golangci-lint &>/dev/null; then
    if golangci-lint run 2>/dev/null; then
      report pass "golangci-lint" ""
    else
      report warn "golangci-lint" "lint warnings"
    fi
  fi

else
  report warn "auto-detect" "Could not determine project type"
fi

echo ""

# ── Stage 2: Scope check (git diff) ──
echo "Stage 2: Scope Check"
echo ""

if command -v git &>/dev/null && git rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
  CHANGED=$(git diff --name-only 2>/dev/null || true)
  if [[ -n "$CHANGED" ]]; then
    echo "  Files changed:"
    echo "$CHANGED" | while read -r f; do
      if printf '%s\n' "${FILES[@]}" | grep -qF "$f" 2>/dev/null; then
        echo -e "    ${GREEN}✓${NC} $f (in scope)"
      else
        echo -e "    ${RED}✗${NC} $f (OUT OF SCOPE)"
        if $STRICT; then
          ((FAIL++))
        else
          ((WARN++))
        fi
      fi
    done
  else
    report pass "scope" "no unexpected changes"
  fi
else
  report warn "scope" "not a git repository, cannot verify scope"
fi

echo ""

# ── Summary ──
echo "═══ SUMMARY ═══"
echo ""
echo -e "  ${GREEN}Passed: $PASS${NC}"
echo -e "  ${RED}Failed: $FAIL${NC}"
echo -e "  ${YELLOW}Warnings: $WARN${NC}"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}VALIDATION FAILED${NC} — fix errors and re-run"
  exit 1
elif [[ $WARN -gt 0 && "$STRICT" == "true" ]]; then
  echo -e "${YELLOW}VALIDATION FAILED (strict mode)${NC} — fix warnings and re-run"
  exit 1
else
  echo -e "${GREEN}VALIDATION PASSED${NC}"
  exit 0
fi
