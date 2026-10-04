# Current handoff

The working branch is `dev`. This checkout implements the v0.15 private-only, Native-first rebuild in [rebuild-v015](rebuild-v015/README.md). `docs/developer/rebuild-v015/PROGRESS.md` records stage decisions, checks and evidence limits.

## Current behavior

- Private access requires an explicit `(channel, accountId, userId)` identity and private conversation evidence. Group conversations and missing identity evidence fail closed.
- The standalone Admin Web Console, recovery server and legacy channel overlay are retired. Daily controls use the admitted DSH Host Native connection. There is no dsh-im one-click importer; it was skipped at the user's direction.
- State older than schema 15 is backed up offline with restrictive permissions, then reset for explicit reconfiguration. Old credentials, identities, routes and bindings are not loaded into the fresh state.
- The public notifier contract is v0.8. Cloud recovery requires an explicit retry after a failed or uncertain deployment effect.

## Evidence limits

Fixed source fixtures cover the checked DSH Host and dsh-im interfaces. They do not prove a real Host boot, real provider delivery, real device interaction or Cloud account effects. Those remain unknown until exercised with the corresponding live systems.

## Local checks

The final v0.15 results are recorded in `rebuild-v015/PROGRESS.md`. Re-run the required project gates before preparing another change. A passing local suite is not a substitute for real Host/provider/device evidence.

Only `dev` may be changed or pushed. Do not force-push, change `main`, tag, create a GitHub Release or publish to npm without separate authorization.
