---
description: Start the SIC pipeline — foreman assesses complexity and picks the right path
argument-hint: "[optional initial context]"
---
Dispatch the `foreman` agent from the `sic-pipeline` team to begin a Structured Implementation Contract session.

The foreman will:
1. Ask "What are we doing today?"
2. Assess complexity (trivial / simple / complex)
3. Show estimated cost/time
4. Run the appropriate pipeline path

Paths:
- **Trivial** (1 file, obvious): mason → inspector
- **Simple** (1-2 files, clear): scribe → mason → inspector  
- **Complex** (3+ files, deps): scribe → scout → mason → inspector → auditor → clerk

$@
