# Release Readiness

This document records the release controls and verified shipped state for Skill Suitcase, including the package hardening from `NGX-618`.
It is an operational checklist, not a roadmap.

## Verified Shipped State

The shipped version is the value shared by npm's `latest` tag and the newest
non-prerelease GitHub release. Verify both authoritative sources directly:

```bash
npm view skill-suitcase version dist-tags --json
gh release list \
  --repo calvinnwq/skill-suitcase \
  --exclude-drafts \
  --exclude-pre-releases \
  --limit 1
```

This document intentionally does not duplicate that version as a literal.
Release Please bumps `package.json` in a release PR before the version is
published, so package metadata alone is not proof of shipped state. At this
documentation refresh, the two authoritative sources matched.

Current durable release facts:

- The GitHub repository is public.
- The installed binary name is `skill-suitcase`.
- The package requires Node.js 20 or newer.
- CI runs an OSV dependency advisory scan against `pnpm-lock.yaml`, plus tests,
  lint/typecheck, architecture, and formatting checks on Node 24 and the
  packed-package smoke test on Node 20 and Node 24.
- GitHub releases and release notes are managed by Release Please.
- npm publication runs only after Release Please creates a GitHub release.
- npm publication uses GitHub Actions OIDC Trusted Publishing with provenance;
  the repository does not need a long-lived `NPM_TOKEN`.

The current shipped CLI includes catalog import and validation, strict Skillify
validation policy, target discovery and local path overrides (including shared
agents, flat and categorized Hermes, and Grok roots), plans/diffs/status,
immutable bundles and plan locks,
transactional copy and symlink apply, receipts and rollback, track/reconcile/
repair/promote/import-target workflows, manifest logical groups and source
policy, provider-backed read-only target boundaries, and pinned skills.sh or Git
upstream source refresh into the catalog.
The repository and npm package also include `examples/sample-catalog`, a public-safe offline fixture with a disposable lifecycle walkthrough.

OpenCode and Pi remain provider-backed read-only compatibility targets. Upstream
refresh remains catalog-only: it does not install directly into live agent
homes.

## Release Authority

Release Please is the source of truth for version changes, changelog entries,
Git tags, and GitHub releases. The release workflow is
`.github/workflows/release-please.yml`.
Release tags and release names use the plain `vX.Y.Z` form without a package
component prefix.

Merge a Release Please PR only when:

1. Its version matches the intended compatibility change.
2. Its release notes accurately describe merged behavior.
3. CI is green, or an equivalent local result and the reason for a missing CI
   signal are recorded.
4. No implementation change intended for that release is still pending.
5. The release metadata diff is understood, including `package.json`,
   `.release-please-manifest.json`, and `CHANGELOG.md`.

The project remains pre-1.0. A `1.0.0` release requires an explicit stable API
decision; it is not inferred from routine Release Please output.

## npm Package And Binary Policy

- Package name: `skill-suitcase`
- Binary name: `skill-suitcase`
- Registry access: public
- Node engine: `>=20`
- Runtime dependency: `yaml` `^2.9.0` for Hermes configuration parsing
- License: MIT
- Repository: `calvinnwq/skill-suitcase`
- Homepage: `https://calvinnwq.github.io/skill-suitcase/`

`package.json` uses an explicit `files` whitelist.
The exact curated payload is owned by that whitelist and independently enforced by `scripts/package-validation.mjs`.
The documentation payload inventory includes `docs/getting-started.md` as the public onboarding walkthrough.
Do not replace the exact documentation, operator-skill, or sample-catalog entries with broad directory globs because a newly added file must not become publish-approved without independent review.
Project test suites, source TypeScript, local review artifacts, agent state, and workspace files are excluded from the npm payload.
The sample catalog's explicitly curated contract test is part of the public fixture rather than the project test suite.

