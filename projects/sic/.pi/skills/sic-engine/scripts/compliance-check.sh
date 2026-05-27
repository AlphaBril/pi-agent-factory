#!/usr/bin/env bash
# SIC Engine — Contract Compliance Checker
# Verifies implementation against a Structured Implementation Contract
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

CONTRACT_FILE=""
IMPL_FILES=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --contract) CONTRACT_FILE="$2"; shift 2 ;;
    --implementation) shift; while [[ $# -gt 0 && ! "$1" =~ ^-- ]]; do IMPL_FILES+=("$1"); shift; done ;;
    -h|--help)
      echo "Usage: compliance-check.sh --contract <file> --implementation <file1> <file2>"
      exit 0
      ;;
    *) shift ;;
  esac
done

if [[ -z "$CONTRACT_FILE" ]]; then
  echo "Error: --contract <file> required"
  exit 1
fi

if [[ ${#IMPL_FILES[@]} -eq 0 ]]; then
  echo "Error: --implementation <file1> ... required"
  exit 1
fi

echo "═══ CONTRACT COMPLIANCE AUDIT ═══"
echo ""
echo "Contract: $CONTRACT_FILE"
echo "Implementation: ${IMPL_FILES[*]}"
echo ""

PASS=0
FAIL=0

check() {
  local description="$1" pattern="$2"
  local found=false
  for f in "${IMPL_FILES[@]}"; do
    if grep -q "$pattern" "$f" 2>/dev/null; then
      found=true
      break
    fi
  done
  if $found; then
    echo -e "  ${GREEN}✓${NC} $description"
    ((PASS++))
  else
    echo -e "  ${RED}✗${NC} $description (pattern: $pattern)"
    ((FAIL++))
  fi
}

# Extract sections from contract
echo "Checking PUBLIC_METHODS..."
if grep -q "PUBLIC_METHODS" "$CONTRACT_FILE"; then
  while IFS= read -r method; do
    method=$(echo "$method" | sed 's/^[-•*] *//' | sed 's/().*$//' | tr -d ' ')
    if [[ -n "$method" ]]; then
      check "Method: $method" "$method"
    fi
  done < <(sed -n '/^PUBLIC_METHODS:/,/^[A-Z_]*:/{ /^PUBLIC_METHODS:/d; /^[A-Z_]*:/d; p }' "$CONTRACT_FILE")
fi
echo ""

echo "Checking OVERRIDES..."
if grep -q "OVERRIDES" "$CONTRACT_FILE"; then
  while IFS= read -r override; do
    override=$(echo "$override" | sed 's/^[-•*] *//' | sed 's/().*$//' | tr -d ' ')
    if [[ -n "$override" ]]; then
      check "Override: $override" "$override"
    fi
  done < <(sed -n '/^OVERRIDES:/,/^[A-Z_]*:/{ /^OVERRIDES:/d; /^[A-Z_]*:/d; p }' "$CONTRACT_FILE")
fi
echo ""

echo "Checking PARAMS..."
if grep -q "PARAMS" "$CONTRACT_FILE"; then
  while IFS= read -r param; do
    param=$(echo "$param" | sed 's/^[-•*] *//' | sed 's/:.*$//' | tr -d ' ')
    if [[ -n "$param" ]]; then
      check "Param: $param" "$param"
    fi
  done < <(sed -n '/^PARAMS:/,/^[A-Z_]*:/{ /^PARAMS:/d; /^[A-Z_]*:/d; p }' "$CONTRACT_FILE")
fi
echo ""

echo "Checking EXTENDS..."
extends=$(grep "^EXTENDS:" "$CONTRACT_FILE" 2>/dev/null | sed 's/^EXTENDS:\s*//' | tr -d ' ')
if [[ -n "$extends" ]]; then
  check "Extends: $extends" "$extends"
fi
echo ""

# Summary
echo "═══ COMPLIANCE SUMMARY ═══"
echo ""
echo -e "  ${GREEN}Passed: $PASS${NC}"
echo -e "  ${RED}Failed: $FAIL${NC}"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}COMPLIANCE CHECK FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}ALL CHECKS PASSED${NC}"
  exit 0
fi
