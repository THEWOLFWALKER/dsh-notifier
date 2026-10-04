# dsh-notifier Agent Rules

## Current authority

- Work only on `dev`. Do not operate on `main`, force push, tag, create a GitHub Release, or publish to npm without separate final authorization.
- The current implementation brief is `docs/developer/rebuild-v015/README.md`, especially `IMPLEMENTER_PROMPT.md`, `PLAN.md`, `PRODUCT_UX.md`, `DESIGN_REVIEW.md`, `TEST_AUDIT.md`, `TEST_REVIEW_ADJUDICATION.md`, `HIGH_RISK_IMPLEMENTATION.md`, `DECISIONS.md`, and the issue crosswalk. Read it before editing. Historical plans and workstreams were removed from the working tree; git history remains available as evidence only.
- The user's current decisions override old docs and tests: private chat only, no positive group support, Native-first, old Advanced Console code deleted, no old-version compatibility or automatic state conversion; back up old state and guide users through reconfiguration, no Big Bang rewrite, no Store-wide async rewrite as a goal. dsh-im is a competitor and upstream contract reference, not the main project.
- `src/` is evidence of current behavior, not a product specification. Tests that merely mirror current behavior are not authority. Public upstream contracts require fixed-source fixtures; missing real-provider evidence is `unknown`.

## Implementation discipline

- Execute the five continuous stages in the taskpack. Finish each stage's focused tests, integration gate, adversarial review, and source-ID dispositions before moving to the next. Keep `docs/developer/rebuild-v015/PROGRESS.md` current with commits, tests, unresolved evidence, and next stage. Do not wait for routine product or architecture decisions; `DECISIONS.md` resolves them.
- Preserve proven provider protocol behavior and security invariants while deleting dead architecture. Every input admission, account authority, interaction transition, external effect, and durable claim must fail closed when its evidence is missing.
- No fake pass: local mocks verify fault handling, not real Host/provider/device compatibility. Do not let a bookkeeping failure turn an external success into reported failure or auto-retry an unknown outcome.
- Use behavior, fault, integration, and real DOM tests for contracts. Source grep is only a supplemental invariant. If an old test conflicts with the new product, replace or delete it with a reason in `TEST_AUDIT.md`; do not preserve a bug to keep a test green.
- User UI and user docs use simple action/result language. Show unavailable and unknown honestly, provide a recovery path, and keep internal IDs and infrastructure jargon out of daily flows.

## Repo and commits

- Start with `git status --short --branch`, `git log --oneline -5`, and the latest `origin/dev`; do not overwrite remote changes. Work and push only `dev`, without force push.
- All commits: Author `THEWOLFWALKER`, Committer `THEWOLFWALKER`, using the existing repository email for that identity.
- Do not commit credentials, state files, node_modules, generated logs, or user account evidence. Keep the working tree clean at each stage checkpoint.
- Before every final handoff, read `.agents/skills/neat-freak/SKILL.md` and reconcile current docs with actual behavior. The taskpack tracks implementation decisions; `CHANGELOG.md` records user-visible changes.

## Validation

Run focused tests for each changed module and its cross-layer caller. At stage gates run the relevant Node, DOM, package, channel, and Host checks. The final gate must include `npm test`, `npm run test:dom`, `npm run verify:release`, `node scripts/gen-channel-matrix.mjs --check`, `node scripts/verify-host-compat.mjs`, package dry-run/exports, and the taskpack's fault/UX/evidence requirements. A green count alone does not establish release readiness.
