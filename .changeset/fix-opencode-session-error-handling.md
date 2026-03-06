---
"@stoneforge/smithy": patch
---

Fix OpenCode session creation error handling: check result.error before result.data on session.create, session.get, and session.abort so actual server errors are surfaced. Pass working directory as query parameter on session.create for newer OpenCode server versions.
