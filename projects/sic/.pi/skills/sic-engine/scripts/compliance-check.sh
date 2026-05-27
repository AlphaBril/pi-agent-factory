#!/usr/bin/env bash
# SIC Engine — Contract Compliance Checker v2
# Verifies implementation against YAML .sic contracts
# Uses basic field extraction (no YAML parser dependency in bash)
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CONTRACT_FILE=""
IMPL_FILES=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --contract) CONTRACT_FILE="$2"; shift 2 ;;
    --implementation) shift; while [[ $# -gt 0 && ! "$1" =~ ^-- ]]; do IMPL_FILES+=("$1"); shift; done ;;
    -h|--help)
      echo "Usage: compliance-check.sh --contract <file.sic> --implementation <file1> <file2>"
      echo ""
      echo "Verifies implementation files against a YAML .sic contract."
      echo "Checks: modifications applied, imports added, exports added, constraints respected."
      exit 0
      ;;
    *) shift ;;
  esac
done

if [[ -z "$CONTRACT_FILE" ]]; then
  echo "Error: --contract <file> required"
  exit 1
fi

if [[ ! -f "$CONTRACT_FILE" ]]; then
  echo "Error: Contract file not found: $CONTRACT_FILE"
  exit 1
fi

if [[ ${#IMPL_FILES[@]} -eq 0 ]]; then
  echo "Error: --implementation <file1> ... required"
  exit 1
fi

echo "═══ CONTRACT COMPLIANCE AUDIT v2 ═══"
echo ""
echo "Contract: $CONTRACT_FILE"
echo "Implementation: ${IMPL_FILES[*]}"
echo ""

PASS=0
FAIL=0
WARN=0

check() {
  local description="$1" pattern="$2"
  local found=false
  for f in "${IMPL_FILES[@]}"; do
    if [[ -f "$f" ]] && grep -q "$pattern" "$f" 2>/dev/null; then
      found=true
      break
    fi
  done
  if $found; then
    echo -e "  ${GREEN}✓${NC} $description"
    ((PASS++))
  else
    echo -e "  ${RED}✗${NC} $description (pattern not found: $pattern)"
    ((FAIL++))
  fi
}

check_warn() {
  local description="$1" pattern="$2"
  local found=false
  for f in "${IMPL_FILES[@]}"; do
    if [[ -f "$f" ]] && grep -q "$pattern" "$f" 2>/dev/null; then
      found=true
      break
    fi
  done
  if $found; then
    echo -e "  ${GREEN}✓${NC} $description"
    ((PASS++))
  else
    echo -e "  ${YELLOW}⚠${NC} $description (not verified)"
    ((WARN++))
  fi
}

# ── Extract contract fields ──
# Skip comment lines starting with #, extract YAML fields

# Get action
ACTION=$(grep -m1 "^action:" "$CONTRACT_FILE" 2>/dev/null | sed 's/^action:\s*//' | tr -d '"' | tr -d "'" | xargs)

# Get file path
TARGET_FILE=$(grep -m1 "^file:" "$CONTRACT_FILE" 2>/dev/null | sed 's/^file:\s*//' | tr -d '"' | tr -d "'" | xargs)

echo "Target file: ${TARGET_FILE:-unknown}"
echo "Action: ${ACTION:-unknown}"
echo ""

# ── Check file exists ──
echo "File existence:"
if [[ "$ACTION" == "create" ]]; then
  if [[ -f "$TARGET_FILE" ]]; then
    echo -e "  ${GREEN}✓${NC} File created: $TARGET_FILE"
    ((PASS++))
  else
    echo -e "  ${RED}✗${NC} File NOT created: $TARGET_FILE"
    ((FAIL++))
  fi
elif [[ "$ACTION" == "modify" ]]; then
  if [[ -f "$TARGET_FILE" ]]; then
    echo -e "  ${GREEN}✓${NC} File exists: $TARGET_FILE"
    ((PASS++))
  else
    echo -e "  ${RED}✗${NC} File missing: $TARGET_FILE"
    ((FAIL++))
  fi
fi
echo ""

# ── Check new_imports ──
echo "Imports:"
IN_IMPORTS=false
while IFS= read -r line; do
  # Detect new_imports section
  if [[ "$line" =~ ^new_imports: ]]; then
    IN_IMPORTS=true
    continue
  fi
  # Exit section on next top-level key
  if $IN_IMPORTS && [[ "$line" =~ ^[a-z_]+: ]] && [[ ! "$line" =~ ^[[:space:]] ]]; then
    IN_IMPORTS=false
    continue
  fi
  if $IN_IMPORTS && [[ "$line" =~ ^[[:space:]]*-[[:space:]] ]]; then
    import_val=$(echo "$line" | sed 's/^[[:space:]]*-[[:space:]]*//' | tr -d '"' | tr -d "'")
    if [[ -n "$import_val" && "$import_val" != "[]" ]]; then
      # Extract the key part (module name or function name)
      import_key=$(echo "$import_val" | grep -oP "(?:from |import )[\'\"]?([^'\"]+)[\'\"]?" | head -1 || echo "$import_val")
      check_warn "Import: $import_val" "$import_key"
    fi
  fi
done < "$CONTRACT_FILE"
echo ""

# ── Check new_exports ──
echo "Exports:"
IN_EXPORTS=false
while IFS= read -r line; do
  if [[ "$line" =~ ^new_exports: ]]; then
    IN_EXPORTS=true
    continue
  fi
  if $IN_EXPORTS && [[ "$line" =~ ^[a-z_]+: ]] && [[ ! "$line" =~ ^[[:space:]] ]]; then
    IN_EXPORTS=false
    continue
  fi
  if $IN_EXPORTS && [[ "$line" =~ ^[[:space:]]*-[[:space:]] ]]; then
    export_val=$(echo "$line" | sed 's/^[[:space:]]*-[[:space:]]*//' | tr -d '"' | tr -d "'")
    if [[ -n "$export_val" && "$export_val" != "[]" ]]; then
      check "Export: $export_val" "$export_val"
    fi
  fi
done < "$CONTRACT_FILE"
echo ""

# ── Check modifications (keyword presence) ──
echo "Modifications (keyword check):"
IN_MODS=false
while IFS= read -r line; do
  if [[ "$line" =~ ^modifications: ]]; then
    IN_MODS=true
    continue
  fi
  if $IN_MODS && [[ "$line" =~ ^[a-z_]+: ]] && [[ ! "$line" =~ ^[[:space:]] ]]; then
    IN_MODS=false
    continue
  fi
  if $IN_MODS && [[ "$line" =~ ^[[:space:]]*-[[:space:]] ]]; then
    mod_val=$(echo "$line" | sed 's/^[[:space:]]*-[[:space:]]*//' | tr -d '"' | tr -d "'")
    if [[ -n "$mod_val" ]]; then
      # Try to extract a function/class/method name from the modification description
      # Look for patterns like "Add function sum", "Create class Foo", "Implement bar()"
      keyword=$(echo "$mod_val" | grep -oP "(?:function|class|method|interface|type|const|let|var|def|fn)\s+(\w+)" | awk '{print $2}' | head -1)
      if [[ -n "$keyword" ]]; then
        check "Modification keyword: $keyword" "$keyword"
      else
        # Fallback: just note it
        echo -e "  ${BLUE}○${NC} $mod_val (manual verification needed)"
      fi
    fi
  fi
done < "$CONTRACT_FILE"
echo ""

# ── Check scope (git diff) ──
echo "Scope verification:"
if command -v git &>/dev/null && git rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
  CHANGED=$(git diff --name-only 2>/dev/null || true)
  if [[ -n "$CHANGED" ]]; then
    UNEXPECTED=0
    while IFS= read -r changed_file; do
      # Skip session files
      [[ "$changed_file" == .pi/sessions/* ]] && continue
      # Check if it's one of our implementation files
      IS_EXPECTED=false
      for impl in "${IMPL_FILES[@]}"; do
        if [[ "$changed_file" == "$impl" ]]; then
          IS_EXPECTED=true
          break
        fi
      done
      if ! $IS_EXPECTED; then
        echo -e "  ${RED}✗${NC} Unexpected change: $changed_file"
        ((UNEXPECTED++))
      fi
    done <<< "$CHANGED"

    if [[ $UNEXPECTED -eq 0 ]]; then
      echo -e "  ${GREEN}✓${NC} No unexpected file changes"
      ((PASS++))
    else
      echo -e "  ${RED}✗${NC} $UNEXPECTED file(s) changed outside contract scope"
      ((FAIL++))
    fi
  else
    echo -e "  ${GREEN}✓${NC} No uncommitted changes"
    ((PASS++))
  fi
else
  echo -e "  ${YELLOW}⚠${NC} Not a git repo, cannot verify scope"
  ((WARN++))
fi
echo ""

# ── Summary ──
echo "═══ COMPLIANCE SUMMARY ═══"
echo ""
echo -e "  ${GREEN}Passed:    $PASS${NC}"
echo -e "  ${RED}Failed:    $FAIL${NC}"
echo -e "  ${YELLOW}Warnings:  $WARN${NC}"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}VERDICT: FAIL${NC} — contract not fulfilled"
  exit 1
elif [[ $WARN -gt 0 ]]; then
  echo -e "${YELLOW}VERDICT: NEEDS_REVIEW${NC} — some checks need manual verification"
  exit 0
else
  echo -e "${GREEN}VERDICT: PASS${NC} — contract fulfilled"
  exit 0
fi
