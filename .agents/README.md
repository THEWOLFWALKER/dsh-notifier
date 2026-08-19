# Agent Coordination

This directory contains the tracked authority for active collaboration metadata. Together with `docs/memory/`, it records durable coordination facts; chat messages are never a source of project state. It is not imported by the plugin and must never contain credentials or runtime state.

## Workstream Protocol

1. Read `AGENTS.md`, `docs/KNOWLEDGE_BASE.md`, and `docs/memory/`.
2. Create `.agents/workstreams/<agent>-<topic>.md` from `TEMPLATE.md` before editing.
3. Declare owned files and validation commands. Keep ownership disjoint where possible.
4. Update the same workstream file with tests and handoff notes.
5. Mark it `done` before the parent agent integrates the commit.

One file per workstream avoids a shared-board merge hotspot. Remove temporary workstream records after their durable conclusions are captured in docs or memory.
