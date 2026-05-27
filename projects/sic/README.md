# SIC — Structured Implementation Contract Engine

An engineering execution framework where AI acts as a deterministic implementation compiler, not an architect.

**Human design. AI implement.**

## What Is This?

SIC is a multi-agent pipeline that turns your implementation intent into predictable, reviewable code. Instead of giving AI free reign, you define a strict contract and a team of specialized agents executes it mechanically.

```
You → "What are we doing today?"
  → Foreman (overseer)
    → Scribe (writes per-file contracts with you)
      → Scout (discovers conventions at each target)
        → Mason (implements one file at a time)
          → Inspector (lint, types, tests)
            → Auditor (git-based compliance per .sic)
              → Clerk (confidence report)
```

No parallelism. Each phase waits. Each agent has hard boundaries.

## Key Innovation: Per-File Contracts

Unlike monolithic task descriptions, SIC produces **one contract per file**. This means:

- The mason processes files **one at a time** — no context overflow
- Each file has explicit **dependencies** (execution order)
- The auditor can verify **each file individually** against its contract
- Any model can handle it — even weak ones — because scope is minimal

### Example

**Objective:** "Add a sum function to helpers and use it in the contract controller"

The scribe produces:
```
.pi/sessions/add-sum/
├── libs/front/tools/helpers.sic      ← "add sum() function"
└── app/api/controller/contract.sic   ← "import and use sum() at line 54"
```

The mason reads `helpers.sic` first (no dependencies), then `contract.sic` (depends on helpers).

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

### Start the full pipeline:
```
/sic
```
The foreman asks "What are we doing today?" → you describe → pipeline runs.

### Just write contracts (no execution):
```
/contract Add a caching layer to the user service
```

### Run with the team directly:
```
pi --agent sic-pipeline/foreman
```

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
- **Traceable** — committed to repo, shows implementation intent
- **Reviewable** — code reviewers see what was asked vs what was built
- **Reproducible** — re-run the same session contracts with a different model
- **Atomic** — each .sic is self-contained, one file, one concern

## Per-File SIC Format

```
FILE: libs/front/tools/helpers.ts
ACTION: modify
PURPOSE: Add a sum utility function

DEPENDS_ON:
- none

CONTEXT:
The objective requires a sum function used by the contract controller.

MODIFICATIONS:
- Add function sum(a: number, b: number): number that returns a + b

LOCATION_HINTS:
- Add after the last existing exported function

NEW_IMPORTS:
- none

NEW_EXPORTS:
- sum (named export)

CONSTRAINTS:
- do not modify existing functions
- match neighboring function style
- preserve existing formatting

DONE_WHEN:
- sum is exported and callable
- types pass
```

## Pipeline Agents

| Agent | Role | Boundary |
|-------|------|----------|
| **Foreman** | Overseer — dispatches sequentially | Never implements |
| **Scribe** | Converses → produces per-file .sic contracts | Never implements |
| **Scout** | Discovers conventions at each target path | Read-only |
| **Mason** | Implements ONE .sic at a time | One file per dispatch |
| **Inspector** | Runs lint, types, format, tests | Never fixes code |
| **Auditor** | Git-based compliance per .sic contract | Read-only |
| **Clerk** | Confidence score from all reports | Never modifies |

## How the Mason Avoids Context Overflow

The foreman dispatches the mason **once per .sic file**, in dependency order:

```
1. dispatch mason → helpers.sic      (no deps, goes first)
2. dispatch mason → contract.sic     (depends on helpers.sic)
3. dispatch mason → auth.test.sic    (depends on auth.sic)
```

Each dispatch gives the mason:
- The single .sic contract for one file
- The scout's report for that directory
- Nothing else

This keeps context minimal and focused. Even GPT-3.5 could handle a single-file contract.

## Design Principles

| Principle | Implementation |
|-----------|---------------|
| Human owns architecture | AI never makes design decisions |
| Per-file atomicity | One .sic per file, one mason dispatch per .sic |
| Discovery before implementation | Scout maps terrain, mason follows |
| Git is truth | Auditor uses `git diff`, not claims |
| Confidence not "done" | Clerk scores 0-100%, never says "finished" |
| Traceable | Session folders committed to repo |
| Provider-agnostic | Tasks simple enough for any model |
| No scope creep | Auditor catches unauthorized changes per-file |

## Project Structure

```
.pi/
├── agents/
│   ├── teams.yaml
│   └── sic-pipeline/
│       ├── foreman.md
│       ├── scribe.md
│       ├── scout.md
│       ├── mason.md
│       ├── inspector.md
│       ├── auditor.md
│       └── clerk.md
├── extensions/
│   └── sic-pipeline.ts
├── prompts/
│   ├── sic.md
│   └── contract.md
├── sessions/              ← created at runtime
│   └── <session-name>/
│       └── <mirrored-repo-structure>.sic
└── skills/
    └── sic-engine/
        ├── SKILL.md
        ├── references/
        ├── scripts/
        └── templates/
```

## License

MIT