`scripts/package-validation.mjs` pins the MIT license, `Calvin Ng` author, repository/homepage/issues URLs, search keywords, Node `>=20` engine, pnpm `10.34.4` package-manager metadata, package name, and binary name.
`prepack` remains routed through `package:prepare` so every supported npm pack or publish removes stale `dist` output, rebuilds the CLI, verifies its shebang and executable mode, and records hashes for `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, source files, and compiled output in the ignored `dist/.package-build.json` manifest.
`package:validate` is the non-rebuilding recheck of that manifest, so changed compiler configuration or dependency inputs and missing, additional, stale, changed, or non-executable compiled CLI output fail validation.
`pnpm run package:smoke` parses `npm pack --json`, rejects missing or unintended payload entries, requires the installed CLI binary to remain executable, installs the generated tarball into an empty temporary project, runs the read-only `targets` command, and strictly validates the packaged sample catalog and its contract tests.
The package validation tests also compare the dry-run payload's `docs/` entries
to the six curated Markdown paths exactly, which keeps the GitHub Pages-only
HTML, CSS, and JavaScript outside the tarball.
Both the package smoke and the Release Please workflow's pre-publish dry-run prevent local workflow artifacts from silently entering the package tarball.

Before publication, the release workflow runs
`npm publish --dry-run --access public --json`. Inspecting that payload is a
release gate, not an optional local convention.

## npm Trusted Publishing

The npm trusted publisher is configured for:

- Publisher: GitHub Actions
- Organization/user: `calvinnwq`
- Repository: `skill-suitcase`
- Workflow: `release-please.yml`
- Allowed action: `npm publish`

The workflow requirements are present:

- `permissions.id-token: write`
- GitHub-hosted `ubuntu-latest` runner
- Node 24 through `actions/setup-node`
- pnpm `10.34.4`
- npm CLI `>=11.5.1`
- `registry-url: https://registry.npmjs.org`
- final `npm publish --access public --provenance`

Publish steps are guarded by
`steps.release.outputs.release_created == 'true'`. Opening or updating a
Release Please PR does not publish. Once a release PR merge creates a GitHub
release, the workflow checks out that release commit, installs the locked
dependencies, runs the release gates, smoke-packs and installs the tarball,
checks the package payload with `npm publish --dry-run --access public --json`,
and publishes with provenance.

## CI And Repository Controls

The public repository runs `.github/workflows/ci.yml` for pull requests and pushes to `main`.
Its `dependency-audit` job runs the official OSV-Scanner reusable workflow against `pnpm-lock.yaml` and fails on a known vulnerability.
SARIF upload is disabled, so the workflow does not write code-scanning results even though its reusable-workflow contract requires the `security-events: write` declaration.
Its `verify` job installs the frozen pnpm lockfile on Node 24 and runs the tests, lint/typecheck, architecture check, and formatting check.
Its `package-smoke` job verifies the packed and installed CLI on Node 20 and Node 24.
The required `test` check aggregates all three jobs, so the stable ruleset context passes only after the advisory scan, every repository gate, and both supported-runtime smoke runs succeed.

The active repository ruleset was verified through the GitHub API on 2026-07-16.
It is named `Protect main` and targets `main`.
It requires pull requests, stale-review dismissal after new pushes, review-thread resolution, the CI `test` check, deletion protection, and non-fast-forward protection.
It requires zero approving reviews because the repository currently has one maintainer, so a green pull request can be merged without an unavailable second reviewer.
It does not require the checked branch to be up to date; enable strict status checks later if concurrent merge traffic makes stale-base validation a practical risk.
These are GitHub ruleset settings and cannot be enforced from repository source.

GitHub Actions currently requires approval for workflows opened by first-time
contributors. The Release Please PR is authored by `github-actions[bot]`, and
its CI run was held with `action_required` on 2026-07-11. Approve that run before
merging the release PR, or change the repository Actions approval policy to
require approval only for first-time contributors who are new to GitHub. Keep
the broader policy if approving the infrequent release PR run is preferred.
Release Please and npm trusted-publishing permissions remain scoped to the release workflow.

Making the repository public is complete and no longer an outstanding release
decision.

## Required Verification

