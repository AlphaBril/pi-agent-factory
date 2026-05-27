---
name: sic-engine
description: Structured Implementation Contract execution framework. Multi-agent pipeline where a foreman dispatches sequential phases — scribe, scout, mason, inspector, auditor, clerk — to achieve deterministic AI implementation under human architecture. Use when implementing features with strict contracts.
license: MIT
compatibility: Requires git. Works with any language project.
metadata:
  version: "2.0.0"
  author: "alphabril"
  philosophy: "Human design, AI implement"
allowed-tools: bash read grep find ls
---

# SIC Engine — Structured Implementation Contract Framework

An engineering execution framework where AI acts as a deterministic implementation compiler. Humans own architecture. AI owns syntax.

## Philosophy

```
Developer intent
  → Structured Implementation Contract
    → Repository Discovery
      → Deterministic AI Execution
        → Validation Harness
          → Confidence Report
```

## Architecture

The pipeline is orchestrated by the **foreman** — a sequential dispatcher that calls 6 phase agents one at a time:

| # | Agent | Role |
|---|-------|------|
| 1 | **scribe** | Converses with human → produces the SIC |
| 2 | **scout** | Discovers repo conventions at target path |
| 3 | **mason** | Implements the SIC mechanically |
| 4 | **inspector** | Runs lint, types, format, tests |
| 5 | **auditor** | Git-based compliance verification |
| 6 | **clerk** | Produces confidence report |

No parallelism. Each phase waits for the previous to complete.

## Quick Start

### Start the full pipeline:
```
/sic
```
The foreman will ask: "What are we doing today?"

### Write a contract only (no execution):
```
/contract Add a notification service that sends emails and push notifications
```

## Contract Format

See [Contract Format Reference](references/contract-format.md) for full spec.

Example:
```
TASK: implement_agent

TARGET: brain/agents

CREATE:
- SummarizeAgent

PURPOSE: Summarize document vectors

EXTENDS: BaseAgent

PARAMS:
- title: string
- path: string
- vectors: Vector[]

PUBLIC_METHODS:
- formatContent() — format vectors into readable text

BEHAVIOR:
- iterate vectors in reading order
- extract text from each vector
- concatenate text respecting totalTokens limit
- use countTokens() to track token usage

OVERRIDES:
- computeCompletion()

CONSTRAINTS:
- follow lint rules
- follow neighboring agents style
- no abstractions
- no refactor
- no unrelated edits

DONE_WHEN:
- lint passes
- types pass
- exports added to index
```

## Contract Files

Contracts are written to `.sic/<task-name>.sic` in the repo. They serve as:
- Implementation intent trace
- Review artifact (what was asked vs what was built)
- Reproducibility record (same contract → same output)

## Validation Scripts

```bash
# Run the validation harness
./scripts/validate.sh --path <target-dir> --files <created-files>

# Check contract compliance
./scripts/compliance-check.sh --contract .sic/<name>.sic --implementation <files>
```

## Key Principles

1. **Human owns architecture** — AI never makes design decisions
2. **Discovery before implementation** — AI adapts to the repo, never invents patterns
3. **Contracts are law** — literal compliance only
4. **Git is truth** — compliance auditor uses git diff, not claims
5. **Confidence, not "done"** — every output is a probability, not a boolean
6. **Trace everything** — contracts in repo, reports in session

## References

- [Contract Format](references/contract-format.md) — full SIC specification
- [Validation Rules](references/validation-rules.md) — all harness stages and scoring
