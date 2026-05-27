# Validation Rules — SIC Engine Harness

## Stage 1: Static Validation

### Lint Check
- **Auto-detect order**: package.json scripts → eslintrc → .flake8 → pyproject.toml → Cargo.toml
- **Commands tried**:
  - `npm run lint` / `yarn lint` / `pnpm lint`
  - `npx eslint <files>`
  - `ruff check <files>`
  - `flake8 <files>`
  - `cargo clippy`
  - `golangci-lint run`
- **Pass criteria**: Exit code 0, no errors (warnings acceptable)
- **On failure**: Fix the issue, re-run. Do NOT disable lint rules.

### Type Check
- **Auto-detect**: tsconfig.json → pyproject.toml (mypy) → Cargo.toml
- **Commands**:
  - `npx tsc --noEmit`
  - `mypy <files>`
  - `cargo check`
  - `go vet ./...`
- **Pass criteria**: Exit code 0
- **On failure**: Fix types. Do NOT use `any` or `# type: ignore` unless the repo already does.

### Format Check
- **Commands**:
  - `npx prettier --check <files>`
  - `ruff format --check <files>`
  - `black --check <files>`
  - `cargo fmt --check`
  - `gofmt -l <files>`
- **Pass criteria**: No formatting differences
- **On failure**: Run formatter, commit the change.

## Stage 2: Targeted Tests

### Test Discovery
1. Find test files matching the created artifact name
2. Check common patterns:
   - `__tests__/<Name>.test.ts`
   - `<name>.spec.ts`
   - `test_<name>.py`
   - `<name>_test.go`
   - `tests/<name>.rs`
3. If no specific tests exist, run the full suite for the module

### Execution
- Run ONLY relevant tests first (fast feedback)
- If relevant tests pass, optionally run broader suite
- **On failure**: Fix the implementation (NOT the test), re-run
- **Exception**: If the test is clearly wrong (testing old behavior that the contract changes), report it

## Stage 3: Contract Compliance Audit

### Checklist
For each contract section, verify:

| Check | How to verify |
|-------|---------------|
| CREATE artifacts exist | `ls` / `find` the specified files |
| EXTENDS correct base | `grep "extends\|class.*:" <file>` |
| PARAMS all present | Check constructor/function signature |
| PUBLIC_METHODS exist | `grep` for each method name |
| BEHAVIOR followed | Read implementation, verify step order |
| OVERRIDES implemented | `grep` for override decorator or method |
| CONSTRAINTS respected | Manual review against each constraint |
| DONE_WHEN criteria | Run each specified command |

### Forbidden Changes Check
- Run `git diff --name-only` (or equivalent)
- Compare touched files against contract's CREATE/MODIFY list
- If ANY file was touched that isn't in the contract → VIOLATION
- Exception: index/barrel files for exports (if DONE_WHEN requires it)

### Scope Creep Detection
Look for:
- New files not in CREATE
- New methods not in PUBLIC_METHODS
- New dependencies not in DEPENDENCIES
- Comments that explain "I also..."
- Refactored existing code

## Stage 4: Adversarial Review

### Review Prompts
For each created file, ask:

1. **Correctness**: Are there bugs? Off-by-one? Null handling? Race conditions?
2. **Assumptions**: Does this assume something about the base class that isn't guaranteed?
3. **Complexity**: Is there hidden complexity? Unnecessary indirection?
4. **Edge cases**: What happens at boundaries? Empty input? Max values?
5. **Convention drift**: Does anything deviate from sibling file patterns?

### Severity Classification
- **Critical**: Bug that will cause runtime failure → must fix before reporting
- **Warning**: Potential issue, uncertain → report in confidence warnings
- **Note**: Stylistic concern → mention in suggested review

## Stage 5: Confidence Scoring

### Scoring Rubric

| Score | Meaning | Action |
|-------|---------|--------|
| 95-100% | Mechanical implementation, zero ambiguity | Ship it |
| 80-94% | Correct but minor uncertainties | Ship with noted review areas |
| 60-79% | Required assumptions, edge cases unclear | Review before shipping |
| 40-59% | Significant uncertainty | Do NOT ship — clarify with human |
| 0-39% | Failed implementation | Report blockers, start over |

### Scoring Factors

| Factor | Weight | Description |
|--------|--------|-------------|
| All checks pass | 30% | lint + types + tests + format |
| Contract compliance | 25% | All sections implemented correctly |
| Convention match | 20% | Style matches template file |
| No assumptions made | 15% | Nothing guessed or inferred |
| Clean diff | 10% | Only specified files touched |

### Deductions
- Each assumption made: -5%
- Each lint warning (not error): -2%
- Missing test coverage: -5%
- File touched outside scope: -15%
- Pattern invented (not from repo): -10%
