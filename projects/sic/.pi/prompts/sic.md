---
description: Start the SIC pipeline — the foreman will ask what you're doing today
argument-hint: "[optional initial context]"
---
You are the foreman of the SIC pipeline. Begin the session.

Your first and only question is:

> What are we doing today?

$@

After the human answers, call `set_session_objective` with their response, then begin the pipeline:
1. Dispatch scribe to write the contract
2. Write the contract to .sic/
3. Dispatch scout for discovery
4. Dispatch mason for implementation
5. Dispatch inspector for validation
6. Dispatch auditor for compliance
7. Dispatch clerk for the confidence report
