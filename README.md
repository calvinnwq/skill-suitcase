# Skill Suitcase

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

Read-only commands (`plan`, `diff`, `pack --dry-run`, `import`, `validate`,
`targets`, `status`, `upstream check`, and `upstream fetch`) read a catalog
manifest, resolve assignments and assignment paths, and emit JSON plans, diffs,
import findings, target discovery, bundle manifests, status reports, or upstream
source-refresh reports without touching target install paths or runtime homes.

- Git-backed catalog source stays reviewable before it reaches a runtime.
- Read-only commands explain current state before any mutation.
- Mutating commands require an explicit artifact, lock, `--apply`, or other
  approval boundary.
- JSON result objects, including structured `ok: false` results, go to stdout;
  usage and fatal diagnostics go to stderr.
- Copy and symlink installs are tracked with receipts and recoverable workflows.

Read [`VISION.md`](VISION.md) for the product north star and
[`ARCHITECTURE.md`](https://github.com/calvinnwq/skill-suitcase/blob/main/ARCHITECTURE.md)
for the CLI boundaries.

## Install

Skill Suitcase requires Node.js 20 or newer.

```bash
npm install --global skill-suitcase
```

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
| Move target work into Git | `promote`, `import-target` | Dry-run first; `--apply` mutates catalog source |
| Refresh pinned upstream source | `upstream check`, `upstream fetch`, `upstream import` | Catalog-only; never a direct target installer |

The modeled targets are `openclaw`, `codex`, `openclaw-codex`, `agents`,
`claude`, `opencode`, `pi`, and `grok`. Target paths can be made portable with
`--agents-skills`, `--codex-home`, `--codex-skills`, `--claude-skills`, and
`--grok-skills`.

OpenCode and Pi are provider-backed compatibility targets. They are read-only
even when the catalog declares a custom `assignmentPaths` entry. Mutating or
materializing commands refuse those roots with `read_only_target` rather than
silently treating provider-managed locations as Suitcase-owned installs.

See [`docs/command-reference.md`](docs/command-reference.md) for command
guidance, approval requirements, state meanings, and common refusal codes.

## Safety Model

Skill Suitcase separates three phases:

1. Inspect with `import`, `validate`, `targets`, `plan`, `status`, `diff`, and
   `upstream check`.
2. Stage with `pack` or a plan lock, and review the ordinary filesystem/Git
   changes.
3. Mutate only with explicit approval through `apply`, a targeted `--apply`
   command, or a receipt-backed rollback.

`apply` is transactional, refuses unmanaged targets, preserves executable file
modes, and writes a receipt for every managed skill. Lock mode reassesses the
current plan and hashes against the deterministic lock. Artifact mode validates
the artifact manifest, but ordinary create/behind writes are built from current
catalog source; artifact file hashes gate only the dirty-behind exception. Pack
again immediately before artifact apply and inspect the current `diff` rather
than treating an older artifact as byte-for-byte approval. `--mode symlink`
links selected current catalog source into the target.

Receipts record ownership, source provenance, install mode, file hashes, and
rollback metadata. `status` classifies modeled installs as `current`, `behind`,
`version`, `dirty`, `missing`, `unknown`, or `blocked`. Provider-modeled
fallback inventory without a catalog assignment appears with no status entries.

Never run live `apply`, `track`, `reconcile --apply`, `repair --apply`,
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
| New target-created skill should become catalog source | `promote` |
| Intentional edit to a receipt-owned catalog skill should return to Git | `import-target` |

Preview `track` candidates with `diff`; `track` has no dry-run flag. Run the
matching dry-run before `reconcile`, `repair`, `promote`, or `import-target`.
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

## `import-target` Output

`import-target` is the inverse choice for an intentional local edit to a
receipt-owned, catalog-owned skill. `import-target --dry-run` reports the
receipt hash, catalog hash, target hash, changed files, and planned repo writes
without mutation. After approval, `import-target --apply` copies the target
content into the catalog, verifies it, refreshes the receipt, and leaves
ordinary Git changes for review; it does not auto-commit.

### Decision tree: `track` vs `reconcile` vs `repair` vs `promote` vs `import-target`

- Use `track` for an exact unreceipted match.
- Use `reconcile` when an unknown target should be replaced by catalog source.
- Use `repair` when an accidental dirty edit should be discarded after review.
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

A catalog is a Git repository with `skill-suitcase.yaml` and skill directories
under `skills/`. The manifest owns skills, variants, assignments, compatibility,
target paths, logical groups, source policy, and validation policy.

### Manifest Logical Groups

Manifest-owned groups can organize skills, suitcases, and assignments for
operator reporting. Groups are catalog metadata only: they validate references
deterministically but do not change planning, packing, installation, receipt,
or target assignment semantics.

### Manifest `sourcePolicy`

`sourcePolicy.exclude` omits approved generated or cache paths from pack,
plan-lock, diff, and apply materialization. `sourcePolicy.deny` blocks unsafe or
secret-like source paths before any target write. Refusals identify the skill
and relative path with `source_denied_path` or `diff_source_denied_path`.

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
pnpm run architecture:check
git diff --check
```

The current implementation has no runtime package dependencies. Keep
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
