# Versioning And Release Integrity

This project has had version-split incidents before. The rule is now: one engineering tree, one package version, one release gate.

## Canonical Layers

1. `package.json.version` is the semantic version authority.
2. `CHANGELOG.md` must contain the matching `## [version]` entry.
3. `src/admin/ui.mjs` must display the same version.
4. README badges/body, `HANDOFF.md`, and `dshQuality.testCount` must agree on the documented test baseline.
5. `package.json.files` defines the npm payload. The engineering archive is not the npm payload.

`node scripts/verify-release.mjs` checks these invariants. A release is blocked when it fails.

## Commit Protocol

- Import or recover a source baseline in its own commit.
- Make runtime changes, tests, docs, and metadata in logically separate commits where practical.
- Do not publish from a dirty tree or from a `file:` installation.
- Use `codex/<topic>` branches for agent work; merge only after the parent agent reviews the diff and test result.
- Tag the exact release commit after the guard passes. Never retag a version with different source contents.

## Release Gate

```text
git status --short --branch          # must be clean before publish
npm test                             # full behavior contract
node scripts/verify-release.mjs      # version/docs/payload invariants
node scripts/gen-channel-matrix.mjs --check
npm pack --dry-run --json            # inspect actual npm file list
```

After publishing, verify in a disposable host profile, not only in the source tree:

```text
npm view dsh-notifier version
npm ls dsh-notifier
dsh plugin add dsh-notifier@<version> --profile <profile>
```

Restart DSH and verify the UI version, startup assembly markers, one outbound test, and one inbound command. A registry install is the real-machine baseline; a local `file:` install is for temporary development only.

## Artifact Comparison

The repository archive may include contributor-only files such as `HANDOFF.md`, `ADAPTER.md`, design notes, screenshots, and CI. The npm package intentionally excludes those. Compare manifests and hashes before release, but do not make the npm archive the source of truth.

## Version Bump Checklist

- Update `package.json.version`.
- Add a top CHANGELOG entry describing behavior, tests, and security/review identifiers when relevant.
- Update the admin UI version string.
- Run the full test suite and update `dshQuality.testCount` only from the actual runner summary.
- Synchronize README badges/body and `HANDOFF.md` count references.
- Run the release guard and channel matrix check.
- Record the final commit, package version, npm registry version, and any real-device gap in `docs/memory/project-state.md`.
