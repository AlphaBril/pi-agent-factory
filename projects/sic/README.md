# SIC — Structured Implementation Contract Engine v2

An engineering execution framework where AI acts as a deterministic implementation compiler, not an architect.

**Human design. AI implement.**

## What Is This?

SIC is a multi-agent pipeline that turns your implementation intent into predictable, reviewable code. Instead of giving AI free reign, you define a strict contract and a team of specialized agents executes it mechanically.

## What's New in v2

| Improvement | Before | After |
|---|---|---|
| **Complexity Gate** | Full 7-agent pipeline for everything | Trivial/Simple/Complex paths |
| **Contract Format** | Bespoke KEY: VALUE format | Valid YAML (standard parsing) |
| **Parallel Execution** | Strictly sequential | Independent files run simultaneously |
| **Retry Logic** | LLM-dependent ("retry once") | Programmatic with error injection |
| **Cost Estimation** | None — surprise costs | Shows estimate before running |
| **Session Cleanup** | Accumulates forever | `/sic-clean` command |
| **Verdict System** | Arbitrary 0-100% scores | PASS / NEEDS_REVIEW / FAIL |
| **Process Spawning** | Naive `spawn("pi")` | Reliable discovery (NixOS/Bun safe) |
| **Subprocess Isolation** | Extensions loaded recursively | `--no-extensions` prevents recursion |
| **Branch Navigation** | State goes stale | `session_tree` event handled |

## Complexity Paths

```
You → "What are we doing today?"
  → Foreman assesses complexity
    → TRIVIAL (1 file, obvious)  → mason → inspector
    → SIMPLE (1-2 files, clear)  → scribe → mason → inspector
    → COMPLEX (3+ files, deps)   → full pipeline below
```

### Full Pipeline (Complex Path)

```
Foreman (overseer)
  → Scribe (writes per-file YAML contracts with you)
    → Scout (discovers conventions at each target)
      → Mason (implements files — parallel when independent)
        → Inspector (lint, types, tests)
          → Auditor (git-based compliance per .sic)
            → Clerk (PASS / NEEDS_REVIEW / FAIL verdict)
```

## Key Innovation: Per-File YAML Contracts

Each contract is **one YAML file per target file**:

```yaml
file: libs/front/tools/helpers.ts
action: modify
purpose: Add a sum utility function

depends_on: []

modifications:
  - Add function sum(a: number, b: number): number

location_hints:
  - After the last exported function (line 42)

new_imports: []
new_exports:
  - sum

constraints:
  - do not modify existing functions
  - match neighboring function style

done_when:
  - sum is exported and callable
  - types pass
```

### Why YAML?

- Standard parsers in every language (no custom regex)
- Validated on write (invalid YAML is rejected immediately)
- Schema-capable for future tooling
- Familiar to developers

### Parallel Groups

Files without dependencies between them process simultaneously:

```
Group 1 (parallel): helpers.sic, utils.sic     ← 2 masons run at once
Group 2 (sequential): controller.sic            ← depends on group 1
```

## Installation

Copy the `.pi/` folder into any project:

```bash
cp -r .pi /path/to/your/project/
```

## Requirements

- Pi coding agent
- Git (auditor uses `git diff` as source of truth)
- Your project's lint/type/test tooling (auto-detected)

## Usage

### Start the pipeline:
```
/sic
```
The foreman asks "What are we doing today?" → assesses complexity → runs appropriate path.

### Just write contracts (no execution):
```
/contract Add a caching layer to the user service
```

### Clean old sessions:
```
/sic-clean 30
```

### Run with the team directly:
```
pi --agent sic-pipeline/foreman
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+X` | Abort pipeline (after current agent finishes) |
| `F2` | Skip current agent output |
| `F3` | Show pipeline progress + elapsed time |

## Session Folders

Each run creates a session folder:
```
.pi/sessions/<session-name>/
```

