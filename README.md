# Skill Suitcase

[**Docs**](https://calvinnwq.github.io/skill-suitcase/) ·
[Install](INSTALL.md) ·
[Spec](SPEC.md) ·
[Command reference](docs/command-reference.md)

Skill Suitcase is an agent-first skill package manager backed by a Git catalog.
It gives agents one JSON-first CLI for inspecting, installing, updating, and
recovering skills across runtimes without treating live agent homes as the
source of truth.

The `skill-suitcase` CLI is the product backbone. A portable skills repository
holds reviewed source, variants, assignments, target policy, and upstream
metadata; Skill Suitcase turns that catalog into deterministic plans, diffs,
artifacts, installs, receipts, and rollback state.

## Community

See [`CONTRIBUTING.md`](CONTRIBUTING.md) to contribute and
[`DEVELOPING.md`](DEVELOPING.md) for the local development workflow. Usage
support, private vulnerability reporting, and community expectations are
documented in [`SUPPORT.md`](SUPPORT.md), [`SECURITY.md`](SECURITY.md), and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Read-only command modes (`plan`, `diff`, `pack --dry-run`, `import`, `validate`, `targets`, `status`, `reconcile --dry-run`, `repair --dry-run`, `prune --dry-run`, `promote --dry-run`, `import-target --dry-run`, `upstream check`, and `upstream fetch --dry-run`) inspect catalog, target, or upstream state and emit JSON plans, diffs, findings, discovery metadata, status reports, or source-refresh reports without changing catalog source, target installs, receipts, or live runtime homes.

- Git-backed catalog source stays reviewable before it reaches a runtime.
- Read-only commands explain current state before any mutation.
- Mutating commands require an explicit artifact, lock, `--apply`, or other
  approval boundary.
- JSON result objects, including structured `ok: false` results, go to stdout;
  usage and fatal diagnostics go to stderr.
- Copy and symlink installs are tracked with receipts and recoverable workflows.

The [docs site](https://calvinnwq.github.io/skill-suitcase/) carries the guide-level documentation:
overview, install, safety model, catalog model, upstream refresh, agent workflows, troubleshooting, and the full CLI reference.
Read [`VISION.md`](VISION.md) for the product north star and
[`SPEC.md`](SPEC.md) for the normative current-state contract. See
[`ARCHITECTURE.md`](https://github.com/calvinnwq/skill-suitcase/blob/main/ARCHITECTURE.md)
for the CLI boundaries.

## Install

Skill Suitcase requires Node.js 20 or newer.

```bash
npm install --global skill-suitcase
```

For a hands-on first run covering installation, catalog setup, local target overrides, read-only audit, staged apply, and rollback, follow [`docs/getting-started.md`](docs/getting-started.md).
For agent/runtime setup, including the packaged operator skill, follow
[`INSTALL.md`](INSTALL.md).

## Start With A Read-Only Audit

Point `SRC` at any catalog containing `skill-suitcase.yaml` and
`skills/<name>/SKILL.md`:

```bash
SRC="/path/to/skills-catalog"

skill-suitcase import --source "$SRC" --json
skill-suitcase validate --source "$SRC" --strict --json
skill-suitcase targets --source "$SRC" --json
skill-suitcase plan --source "$SRC" --target codex --json
skill-suitcase status --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
skill-suitcase diff --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
```

These commands do not create install roots, runtime homes, receipts, symlinks,
or catalog files. Inspect their JSON before moving to staging or mutation.

For a ready-made catalog that never assumes a real agent home, use the
[`examples/sample-catalog`](examples/sample-catalog/README.md) fixture shipped
in both the repository and npm package. Its
walkthrough covers disposable plan, diff, status, pack, apply, repair, rollback,
and upstream-policy checks.

To stage an immutable bundle without touching an agent home:

```bash
OUT="$(mktemp -d "${TMPDIR:-/tmp}/skill-suitcase-pack.XXXXXX")"
skill-suitcase pack \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --output "$OUT" \
  --json
```

`pack --dry-run` is also read-only. A real `pack --output` writes only beneath
the explicit staging directory. For Git-backed catalogs, materialization
refuses selected skills containing untracked, non-ignored files.

## What Ships Today

The CLI currently supports:

| Workflow | Commands | Boundary |
| --- | --- | --- |
| Inspect a catalog | `import`, `validate` | Read-only |
| Discover and model targets | `targets`, `plan`, `diff`, `status` | Read-only |
| Stage approved content | `pack` | Writes only to an explicit output directory |
| Install catalog skills | `apply` | Requires a plan lock or staged artifact |
| Adopt exact existing installs | `track` | Writes receipts, not skill files |
| Recover target state | `rollback`, `reconcile`, `repair` | Explicit, receipt-aware mutation |
| Remove obsolete managed installs | `prune` | Explicit skills; read-only plan ID before transactional apply |
| Move target work into Git | `promote`, `import-target` | Dry-run first; `--apply` mutates catalog source |
| Refresh pinned upstream source | `upstream check`, `upstream fetch`, `upstream import` | Catalog-only; never a direct target installer |

The modeled targets are `openclaw`, `codex`, `openclaw-codex`, `agents`,
`claude`, `opencode`, `pi`, and `grok`. Target paths can be made portable with
`--agents-skills`, `--codex-home`, `--codex-skills`, `--claude-skills`, and
`--grok-skills`.

OpenCode and Pi are provider-backed compatibility targets.
They are read-only even when the catalog declares a custom `assignmentPaths` entry.
Target-aware materialization and mutation commands (`pack`, `apply`, `track`,
`reconcile`, `repair`, `prune`, and `import-target`) refuse those roots with
`read_only_target` rather than silently treating provider-managed locations as
Suitcase-owned installs.
Path-driven `promote` and receipt-driven `rollback` do not resolve target
adapters and instead enforce their own explicit scope and ownership checks.

See [`docs/command-reference.md`](docs/command-reference.md) for command
guidance, approval requirements, state meanings, and common refusal codes.

## Safety Model

Skill Suitcase separates three phases:

1. Inspect with `import`, `validate`, `targets`, `plan`, `status`, `diff`, the recovery and promotion `--dry-run` modes, `upstream check`, and `upstream fetch --dry-run`.
2. Stage with `pack` or a plan lock, and review the ordinary filesystem/Git
   changes.
3. Mutate only with explicit approval through `apply`, a targeted `--apply`
   command, or a receipt-backed rollback.

`apply` is transactional, refuses unmanaged targets, preserves executable file modes, and updates the target receipt with a record for every managed skill.
Lock mode reassesses the current plan and hashes against the deterministic lock.
Artifact mode validates the artifact manifest, but ordinary create/behind writes are built from current catalog source; artifact file hashes gate only the dirty-behind exception.
Pack again immediately before artifact apply and inspect the current `diff` rather than treating an older artifact as byte-for-byte approval.
`--mode symlink` links selected current catalog source into the target.

Receipts record ownership, source provenance, install mode, file hashes, and
rollback metadata. `status` classifies modeled installs as `current`, `behind`,
`version`, `dirty`, `missing`, `unknown`, or `blocked`. Provider-modeled
fallback inventory without a catalog assignment appears with no status entries.

Never run live `apply`, `track`, `reconcile --apply`, `repair --apply`, `prune --apply`,
`rollback`, `promote --apply`, `import-target --apply`, or
`upstream import --apply` against a real catalog or runtime home without
explicit approval for the source, target, and mode.

## Choosing A Recovery Workflow

Use the target state and ownership model to choose the command:

| Situation | Command |
| --- | --- |
| Existing target exactly matches catalog source but has no receipt | `track` |
| Receiptless target differs from a catalog-planned skill | `reconcile` |
| Receipt-owned copy install drifted and catalog should win | `repair` |
| Receipt-owned install is no longer assigned to the target | `prune` |
| New target-created skill should become catalog source | `promote` |
| Intentional edit to a receipt-owned catalog skill should return to Git | `import-target` |

Preview `track` candidates with `diff`; `track` has no dry-run flag. Run the
matching dry-run before `reconcile`, `repair`, `prune`, `promote`, or `import-target`.
Drift detection is a heartbeat, not permission to overwrite either side; every
mutation still requires explicit approval.

## `repair` Output

A `dirty` receipt-owned copy install means stop and inspect. Use
`repair --dry-run` to report the target path, receipt hash, catalog hash,
changed files, and backup/rollback plan. After approval, `repair --apply` backs
up the live content, restores catalog source, refreshes the receipt, and verifies
that status becomes `current`. A later `rollback` restores the pre-repair state.

`repair` refuses unknown, missing, behind, symlink-mode, read-only, and
unselected states rather than guessing operator intent.

## `prune` Output

`prune --dry-run` accepts only explicit repeated `--skill` values. It refuses
skills still assigned to the target, paths without one matching receipt record,
provider/read-only targets, path escapes, receipt/file drift, and symlinks whose
current target differs from their receipt source. The plan includes the receipt
hash, per-object fingerprint, quarantine paths, and a stable plan ID.
Receipt-owned symlinks created by `promote` are eligible under the same rules
once the skill is no longer assigned to the selected target.
Prune requires `.skill-suitcase-receipt.json` and safely refuses a legacy
`.skills-sync.json` receipt instead of migrating it in this safety-sensitive workflow.

After approval, repeat the exact skill list with
`--plan-id <reviewed-id> --apply`. Apply recomputes the plan before mutation,
refuses and preserves any pre-existing plan quarantine root, quarantines physical
directories, removes exact verified symlinks, writes a plan-scoped transaction
journal and receipt backup, then atomically replaces the live receipt. Any
failed apply attempts to restore the prior receipt, directories, and symlinks.
Retain and review any reported quarantine root, transaction journal, and receipt
backup; do not manually delete them or use broad rollback.
An apply refusal preserves apply-mode JSON (`dryRun: false`) while reporting
`readOnly: true`, and a missing install root is refused rather than recreated.

## `import-target` Output

`import-target` is the inverse choice for an intentional local edit to a
receipt-owned, catalog-owned skill. `import-target --dry-run` reports the
receipt hash, catalog hash, target hash, changed files, and planned repo writes
without mutation. After approval, `import-target --apply` copies the target
content into the catalog, verifies it, refreshes the receipt, and leaves
ordinary Git changes for review; it does not auto-commit.

### Decision tree: `track` vs `reconcile` vs `repair` vs `prune` vs `promote` vs `import-target`

- Use `track` for an exact unreceipted match.
- Use `reconcile` when an unknown target should be replaced by catalog source.
- Use `repair` when an accidental dirty edit should be discarded after review.
- Use `prune` when an explicit receipt-owned install is no longer assigned to its target.
- Use `promote` for a new target-created skill.
- Use `import-target` when an intentional dirty edit should become catalog
  source.

### Drift audit / heartbeat

Use `status --json` as the drift-audit heartbeat. Report drift and inspect the
changed files; do not import target changes merely because drift exists.
`import-target --dry-run` previews planned repo writes, and
`import-target --apply` requires explicit approval.

## Fresh Agent Runtime Machine

New-machine setup installs from the skills repo through Suitcase:

1. Install `skill-suitcase` and the packaged operator skill.
2. Clone or update the approved skills catalog at any local path.
3. Run `import`, strict `validate`, `targets`, `plan`, `status`, and `diff`.
4. Stage or lock the reviewed plan.
5. Apply only the approved target changes and verify receipts/status.

The catalog-only upstream lane may refresh selected reviewed source before this
flow, but it is not a shortcut for writing into live agent homes.

## Upstream Source Refresh

Pinned upstream providers are a source refresh lane:

```text
upstream check -> isolated temp fetch/diff -> catalog import -> Git review -> pack/apply
```

`.skill-suitcase/upstream-lock.json` records the exact pinned provider,
upstream package/version, upstream repo/skill, imported hash, and imported
source. `upstream fetch --dry-run` uses an isolated temp workspace/home.
`upstream import --apply` writes only the selected catalog source and lock file,
never live agent homes, and leaves ordinary repository diffs; it does not
auto-commit.

Keep upstream-to-catalog drift separate from catalog-to-target drift:

- **Upstream unchanged:** `upstream check` reports declaration and lineage.
- **Upstream changed:** fetch, review, import, commit, then use normal target
  sync.
- **Local catalog edit:** treat it as catalog-hash drift and commit, revert, or
  fork/adopt deliberately.
- **Upstream removed or renamed:** keep the reviewed source and lock until an
  operator chooses keep, fork/adopt, rename, or delete.
- **Target drift:** use `status` and receipt-aware target workflows; do not call
  `npx skills` against live homes.

The trust boundary is the declared provider fetched in isolation. Git
declarations pin a tag or commit. skills.sh declarations pin the installer
package version, but the referenced upstream repository content is not pinned
to a source revision or content hash; review every fetched diff. Do not trust
upstream tooling to select live roots, write receipts, or prove rollback.
New-machine setup remains a catalog checkout followed by ordinary Suitcase
planning and apply.

For an upstream-managed skill, status lineage can include the current catalog
hash, target status, receipt hash, and receipt commit alongside its upstream
package/version, upstream repo/skill, and imported hash. Target-scoped status
loads lineage only for reported skills.

## Catalog Contract

A catalog is a directory with `skill-suitcase.yaml` and skill directories under `skills/`.
Git backing is the preferred operating model and is required by workflows such as upstream import, but ordinary planning and target materialization also accept a non-Git catalog directory.
The manifest owns skills, variants, assignments, compatibility, target paths, logical groups, source policy, and validation policy.

### Manifest Logical Groups

Manifest-owned groups can organize skills, suitcases, and assignments for
operator reporting. Groups are catalog metadata only: they validate references
deterministically but do not change planning, packing, installation, receipt,
or target assignment semantics.

### Manifest `sourcePolicy`

`sourcePolicy.exclude` omits approved generated or cache paths from pack,
plan-lock, diff, and copy-mode apply materialization.
Symlink apply cannot omit descendants, so it refuses any non-empty exclude
policy with `symlink_source_policy_exclude`, even when no path currently matches.
`sourcePolicy.deny` blocks unsafe or secret-like source paths before any target
write.
Refusals identify the skill and relative path with `source_denied_path` or
`diff_source_denied_path`.

### Strict Validation Policy

`validate --strict --json` applies the Skillify authoring contract. Reviewed
`validationPolicy.skillify.skip` entries can exempt referenced external,
legacy, or upstream-managed skills from strict scoring when their provenance is
valid. A validation skip does not change planning, installation, receipt,
ownership, or target-drift semantics.

## JSON Contract

Command results are serialized deterministically to stdout, including
structured `ok: false` results with machine-readable errors. Parser/usage
failures and uncaught fatal diagnostics are written to stderr. Known failures
use stable exit codes. Absolute paths in JSON reflect caller inputs and resolved
local targets; the documentation uses portable placeholders instead of assuming
a particular workstation layout.

For operational command guidance, see
[`docs/command-reference.md`](docs/command-reference.md). The emitted JSON is
the authoritative machine contract. For portability and smoke-test guidance, see
[`docs/portability-matrix.md`](docs/portability-matrix.md) and
[`docs/install-smoke.md`](docs/install-smoke.md).

## Development

Complete the shell-local, `packageManager`-pinned pnpm setup in
[`DEVELOPING.md`](DEVELOPING.md) before running the development checks.
That setup leaves Corepack and global package-manager shims unchanged.

```bash
pnpm test
pnpm run typecheck
pnpm run build
pnpm run package:smoke
pnpm run format:check
pnpm run architecture:check
git diff --check
```

`build` removes `dist`, compiles the TypeScript sources, and marks `dist/src/cli.js` executable so stale generated output cannot survive a package build.
`test` rebuilds first, verifies that the recursively discovered compiled test inventory exactly matches `tests/**/*.test.ts`, then runs every compiled test and every `scripts/**/*.test.mjs` test with Node's built-in test runner.
`package:smoke` runs the supported local pack verification: npm invokes `prepack` to create a clean build and record build-input, source, and output hashes in the ignored `dist/.package-build.json`, then the smoke script parses `npm pack --json`, validates the pinned public metadata and exact allowed payload, installs the tarball into an empty temporary project, and runs the read-only `targets` command through the installed executable.
`architecture:check` runs `scripts/check-architecture.mjs` to enforce the module boundaries described in [`ARCHITECTURE.md`](ARCHITECTURE.md).
`docs:serve` previews the static docs site from `docs/` at `http://127.0.0.1:8080/`.
The same pages are validated by `tests/docs-site.test.ts` inside `pnpm test` and deploy to GitHub Pages through `.github/workflows/pages.yml`.

CI uses the package's pinned pnpm `10.34.4` toolchain.
The `verify` job runs the tests, lint/typecheck, architecture check, and
formatting check on Node 24.
The `package-smoke` job verifies the packed and installed CLI on Node 20 and
Node 24, and the required `test` check aggregates both jobs.

The current implementation has no runtime package dependencies.
Keep
`src/cli.ts` thin, put parsing and validation in `src/commands/`, durable
behavior in `src/core/`, infrastructure in `src/adapters/`, and output contracts
in `src/renderers/`. See the module boundaries in
[`ARCHITECTURE.md`](https://github.com/calvinnwq/skill-suitcase/blob/main/ARCHITECTURE.md).

Development dependencies support TypeScript compilation, Node.js types, and
issue-form YAML validation. The manifest reader is strict and intentionally
scoped to the current `skill-suitcase.yaml` schema, including manifest-owned
logical groups as reporting metadata.

Release automation, npm Trusted Publishing, public-repository controls, and the
current shipped version are documented in
[`docs/release-readiness.md`](docs/release-readiness.md).

## License

[MIT](LICENSE)