Complete the shell-local, `packageManager`-pinned pnpm setup in
[`DEVELOPING.md`](../DEVELOPING.md) before running the local product gates.
Keep that wrapper in the current shell so verification does not modify Corepack
or global package-manager shims.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run package:smoke
pnpm run architecture:check
git diff --check
npm publish --dry-run --access public --json
```

The release workflow additionally runs the `lint` and `format:check` script
aliases.
`pnpm test` performs a clean build, requires the recursively discovered
compiled test inventory to match `tests/**/*.test.ts` exactly, and then runs
every compiled test and every `scripts/**/*.test.mjs` test.
That inventory includes `tests/docs-site.test.ts`, which restricts HTML pages to
the `docs/` root and validates the static site's shared chrome, exact HTML page
inventory, unique navigation labels, contiguous numbered reading order,
rendered pager order, local links, client-side storage fallbacks, and Pages
deployment contract.
It also includes `tests/public-docs-contract.test.ts`, which scans root Markdown
and reusable text documentation under `docs/`, `skills/`, and `examples/` for
contributor-specific home paths and validates every literal CLI launch form as
an accepted, deterministic `--json` invocation.

Review the npm dry-run output for the expected executable, compiled runtime, operator skill, license, public docs, and curated sample catalog.
Refuse the release if it contains project test suites, uncurated sample tests, local absolute paths as required inputs, private agent state, temporary artifacts, or workspace-only files.

## Portable Smoke Test

Public docs and release verification use portable paths:

The packaged [`examples/sample-catalog`](../examples/sample-catalog/README.md) is the canonical offline lifecycle smoke fixture.
Its manifest contains only a visible placeholder target, and its walkthrough overrides that path with a disposable temporary directory before mutation.

```bash
pnpm run build

SRC="/path/to/skills-catalog"
CLI="$PWD/dist/src/cli.js"

node "$CLI" import --source "$SRC" --json
node "$CLI" validate --source "$SRC" --strict --json
node "$CLI" upstream check --source "$SRC" --json
node "$CLI" targets --source "$SRC" --json
node "$CLI" plan --source "$SRC" --target codex --json
node "$CLI" status --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
node "$CLI" diff --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
```

These commands are read-only. A staging smoke test may write beneath an explicit
temporary directory, but not into a live runtime home:

```bash
OUT="$(mktemp -d "${TMPDIR:-/tmp}/skill-suitcase-pack.XXXXXX")"
node "$CLI" pack \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --output "$OUT" \
  --json
```

Live mutation tests require separate explicit approval and disposable fixtures
or a clearly approved target. Do not use a maintainer's real agent homes or
catalog as an implicit release fixture.

## Public Documentation Gate

Before publishing, verify:

- The README first screen describes the agent-first product that ships now.
- The README and package homepage route readers to
  `https://calvinnwq.github.io/skill-suitcase/`.
- The plain HTML site under `docs/` previews with `pnpm run docs:serve`, passes
  `tests/docs-site.test.ts`, keeps all HTML pages at the site root, lists each
  page exactly once under a unique navigation label in contiguous numbered
  navigation and pager order, and remains outside the npm package payload.
- `.github/workflows/pages.yml` deploys `docs/` after relevant changes land on
  `main`, with `.nojekyll` preserved at the site root.
- Repository Settings > Pages uses GitHub Actions as the publishing source so
  the deployment workflow is authorized to publish the site.
- `SPEC.md` describes the normative current-state contract and remains distinct from product direction, architecture, and detailed command usage.
- Public examples use `$HOME`, `/path/to/...`, or explicit target overrides;
  they do not require a maintainer-specific absolute path.
- Every literal public CLI launch form is accepted by the shipped CLI and
  produces deterministic output with `--json` on each invocation, including
  chained commands.
- Long-form command behavior lives in `docs/command-reference.md`, not in a
  README roadmap or milestone narrative.
- `INSTALL.md` covers packaged CLI and operator-skill setup.
- `CONTRIBUTING.md` explains Release Please and Trusted Publishing boundaries.
- Package validation checks the exact approved public payload, including the
  documentation, packaged operator-skill paths, and public sample catalog.
- The README links to contributor, development, support, security, and conduct
  guidance, and every linked community file ships in the npm package.
- No doc implies `skills.sh` runtime delegation is a managed installer path.
- Upstream docs keep upstream-to-catalog drift separate from
  catalog-to-target drift.
- OpenCode and Pi are described as read-only even with custom manifest
  `assignmentPaths` roots.
- Manifest groups are reporting metadata only.
- `sourcePolicy` and strict-validation skips do not imply broader target write
  or ownership authority.
- Shared agents, Codex, Claude, flat and categorized Hermes, and Grok target
  overrides are documented.
- Release verification confirms that the newest non-prerelease GitHub release
  matches npm `latest`.

## Current Release Decision

Routine releases flow through Release Please and GitHub Actions to npm Trusted
Publishing. Manual local publication is emergency-only and must preserve the
same verification, payload inspection, provenance, and version-authority
boundaries.
