# Structured Implementation Contract — Format Reference (v2 YAML)

## Format

Contracts are **valid YAML** files with a `.sic` extension. This enables standard parsing (no custom regex) and validation via schema.

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `file` | string | Exact relative path of the target file |
| `action` | enum | `create` or `modify` |
| `purpose` | string | Single sentence: what this contract achieves for this file |
| `modifications` | list | Specific changes to make (precise, ordered) |
| `constraints` | list | Hard rules that must not be violated |
| `done_when` | list | Verifiable acceptance criteria |

## Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `depends_on` | list | Other `.sic` paths that must complete first |
| `context` | string | Why this file is being changed (multi-line with `\|`) |
| `location_hints` | list | Where in the file: line numbers, function names |
| `new_imports` | list | Import statements to add |
| `new_exports` | list | Exports to add |

## Example: Modify

```yaml
file: libs/front/tools/helpers.ts
action: modify
purpose: Add a sum utility function

depends_on: []

context: |
  The objective requires a sum function used by the contract controller.
  This file already contains other math utilities.

modifications:
  - Add function sum(a: number, b: number): number that returns a + b
  - Add sum to the named exports

location_hints:
  - Add after the last existing exported function (line 42)
  - Export at the bottom with other exports (line 67)

new_imports: []

new_exports:
  - sum

constraints:
  - do not modify existing functions
  - match neighboring function style (arrow function, no JSDoc)
  - preserve existing formatting
  - no default export

done_when:
  - sum is exported and callable
  - types pass (npx tsc --noEmit)
  - existing tests still pass
```

## Example: Create

```yaml
file: src/services/notification.ts
action: create
purpose: Notification service that sends emails and push notifications

depends_on: []

context: |
  New service needed by the user controller.
  Must follow the same pattern as src/services/email.ts.

modifications:
  - Create class NotificationService extending BaseService
  - Implement send(notification) method routing to correct channel
  - Implement getStatus(id) method checking delivery log
  - Add named export

location_hints: []

new_imports:
  - "import { BaseService } from './base'"
  - "import type { Notification } from '../types'"

new_exports:
  - NotificationService

constraints:
  - follow pattern from src/services/email.ts exactly
  - no external dependencies beyond what's imported
  - error handling must match sibling services pattern
  - no console.log

done_when:
  - lint passes
  - types pass
  - exports added to src/services/index.ts
  - can be instantiated with mock dependencies
```

## Example: With Dependencies

```yaml
file: app/api/controller/contract.ts
action: modify
purpose: Import and use sum() from helpers at the calculation point

depends_on:
  - libs/front/tools/helpers.sic

context: |
  After helpers.sic adds sum(), this file uses it to replace
  the manual a + b at line 54.

modifications:
  - Add import for sum from helpers
  - Replace "const total = a + b" at line 54 with "const total = sum(a, b)"

location_hints:
  - Import section: after line 3 (last existing import)
  - Line 54: inside calculateTotal() function

new_imports:
  - "import { sum } from '@libs/front/tools/helpers'"

new_exports: []

constraints:
  - do not modify other logic in this controller
  - preserve existing error handling
  - do not change function signatures

done_when:
  - sum is imported and used
  - types pass
  - existing behavior unchanged (same output for same input)
```

## Validation

The `write_file_sic` tool validates:
1. Content is valid YAML (parse without errors)
2. All required fields are present
3. `action` is either "create" or "modify"

Invalid contracts are rejected with an error message.

## Why YAML?

Previous versions used a bespoke `KEY: value` format requiring custom regex parsing. YAML provides:
- Standard parsers in every language
- Native list/string/multiline support
- Schema validation capability
- Familiar to developers
- No ambiguous parsing edge cases