Inside, the scribe writes per-file `.sic` contracts mirroring the repo structure:
```
.pi/sessions/add-auth-middleware/
├── src/middleware/auth.sic           ← ACTION: create
├── src/middleware/index.sic          ← ACTION: modify (add export)
├── src/routes/protected.sic         ← ACTION: modify (add middleware)
└── tests/middleware/auth.test.sic   ← ACTION: create
```

Session folders are:
- **Traceable** — committed to repo (optional, see `.gitignore`)
- **Reviewable** — code reviewers see what was asked vs what was built
- **Reproducible** — re-run the same session contracts with a different model
- **Cleanable** — `/sic-clean 30` removes sessions older than 30 days

## Verdict System

No more fake percentages. Three clear verdicts with direct actions:

| Verdict | When | Action |
|---------|------|--------|
| **PASS** ✅ | All checks pass, no assumptions | Ship it |
| **NEEDS_REVIEW** ⚠️ | Minor warnings, missing tests, 1-2 assumptions | Human reads flagged files |
| **FAIL** ❌ | Lint/type errors, scope violations, incomplete contracts | Do NOT merge |

## Pipeline Agents

| Agent | Role | Boundary |
|-------|------|----------|
| **Foreman** | Overseer — assesses complexity, dispatches | Never implements |
| **Scribe** | Converses → produces per-file YAML contracts | Never implements |
| **Scout** | Discovers conventions at each target path | Read-only |
| **Mason** | Implements ONE .sic at a time (parallel OK) | One file per dispatch |
| **Inspector** | Runs lint, types, format, tests | Never fixes code |
| **Auditor** | Git-based compliance per .sic contract | Read-only |
| **Clerk** | PASS / NEEDS_REVIEW / FAIL verdict | Never modifies |

## Cost & Time Estimation

Before running, the foreman shows expected overhead:

```
═══ PIPELINE ESTIMATE ═══
Agents to dispatch: scribe → scout → mason → inspector → auditor → clerk
Mason dispatches: 3 file(s)
Total LLM calls: ~8

Estimated time: 68-160 seconds
Estimated token cost: ~$0.098
═══ END ESTIMATE ═══
```

## Design Principles

| Principle | Implementation |
|-----------|---------------|
| Human owns architecture | AI never makes design decisions |
| Per-file atomicity | One .sic per file, one mason dispatch per .sic |
| Right-size the pipeline | Complexity gate picks appropriate path |
| Parallel when possible | Independent files run simultaneously |
| Fail fast, retry smart | Programmatic retry with error context |
| Discovery before implementation | Scout maps terrain, mason follows |
| Git is truth | Auditor uses `git diff`, not claims |
| Verdicts not scores | PASS/REVIEW/FAIL, not arbitrary percentages |
| YAML not bespoke | Standard format, validated on write |
| Clean up after yourself | Session lifecycle management |

## Project Structure

```
.pi/
├── agents/
│   ├── teams.yaml
│   └── sic-pipeline/
│       ├── foreman.md      ← orchestrator with complexity gate
│       ├── scribe.md       ← YAML contract writer
│       ├── scout.md        ← read-only reconnaissance
│       ├── mason.md        ← mechanical implementer
│       ├── inspector.md    ← proper tool detection
│       ├── auditor.md      ← git-based compliance
│       └── clerk.md        ← 3-level verdict
├── extensions/
│   └── sic-pipeline.ts    ← all tools + parallel dispatch
├── prompts/
│   ├── sic.md             ← start pipeline
│   ├── contract.md        ← write contracts only
│   └── sic-clean.md       ← session cleanup
├── sessions/              ← created at runtime
│   ├── .gitignore
│   ├── README.md
│   └── <session-name>/
│       └── <mirrored-repo-structure>.sic
└── skills/
    └── sic-engine/
        ├── SKILL.md
        ├── references/
        │   ├── contract-format.md   ← YAML spec
        │   └── validation-rules.md  ← 3-level verdict logic
        ├── scripts/
        │   ├── validate.sh          ← proper tool detection
        │   └── compliance-check.sh  ← YAML-aware
        └── templates/
            ├── bug-fix.sic          ← YAML templates
            ├── refactor.sic
            ├── new-module.sic
            └── add-method.sic
```

## License

MIT
