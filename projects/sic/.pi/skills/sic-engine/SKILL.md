---
name: sic-engine
description: Structured Implementation Contract execution framework v2. Multi-agent pipeline with complexity gating (trivial/simple/complex paths), parallel mason dispatch, YAML contracts, session lifecycle management, and programmatic retry. Human design, AI implement.
license: MIT
compatibility: Requires git. Works with any language project.
metadata:
  version: "2.0.0"
  author: "alphabril"
  philosophy: "Human design, AI implement"
allowed-tools: bash read grep find ls
---

# SIC Engine — Structured Implementation Contract Framework v2

An engineering execution framework where AI acts as a deterministic implementation compiler. Humans own architecture. AI owns syntax.

## What's New in v2

- **Complexity Gate**: Trivial/simple/complex paths — no more full pipeline for "add a function"
- **YAML Contracts**: Standard format, validated on write, no custom parsing
- **Parallel Mason**: Independent files process simultaneously (up to 4x faster)
- **Programmatic Retry**: Failed agents auto-retry with error context injected
- **Cost/Time Estimation**: See expected cost before confirming pipeline run
- **Session Cleanup**: `/sic-clean` command to manage accumulated sessions
- **Simplified Verdict**: PASS / NEEDS_REVIEW / FAIL (no fake percentages)
- **Reliable Spawning**: Works on NixOS, Bun, and non-standard PATH setups

## Philosophy

```
Developer intent
  → Complexity assessment (trivial? simple? complex?)
    → Appropriate pipeline path
      → YAML contracts per file
        → Parallel execution where possible
          → Validation + Verdict
```

## Architecture

### Complexity Paths

| Path | When | Agents |
|------|------|--------|
| **Trivial** | 1 file, no deps, obvious change | mason → inspector |
| **Simple** | 1-2 files, clear spec | scribe → mason → inspector |
| **Complex** | 3+ files, deps, discovery needed | scribe → scout → mason → inspector → auditor → clerk |

### Phase Agents

| # | Agent | Role |
|---|-------|------|
| 1 | **scribe** | Converses with human → produces per-file YAML contracts |
| 2 | **scout** | Discovers repo conventions at target paths |
| 3 | **mason** | Implements one .sic at a time (parallel for independent files) |
| 4 | **inspector** | Runs lint, types, format, tests |
| 5 | **auditor** | Git-based compliance verification |
| 6 | **clerk** | Produces PASS / NEEDS_REVIEW / FAIL verdict |

## Quick Start

### Start the pipeline:
```
/sic
```
The foreman asks "What are we doing today?", assesses complexity, then runs the appropriate path.

### Write a contract only (no execution):
```
/contract Add a notification service that sends emails
```

### Clean old sessions:
```
/sic-clean 30
```

## Contract Format (YAML)

See [Contract Format Reference](references/contract-format.md) for full spec.

```yaml
file: src/services/notification.ts
action: create
purpose: Notification service for email and push

depends_on: []

context: |
  New service needed by user controller.

modifications:
  - Create class NotificationService extending BaseService
  - Implement send() routing to correct channel
  - Implement getStatus() checking delivery log

location_hints: []

new_imports:
  - "import { BaseService } from './base'"

new_exports:
  - NotificationService

constraints:
  - follow neighboring services pattern
  - no external dependencies

done_when:
  - lint passes
  - types pass
  - exports added to index
```

## Parallel Execution

When `list_session_sics` identifies independent files (no mutual dependencies), they process simultaneously:

```
Group 1 (parallel): helpers.sic, utils.sic    ← no deps, run together
Group 2 (sequential): controller.sic           ← depends on group 1
```

Max concurrency: 4 simultaneous mason dispatches.

## Validation & Verdict

The clerk produces one of three verdicts:

| Verdict | Meaning | Action |
|---------|---------|--------|
| **PASS** ✅ | All checks pass, no assumptions | Ship it |
| **NEEDS_REVIEW** ⚠️ | Minor warnings, missing tests | Human reads flagged files |
| **FAIL** ❌ | Errors, violations, incomplete | Do NOT merge |

## References

- [Contract Format](references/contract-format.md) — full YAML specification
- [Validation Rules](references/validation-rules.md) — all harness stages and verdict logic
