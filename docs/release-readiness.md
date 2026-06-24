# Release Readiness

This checklist records the release/public-readiness decisions for Linear
`NGX-387`.

Skill Suitcase is release-managed for GitHub tags, release notes, and npm
publication. Release Please remains the release authority; npm publication runs
only after Release Please creates a GitHub release.

## Current Release State

- GitHub releases are managed by Release Please.
- The CLI bin name is `skill-suitcase`.
- The package name is `skill-suitcase`.
- `skill-suitcase@0.8.0` is published on npm, and `latest` points to `0.8.0`
  as of 2026-06-20.
- The `v0.8.0` release includes the receipt-owned `repair` flow, the
  catalog-owned `import-target` flow for intentional local skill edits, and the
  installable Skill Suitcase operator skill.
- Local dogfood after `v0.8.0` verified the installed CLI exposes
  `import-target`, the skills catalog imports/validates cleanly, all modeled
  targets report current, and the packaged operator skill copy is installed in
  local Codex, Claude, and OpenClaw-Codex skill roots.
- CI runs `pnpm test` on pull requests and pushes to `main`.
- The Release Please workflow publishes to npm only when
  `steps.release.outputs.release_created == 'true'`.

## When To Merge Release Please PRs

Merge a Release Please PR only when all of these are true:

1. The PR changes only release metadata: `package.json`,
   `.release-please-manifest.json`, and `CHANGELOG.md`.
2. The version matches the intended public story for the repo.
3. GitHub CI is green, or the equivalent local verification has been run and
   the missing CI signal is understood.
4. The release notes accurately describe merged behavior.
5. No active implementation PR should land first for the same release train.

For the first public release, prefer a deliberate `0.x` release. Do not infer
`1.0.0` from the first generated Release Please PR unless Calvin explicitly
chooses a stable public API promise.

## npm Package And Bin Policy

Recommended package policy:

- Keep the npm package name as `skill-suitcase`.
- Keep the bin command as `skill-suitcase`.
- Keep an explicit `files` whitelist in `package.json` so npm publishes only the
  runtime CLI, docs, changelog, and package metadata.
- Publish through npm Trusted Publishing from GitHub Actions; do not add
  long-lived `NPM_TOKEN` secrets.
- Keep the Release Please workflow's pre-publish dry-run so local workflow
  artifacts cannot silently enter the package tarball.

`skill-suitcase` is the right package and command identity because it matches
the repo and project name, avoids a generic global binary, and makes installed
CLI provenance obvious in user terminals and automation logs.

## npm Trusted Publishing

The npm package settings must include this trusted publisher:

- Publisher: GitHub Actions
- Organization or user: `calvinnwq`
- Repository: `skill-suitcase`
- Workflow filename: `release-please.yml`
- Allowed action: `npm publish`
- Environment: blank unless a future GitHub environment approval gate is added

The workflow uses npm's OIDC trusted-publishing path instead of a stored npm
token. Required workflow properties:

- `permissions.id-token: write`
- GitHub-hosted `ubuntu-latest` runner
- Node 24 through `actions/setup-node`
- npm CLI `>=11.5.1`
- `registry-url: https://registry.npmjs.org`

