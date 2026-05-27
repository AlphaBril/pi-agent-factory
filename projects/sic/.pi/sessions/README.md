# SIC Sessions

This directory holds per-run session folders created by the SIC pipeline.

Each session folder mirrors the repo structure with `.sic` contract files (YAML format).

## Structure

```
.pi/sessions/
├── add-sum-to-helpers/
│   ├── libs/front/tools/helpers.sic
│   └── app/api/controller/contract.sic
├── fix-auth-bug/
│   └── src/middleware/auth.sic
└── ...
```

## Lifecycle

- **Created** automatically when the foreman starts a pipeline run
- **Committed** to git for traceability (shows implementation intent)
- **Cleaned** via `/sic-clean` when they accumulate

## Cleanup

```
/sic-clean 30
```

Shows sessions older than 30 days and offers to delete them.
