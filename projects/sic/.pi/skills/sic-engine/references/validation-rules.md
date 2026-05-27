# Validation Rules — SIC Engine Harness (v2)

## Stage 1: Static Validation

### Lint Check
- **Detection order**: package.json scripts → eslint config → biome.json → pyproject.toml → Cargo.toml → go.mod
- **CRITICAL**: Detect tool existence FIRST, then run. A non-zero exit code from a detected tool = FAIL, not "not found".
- **Pass criteria**: Exit code 0, no errors (warnings acceptable)
- **On failure**: Report exact errors with file:line. Do NOT disable lint rules.

### Type Check
- **Detection**: tsconfig.json → pyproject.toml (mypy) → Cargo.toml → go.mod
- **Pass criteria**: Exit code 0
- **On failure**: Report exact type errors. Do NOT use `any` or `# type: ignore`.

### Format Check
- **Detection**: .prettierrc → biome.json → pyproject.toml (ruff/black) → Cargo.toml → go.mod
- **Pass criteria**: No formatting differences
- **On failure**: Report which files need formatting. Mason should run formatter.

## Stage 2: Targeted Tests

### Test Discovery
1. Extract artifact name from the `.sic` file field
2. Search for test files matching that name
3. Common patterns: `__tests__/<Name>.test.ts`, `<name>.spec.ts`, `test_<name>.py`, `<name>_test.go`
4. If no specific tests exist → NOT_FOUND (not a failure)

### Execution
- Run ONLY relevant tests first (fast feedback)
- **On failure**: Report failing test names and assertion messages
- **Exception**: If the test tests old behavior that the contract explicitly changes, note this

## Stage 3: Contract Compliance Audit

### Scope Check
- `git diff --name-only` is TRUTH
- Every file in git diff MUST have a corresponding .sic contract
- Every .sic contract MUST have a matching file in git diff
- Exception: `.pi/sessions/` files are always authorized

### Per-File Compliance
For each `.sic` contract, check against `git diff <file>`:
- Were all `modifications` applied?
- Were `new_imports` added?
- Were `new_exports` added?
- Were `constraints` respected (no other changes)?
- Were `location_hints` followed (approximate — within 5 lines is OK)?

### Forbidden Changes
- New files not in any contract → SCOPE VIOLATION
- Methods not in `modifications` → SCOPE VIOLATION
- Refactored existing code → SCOPE VIOLATION

## Stage 4: Verdict Determination

### Three-Level Verdict (No Fake Precision)

| Verdict | Criteria | Action |
|---------|----------|--------|
| **PASS** ✅ | All checks pass, no assumptions, no scope violations | Ship it |
| **NEEDS_REVIEW** ⚠️ | Minor warnings, missing tests, reasonable assumptions | Human reads flagged files |
| **FAIL** ❌ | Lint/type errors, scope violations, incomplete contracts | Do NOT merge |

### Decision Logic

```
FAIL if:
  - Any lint errors (not warnings)
  - Any type errors
  - Any test failures
  - Any scope violations (files changed without contract)
  - Any incomplete contracts (contract exists but file unchanged)
  - Multiple assumptions by mason

NEEDS_REVIEW if:
  - Format warnings only
  - 1-2 mason assumptions (documented with // REVIEW:)
  - Tests NOT_FOUND (can't verify)
  - Location drift (change in right area but not exact spot)
  - Conflicting conventions (scout found both, agent picked one)

PASS if:
  - None of the above
```

### Why Not Percentages?

Previous versions used a 0-100% score with arbitrary deductions (-15 per lint fail, -20 per violation). Problems:
- Numbers weren't calibrated against real outcomes
- Gave false precision ("87% confidence" means nothing actionable)
- Different projects need different thresholds

Three levels map directly to actions: ship, review, or fix. No ambiguity.

## Stage 5: Suggested Review

For NEEDS_REVIEW verdicts, the clerk identifies specific files for human attention:
- Files where mason made assumptions
- Files with conflicting convention choices
- Files where tests don't exist
- Files with complex logic changes

Each suggestion includes WHY the human should look at it.