Release publication is intentionally coupled to Release Please output. If
Release Please only opens or updates a release PR, the npm steps are skipped. If
Release Please creates a GitHub release after a release PR merge, the workflow
checks out the release commit, installs dependencies, runs the normal gates,
checks the publish payload with `npm publish --dry-run --access public --json`,
and publishes with provenance.

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
- keep Release Please and npm trusted-publishing permissions scoped to the
  release workflow

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
node "$CLI" upstream check --source "$SRC" --json
node "$CLI" targets --source "$SRC" --json
node "$CLI" plan --source "$SRC" --target codex --json
node "$CLI" status --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
node "$CLI" diff --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
```

Staging workflows are the next step. They may create an artifact under an
explicit temporary output directory, but still do not write into agent homes.
For Git-backed catalogs, selected source skills must not contain untracked,
non-ignored files; track or remove those files before generating packs or plan
locks.

```bash
TMP="$(mktemp -d /tmp/skill-suitcase-pack.XXXXXX)"
node "$CLI" pack --source "$SRC" --target codex --codex-home "$HOME/.codex" --output "$TMP" --json
find "$TMP" -maxdepth 3 -type f | sort
rm -rf "$TMP"
```

Catalog-only upstream refresh is separate from live target mutation.
Run `upstream check` first, use `upstream fetch --dry-run` to inspect one
selected skill in an isolated temp workspace/home, and run
`upstream import --apply` only after approval for the catalog source update:

```bash
node "$CLI" upstream fetch --source "$SRC" --skill existing-skill --dry-run --json
node "$CLI" upstream import --source "$SRC" --skill existing-skill --apply --json
```

The import must refuse malformed upstream lock metadata before fetching.
On success it writes only `skills/<name>` and `.skill-suitcase/upstream-lock.json`, never live agent homes.
Keep upstream-to-catalog drift separate from catalog-to-target drift:

- Upstream unchanged: `upstream check` reports declaration and lineage metadata only.
- Upstream changed: fetch, review, import the selected skill after approval,
  commit the catalog diff, then use normal target sync.
- Local catalog edit: treat it as catalog-hash drift and commit, revert, or
  fork/adopt deliberately.
- Upstream removed or renamed: preserve the catalog source and upstream lock
  until an operator chooses keep, fork/adopt, rename, or delete.
- Target drift: use ordinary `status`, receipts, and target workflows.
  For upstream-managed skills, `status --json` should surface target status,
  receipt hash, and receipt commit inside lineage metadata.
  Target-scoped status should load lineage for reported skills only and should not hash unrelated upstream-managed catalog skills.
  Do not call `npx skills` against live homes as a shortcut.

Trust only the exact pinned upstream package in the isolated temp workspace/home
for catalog source refresh.
Do not trust upstream tooling to choose target roots, write receipts, prove
rollback, or mutate live agent homes.
Provider-backed adapter kinds such as OpenCode and Pi stay read-only
compatibility surfaces, including when a catalog declares custom
`assignmentPaths` review roots.
`pack`, `apply`, `track`, `reconcile`, `repair`, and `import-target` should
return `read_only_target` for those roots instead of adopting them as
Suitcase-owned install targets.

Live mutation requires explicit approval input and should start in disposable
fixtures or a clearly approved target:

```bash
node "$CLI" apply --source "$SRC" --target codex --codex-home "$HOME/.codex" --artifact /path/to/skill-suitcase-bundle.json --json
node "$CLI" apply --source "$SRC" --target codex --codex-home "$HOME/.codex" --lock /path/to/plan-lock.json --mode symlink --json
node "$CLI" reconcile --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill existing-skill --dry-run --json
node "$CLI" reconcile --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill existing-skill --apply --json
node "$CLI" repair --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill existing-skill --dry-run --json
node "$CLI" repair --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill existing-skill --apply --json
node "$CLI" promote --source "$SRC" --target-skill "$HOME/.codex/skills/new-skill" --dry-run --json
node "$CLI" import-target --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill existing-skill --dry-run --json
node "$CLI" import-target --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill existing-skill --apply --json
```

Do not run live `apply`, `track`, `reconcile --apply`, `repair --apply`,
`rollback`, `promote --apply`, `import-target --apply`, or
`upstream import --apply` against Calvin's real agent homes or catalog repo
without explicit approval for the target, catalog source, and mode.

## Calvin-Local Versus Portable Support

Portable support:

- catalog layouts with `skill-suitcase.yaml`
- target overrides such as `--codex-home`, `--codex-skills`, and
  `--claude-skills`
- read-only planning, diffing, status, target discovery, validation, and import
- read-only upstream declaration checks and sandboxed upstream fetch diffs
- staging bundles and plan locks
- catalog-only upstream imports for declared, pinned source refreshes
- copy and symlink apply modes when explicitly approved
- targeted reconcile for selected unknown catalog-owned targets when explicitly
  approved
- targeted repair for selected receipt-owned dirty targets when explicitly
  approved
- targeted import-target for selected receipt-owned dirty targets when the local
  edit is intentional and explicitly approved
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
- CONTRIBUTING explains Release Please and trusted-publishing boundaries.
- CI is green on the public default branch.
- `npm pack --dry-run` has been inspected.
- Package name and bin policy are still correct.
- The package `files` whitelist excludes local workflow artifacts, tests, and
  private agent state.
- GitHub visibility/ruleset decision is explicit.
- Support boundary explains Calvin-local paths versus portable config.
- No docs imply `skills.sh` runtime delegation is part of the managed installer.
- Docs that mention `skills.sh` source refresh distinguish catalog-only refresh from live agent-home installs.
- Docs that mention OpenCode or Pi provider roots describe them as read-only,
  including custom manifest `assignmentPaths` roots.
- Docs that mention upstream-managed refresh preserve the separate
  upstream-to-catalog and catalog-to-target lifecycle policy.

## Current Decision

Skill Suitcase publishes automatically from the Release Please workflow through
npm Trusted Publishing. Manual local publishing is still acceptable as emergency
fallback, but routine releases should flow through Release Please and GitHub
Actions.
