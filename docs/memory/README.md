# Project Memory

This directory is a compact, platform-neutral memory layer for future agents. It is not a second code specification and it is not a chronological chat log.

## Files

- `project-state.md`: current baseline, validation evidence, artifact status, and next release gate.
- `decisions.md`: durable decisions that would be expensive or dangerous to rediscover.
- `risks.md`: recurring failure modes and validation gaps that remain relevant.

## Editing Rules

- Use absolute dates (`YYYY-MM-DD`), never relative time.
- One durable fact per entry; merge updates instead of appending duplicates.
- Delete completed temporary tasks and superseded decisions.
- Keep each file under roughly 100 lines. Put detailed mechanisms in `docs/architecture.md` or source comments.
- Every memory entry must point to an authoritative source file or commit when possible.
- If memory conflicts with code/tests, code/tests win and the memory file must be corrected in the same change.
