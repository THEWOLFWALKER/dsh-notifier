# Workstream: plugin-security-review

- Agent: `root`
- Branch: `codex/knowledge-baseline`
- Status: done
- Scope: Document and validate the threat model for hostile DSH plugins consuming dsh-notifier, with a separate remediation plan.
- Plan: 1. Confirm notifier evidence and official host assumptions. 2. Write attack review and fix plan. 3. Run adversarial cross-review. 4. Update durable risk and knowledge maps. 5. Run release/document validation and commit.
- Owned files: `docs/security/PLUGIN_ATTACK_REVIEW.md`, `docs/security/PLUGIN_SECURITY_FIX_PLAN.md`, `docs/memory/risks.md`, `docs/KNOWLEDGE_BASE.md`, `.agents/workstreams/plugin-security-review.md`
- Do not touch: Source modules and files reserved by other workstreams.
- Validation: `npm test`, `node scripts/verify-release.mjs`, `node scripts/gen-channel-matrix.mjs --check`, `node --check src/index.mjs`, `git diff --check`
- Adversarial review: Challenge exploit prerequisites, distinguish same-process host compromise from notifier defects, and map every finding to an actionable owner.
- Handoff: Attack review and independent fix plan written; official host assumptions verified. Pending final validation commit.
