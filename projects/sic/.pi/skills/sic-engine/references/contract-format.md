# Structured Implementation Contract — Format Reference

## Required Sections

| Section | Required | Type | Description |
|---------|----------|------|-------------|
| TASK | ✓ | string | Action verb: implement, create, add, modify, extract, fix |
| TARGET | ✓ | path | Directory where work happens |
| CREATE | ✓ | list | Artifact names to create |
| PURPOSE | ✓ | string | Single sentence of intent |
| CONSTRAINTS | ✓ | list | Hard rules that must not be violated |
| DONE_WHEN | ✓ | list | Verifiable acceptance criteria |

## Optional Sections

| Section | Type | Description |
|---------|------|-------------|
| EXTENDS | string | Base class to extend |
| IMPLEMENTS | list | Interfaces to implement |
| PARAMS | list | Constructor or function parameters (name: type) |
| PUBLIC_METHODS | list | API surface to expose |
| BEHAVIOR | list | Ordered step-by-step logic |
| OVERRIDES | list | Methods to override from base |
| PRIVATE_METHODS | list | Internal methods (not part of public API) |
| DEPENDENCIES | list | Required imports or packages |
| TESTS | list | Test cases to create |
| AUTO | boolean | If true, skip confirmation between phases |

## Formatting Rules

1. Section headers are UPPERCASE followed by colon: `SECTION:`
2. Values can be inline: `TASK: implement_agent`
3. Or as list items below the header:
   ```
   PARAMS:
   - name: string
   - age: number
   ```
4. List items start with `- ` (dash space)
5. Type annotations use colon: `name: type`
6. Descriptions use em-dash: `method() — what it does`
7. Blank lines between sections are optional but recommended

## BEHAVIOR Section Best Practices

BEHAVIOR steps should be:
- **Ordered** — execute in this exact sequence
- **Specific** — no vague "handle errors appropriately"
- **Atomic** — one action per step
- **Verifiable** — you can check if it was done

Good:
```
BEHAVIOR:
- read config from env var DATABASE_URL
- parse URL into host, port, database, user, password
- create connection pool with max 10 connections
- set idle timeout to 30 seconds
- export pool as default export
```

Bad:
```
BEHAVIOR:
- set up the database connection properly
- handle all edge cases
- make it performant
```

## CONSTRAINTS Section

Always include these baseline constraints:
```
CONSTRAINTS:
- follow lint rules
- follow neighboring file style
- no new abstractions
- no refactoring existing code
- no unrelated edits
```

Add specific constraints as needed:
```
- no external dependencies
- max 100 lines
- no async/await (use callbacks)
- must be backwards compatible
- do not modify public API of existing files
```

## DONE_WHEN Section

Must be machine-verifiable where possible:
```
DONE_WHEN:
- lint passes (`npm run lint`)
- types pass (`npx tsc --noEmit`)
- tests pass (`npm test -- --testPathPattern=agent`)
- exports added to index.ts
- no console.log statements
```

## Example: Full Contract

```
TASK: implement_service

TARGET: src/services

CREATE: NotificationService

PURPOSE: Send notifications via email and push channels

EXTENDS: BaseService

IMPLEMENTS:
- Notifier
- Configurable

PARAMS:
- emailClient: EmailClient
- pushClient: PushClient
- config: NotificationConfig

PUBLIC_METHODS:
- send(notification: Notification) — route to correct channel and send
- getStatus(id: string) — check delivery status
- retry(id: string) — retry failed notification

BEHAVIOR:
- validate notification schema on send()
- determine channel from notification.type
- call emailClient.send() or pushClient.send()
- store result in notification log
- return delivery receipt with ID
- getStatus queries notification log by ID
- retry fetches original notification and re-calls send()

OVERRIDES:
- initialize() — set up email and push clients
- shutdown() — flush pending notifications

CONSTRAINTS:
- follow lint rules
- follow neighboring services style
- no new abstractions
- no refactor
- no external dependencies beyond what's imported
- error handling must match sibling services pattern
- no retry loops (single attempt, return failure)

DONE_WHEN:
- lint passes
- types pass
- exports added to src/services/index.ts
- NotificationService can be instantiated with mock clients
```
