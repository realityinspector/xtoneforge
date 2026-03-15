---
"@stoneforge/smithy": minor
---

Add message fallback routing for offline directors. When a director is offline and has unread inbox messages, route those messages to another running director as a fallback. Each message is consumed exactly once.
