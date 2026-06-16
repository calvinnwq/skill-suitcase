# Release Readiness

This checklist records the release/public-readiness decisions for Linear
`NGX-387`.

Skill Suitcase is already release-managed for GitHub tags and release notes.
Public distribution remains deliberate, and npm publishing is manual.

## Current Release State

- GitHub releases are managed by Release Please.
- The CLI bin name is `suitcase`.
- The package name is `skill-suitcase`.
- `npm view skill-suitcase` returned 404 on 2026-06-16, so the package name
  appears unclaimed at that time.
- CI runs `pnpm test` on pull requests and pushes to `main`.

## When To Merge Release Please PRs

Merge a Release Please PR only when all of these are true:

1. The PR changes only release metadata: `package.json`,
   `.release-please-manifest.json`, and `CHANGELOG.md`.
2. The version matches the intended public story for the repo.
3. GitHub CI is green, or the equivalent local verification has been run and
   the missing CI signal is understood.
4. The release notes accurately describe merged behavior and do not imply npm
   publishing.
5. No active implementation PR should land first for the same release train.

For the first public release, prefer a deliberate `0.x` release. Do not infer
`1.0.0` from the first generated Release Please PR unless Calvin explicitly
chooses a stable public API promise.

## npm Package And Bin Policy

Recommended package policy:

- Keep the npm package name as `skill-suitcase`.
- Keep the bin command as `suitcase`.
- Keep an explicit `files` whitelist in `package.json` so npm publishes only the
  runtime CLI, docs, changelog, and package metadata.
- Do not add npm publish automation until there is a public support boundary,
  install guide, and rollback story for bad publishes.
- Before publishing, reserve/check the package name again and run
  `npm pack --dry-run` to inspect the publish payload.

`skill-suitcase` is the right package identity because it matches the repo and
project name. `suitcase` is the right command because it is short enough for
daily use and avoids the awkward `skill-suitcase ...` command shape.

## GitHub Visibility And Rulesets

While the repo is private, GitHub branch protection/ruleset behavior may depend
on the account plan. If private-repo rulesets are unavailable, use this fallback:

- keep PR review/merge discipline manual
- require local verification in the PR body
- keep CI enabled even if it is not a hard merge gate
- do not rely on branch protection as the only release safety mechanism

If the repo becomes public, enable normal rulesets before treating it as a
public OSS project:

- require the CI `test` job on PRs
- require branches to be up to date before merge when practical
- restrict direct pushes to `main`
- keep Release Please write permissions scoped to the release workflow

Making the repo public is a separate approval. This checklist does not approve
that one-way visibility change.

## Safe Local Workflows

Read-only commands are safe first checks. They must not create install roots,
runtime homes, receipts, symlinks, or source repo files.

```bash
pnpm build

SRC="$HOME/repos/skills"
CLI="$PWD/dist/src/cli.js"

node "$CLI" import --source "$SRC" --json
node "$CLI" validate --source "$SRC" --strict --json
node "$CLI" targets --source "$SRC" --json
node "$CLI" plan --source "$SRC" --target codex --json
node "$CLI" status --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
node "$CLI" diff --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
```

Staging workflows are the next step. They may create an artifact under an
explicit temporary output directory, but still do not write into agent homes.

```bash
TMP="$(mktemp -d /tmp/skill-suitcase-pack.XXXXXX)"
node "$CLI" pack --source "$SRC" --target codex --codex-home "$HOME/.codex" --output "$TMP" --json
find "$TMP" -maxdepth 3 -type f | sort
rm -rf "$TMP"
```

Live mutation requires explicit approval input and should start in disposable
fixtures or a clearly approved target:

```bash
node "$CLI" apply --source "$SRC" --target codex --codex-home "$HOME/.codex" --artifact /path/to/skill-suitcase-bundle.json --json
node "$CLI" apply --source "$SRC" --target codex --codex-home "$HOME/.codex" --lock /path/to/plan-lock.json --mode symlink --json
node "$CLI" promote --source "$SRC" --target-skill "$HOME/.codex/skills/new-skill" --dry-run --json
```

Do not run live `apply`, `track`, `rollback`, or `promote --apply` against
Calvin's real agent homes without explicit approval for the target and mode.

## Calvin-Local Versus Portable Support

Portable support:

- catalog layouts with `skill-suitcase.yaml`
- target overrides such as `--codex-home`, `--codex-skills`, and
  `--claude-skills`
- read-only planning, diffing, status, target discovery, validation, and import
- staging bundles and plan locks
- copy and symlink apply modes when explicitly approved
- receipts, status, and rollback for Skill Suitcase-managed installs

Calvin-local examples:

- `/Users/ngxcalvin/repos/skills`
- `/Users/ngxcalvin/repos/skill-suitcase`
- `/Users/ngxcalvin/.openclaw/...`
- OpenClaw Kody Codex home paths
- live adoption state on Calvin's machine

Docs may show Calvin-local paths as concrete examples, but portable docs should
pair them with `$HOME`, `/path/to/skills-catalog`, or explicit override examples.
Portable behavior must not depend on Calvin's machine paths being present.

## Public Readiness Checklist

Before a public announcement or npm publish:

- README includes safe read-only and staging workflows.
- CONTRIBUTING explains Release Please and npm publish boundaries.
- CI is green on the public default branch.
- `npm pack --dry-run` has been inspected.
- Package name and bin policy are still correct.
- The package `files` whitelist excludes local workflow artifacts, tests, and
  private agent state.
- GitHub visibility/ruleset decision is explicit.
- Support boundary explains Calvin-local paths versus portable config.
- No docs imply `skills.sh` runtime delegation is part of the managed installer.

## Current Decision

Skill Suitcase is ready for manual npm publishing after package tarball
inspection and npm authentication are confirmed. Automated npm publishing is not
enabled.
