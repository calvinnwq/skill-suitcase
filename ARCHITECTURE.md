# Skill Suitcase CLI Architecture

This is the source of truth for how Skill Suitcase's TypeScript CLI should be
structured as it grows. It applies the shared TypeScript CLI refactor pattern
from Linear `NGX-420` to this repo.

The product north star lives in [`VISION.md`](VISION.md). Keep this file focused
on the implementation boundaries that make that vision reliable.

## End State

Skill Suitcase should converge on this shape:

```txt
src/
  cli.ts
  commands/
    index.ts
    plan.ts
    diff.ts
    pack.ts
    import.ts
    validate.ts
    targets.ts
    status.ts
    apply.ts
    rollback.ts
    track.ts
    reconcile.ts
    repair.ts
    promote.ts
    import-target.ts
    upstream.ts
  core/
    planning/
    diffing/
    packing/
    importing/
    apply/
    rollback/
    track/
    reconcile/
    repair/
    promote/
    import-target/
    upstream/
    receipts/
    status/
    install-modes.ts
    catalog/
    validation/
  adapters/
    filesystem.ts
  renderers/
    json.ts
    errors.ts
    usage.ts
    exit-codes.ts
  config/
    defaults.ts
```

This tree is the current target shape after the architecture refactor. Keep future
changes moving one command or feature boundary at a time.

## Responsibilities

`src/cli.ts` is the process entrypoint. It may:

- call the command registry
- pass `process.argv` into the parser/registry boundary
- map top-level failures to `process.exitCode`
- perform final stdout/stderr writes through renderer helpers

It should not own command behavior, domain rules, persistence details, or large
switch statements.

`src/commands/` owns user-visible commands. A command module should:

- define the command's args, flags, aliases, and help metadata
- validate and normalize user input
- build a command input object
- call a domain/core function
- render the result through a renderer
- map known command errors to exit codes

Command modules should stay thin. They adapt the outside world to core code.

`src/core/` owns durable behavior:

- planning and lock semantics
- packing and artifact construction
- import/onboarding inspection
- apply/install workflows
- rollback, reconcile, repair, import-target, and existing-install adoption
  workflows
- upstream-managed catalog source refresh workflows
- install mode classification and safety checks
- receipt creation and validation
- catalog, manifest, target, and validation rules

Core modules must not depend on command modules, help text, stdout/stderr, or
`process.argv`.

`src/adapters/` owns infrastructure boundaries:

- filesystem reads/writes
- target installation locations
- package/archive IO
- future network or external process calls

Adapters should expose narrow functions that core code can call without knowing
about CLI parsing or rendering.

`src/renderers/` owns output:

- JSON formatting
- usage/help text
- known error rendering
- stdout/stderr discipline

Skill Suitcase is JSON-first. JSON stdout is a contract. Human usage text,
warnings, and errors belong on stderr unless an issue explicitly changes that
contract.

`src/config/` owns defaults:

- default paths
- environment-driven behavior
- package metadata
- runtime constants that are not domain rules

`src/shared/` is only for truly shared types and small helpers. Do not turn it
into a junk drawer.

## Source Of Truth

Skill Suitcase is the source-of-truth manager for approved skill installs. The
catalog repository, such as `/Users/ngxcalvin/repos/skills`, owns skill source
files, variant metadata, assignments, and target policy. Agent homes are install
targets, not canonical source directories.

The durable state model belongs to Skill Suitcase:

- manifests describe approved skills, variants, assignments, and target paths
- plans and diffs explain what would change before any mutation
- source hygiene gates ensure materialization boundaries only snapshot or install
  selected Git-backed source skills after untracked, non-ignored files are
  removed or tracked
- receipts record ownership, source provenance, install mode, file hashes, and
  rollback state
- status decides whether a target is current, missing, dirty, blocked, unknown,
  or intentionally unmanaged
- rollback restores or removes what Skill Suitcase installed

External installers or registries may provide useful compatibility data, but
they must not bypass this model.

## Target Registry Providers

Target resolution should converge on an explicit provider stack. The current
manifest-defined assignment paths remain the highest-priority source because
they are reviewed with the catalog and can encode machine-specific intent.

Provider priority:

1. Local CLI overrides, such as `--codex-home`, `--codex-skills`, and
   `--claude-skills`.
2. Manifest-defined `assignmentPaths`.
3. Native Skill Suitcase adapters for targets with richer semantics or local
   policy.
4. A vendored or generated compatibility snapshot derived from `skills.sh`
   agent mappings.

The `skills.sh` layer is a compatibility/reference provider, not the canonical
authoring model. It can reduce duplicated agent path knowledge for broad target
coverage, such as OpenCode and Pi, but Skill Suitcase still owns planning,
receipts, dirty detection, rollback, and approval boundaries.

Do not call `npx skills` from normal target discovery, planning, status, diff,
apply, track, reconcile, repair, promote, or import-target paths. If a future
issue adds optional `skills.sh` installer delegation, it must be wrapped behind a
narrow adapter and reconciled back into Skill Suitcase receipts before the
install is considered managed.

Provider data must be deterministic in tests. Prefer a vendored/generated
snapshot over runtime network or package execution. Snapshot refreshes should be
reviewable like other source changes.

The `NGX-458` delegation spike is recorded in
[`docs/skills-sh-delegation.md`](docs/skills-sh-delegation.md). Its current
recommendation is to defer runtime delegation and keep `skills.sh` as
compatibility/reference data until a pinned adapter can prove post-install
receipt reconciliation and rollback boundaries.

## Upstream-Managed Source Refresh

An upstream-managed skill is still a catalog-owned skill. The catalog stores the
reviewed source files, target assignments, variants, and install policy. The
upstream provider only describes where a fresh source copy can be fetched from.

The first supported upstream lane is for `skills.sh` / `npx skills`.
Its v1 boundary is source refresh only:

```txt
pinned upstream fetch -> isolated temp workspace -> catalog diff -> catalog import
```

This lane must not write directly into Codex, Claude, OpenClaw, or any other
live agent homes. New-machine setup remains deterministic: clone or update the
skills catalog, then use normal Skill Suitcase `pack`, `apply`, `track`,
`status`, and `diff` flows to populate local targets from the catalog source.

Upstream refresh metadata should be reviewed with the catalog and kept separate
from target assignment policy. It may record provider name, pinned package or
command version, upstream skill identity, grouped imports, imported content
hashes, and last imported provenance. It must not replace receipts. Receipts
remain the target-side record of what Skill Suitcase installed.

The v1 declaration file is `.skill-suitcase/upstream-lock.json`. It uses schema
`calvinnwq.skills.upstream-lock.v0` and declares selected catalog skills under a
`skills` object. Each `skills-sh` declaration pins `packageVersion`, records the
upstream repo and skill name, can group related imports such as `hyperframes`,
and stores the last imported catalog content hash under `imported.sha256`.
This file is catalog source metadata only; it does not grant target write
authority.

Upstream-managed source is provider-owned, not Skillify-authored catalog source.
Strict validation must still validate upstream declarations and referenced
skill presence, but it must not apply the Skillify-10 authoring contract to
skills declared in the upstream lock. The Skillify contract is for skills we
create and maintain ourselves.

Source refresh commands should be explicit and staged:

1. `upstream check --source <repo> --json` reports declared upstream-managed
   skills, pinned package metadata, catalog hashes, and local package-runner
   availability without writing files
2. `upstream fetch --source <repo> --skill <name> --dry-run --json` runs the
   pinned fetch in an isolated temp workspace/home and reports a file-level
   catalog diff
3. `upstream import --source <repo> --skill <name> --apply --json` repeats the
   pinned fetch and copies only the selected skill into the catalog source tree,
   then updates `.skill-suitcase/upstream-lock.json`
4. ordinary Git review/commit
5. ordinary Skill Suitcase target sync from the catalog

Catalog imports must refuse uncommitted local edits or untracked files in the
selected skill source. They should create ordinary repository diffs; in v1, do
not auto-commit upstream imports. Live `skills.sh` installer delegation is a
separate future feature and must not be introduced as part of this
source-refresh model.

### Upstream Lifecycle Policy

Upstream-managed skills have two separate drift axes:

- upstream-to-catalog drift, handled by `upstream check`, `upstream fetch`, and
  `upstream import`
- catalog-to-target drift, handled by ordinary `status`, `diff`, `track`,
  `pack`, `apply`, `repair`, `import-target`, and `rollback`

Do not collapse these axes. A changed upstream package does not make any live
target safe to update until the fetched source has been imported into the
catalog, reviewed, committed, and then synchronized through the normal target
workflow. A target receipt proves only the catalog version Skill Suitcase
installed; upstream lock metadata proves only the provider source that last
refreshed the catalog.

Lifecycle cases:

| Case | Required behavior |
| --- | --- |
| Upstream unchanged | `upstream check` reports declarations and lineage metadata, including upstream package/version, imported hash, and current catalog hash. No target action is implied. |
| Upstream changed | `upstream fetch --dry-run` shows a catalog diff. `upstream import --apply` may update only the selected catalog skill and upstream lock after selected source hygiene passes. Git review/commit happens before target sync. |
| Local catalog edit to upstream-managed source | Treat this as catalog-hash drift from the last imported hash. Do not silently overwrite it with upstream. Either commit it as a deliberate catalog change, revert it, or intentionally fork/adopt the skill out of upstream-managed mode in a future explicit policy slice. |
| Upstream removed or renamed | Fetch/import must report the missing upstream skill and preserve the existing catalog source and lock until an operator decides whether to keep, fork/adopt, rename, or delete the catalog skill. |
| Target drift from an upstream-managed catalog skill | Use ordinary target status semantics. `track` exact matches, `pack`/`apply` missing or behind targets, and stop on dirty targets for `repair` or `import-target`. Do not call `npx skills` against the live target as a shortcut. |

Status reports attach the same lineage object to upstream-managed skill entries
and fill the target block from the selected target receipt state. That keeps the
two drift axes separate while making the full chain visible in one JSON entry:
upstream package/version, upstream repo/skill, imported hash, current catalog
hash, target status, receipt hash, and receipt commit.

Local patches to upstream-managed skills are intentionally conservative in v1:
there is no implicit patch layer. If a provider-owned skill needs local changes,
the default operator decision is to either keep the edit as a reviewed catalog
change with catalog-hash drift visible, or fork/adopt the skill into
locally-authored catalog ownership through a separately designed flow. Silent
edits to upstream-managed source must not be hidden by strict validation because
strict skips Skillify scoring, not source drift reporting.

The trust boundary for `skills.sh` / `npx skills` is narrow. Skill Suitcase
trusts only an exact pinned package version run inside an isolated temp
workspace/home for source refresh, then validates the fetched directory is
inside that sandbox and contains `SKILL.md`. It does not trust upstream tooling
to choose live target roots, write receipts, prove rollback state, or mutate
agent homes.

## Install Modes

Skill Suitcase supports copy and native symlink installs. Install modes should
be selected explicitly by approved apply input and recorded in receipts, status,
and rollback. Do not infer an install mode from filesystem shape alone when a
receipt can state it directly.

The intended symlink direction is:

```txt
agent skill path -> catalog repo source path
```

Example:

```txt
~/.codex/skills/my-skill -> /Users/ngxcalvin/repos/skills/skills/my-skill
```

The reverse direction is not allowed for managed installs. The catalog repo must
not point back into an agent home as its source of truth, because that makes Git
history, review, portability, dirty detection, and rollback ambiguous.

Symlink mode must treat these states as distinct:

- correct symlink to the selected source path
- broken symlink
- symlink to the wrong target
- real directory where symlink mode expected a link
- matching real directory that can be tracked or converted only with approval
- unmanaged extras outside the approved plan

Rollback for symlink installs should remove a Skill Suitcase-created symlink or
restore the previous target state recorded in the receipt. It must not delete a
real directory that was not first captured as rollback state.

## Command Semantics

Keep the command verbs separate:

- `track` adopts an existing target that already matches the selected catalog
  source. It writes receipts only and does not rewrite skill files.
- `apply` installs or updates skills from an approved plan lock or artifact.
  Symlink support belongs here as an explicit `--mode symlink` install mode,
  not as an implicit side effect. Apply normally refuses dirty targets, but it
  may update a receipt-owned dirty skill when the receipt hash is behind the
  catalog, the approved lock/artifact writes that same skill, the live target is
  still a real managed directory, the approval input carries matching per-file
  hash proof, and per-file receipt metadata proves apply will not overwrite or
  bless unrelated local drift. That is the supported route for narrow
  stale-receipt/catalog-update cases that `repair` routes to `pack` + `apply`.
- `reconcile` repairs selected catalog-planned target skills that are unknown
  because the live target directory exists without a Suitcase receipt and differs
  from the catalog source. `--dry-run` is deterministic and read-only; `--apply`
  is approval-gated, replaces the selected target from catalog source, preserves
  the prior target as rollback/backup state, writes a receipt, and must leave
  status current. Reconcile must not adopt exact matches (use `track`), install
  missing skills or approved plan updates (use `apply`), or promote target-created
  skills into the catalog (use `promote`).
- `repair` restores selected receipt-owned copy-mode target skills that are
  dirty because the live target differs from the receipt. `--dry-run` is
  deterministic and read-only; `--apply` is approval-gated, backs up the dirty
  target, replaces it from catalog source, writes `mode: "repair"` rollback
  state, and must leave status current. Repair must not adopt unknown targets
  (use `track` or `reconcile`), install missing or behind skills (use `apply`),
  mutate symlink-mode installs, or operate without explicit `--skill` filters.
- `import-target` imports an intentionally-edited receipt-owned copy-mode target
  skill back into the catalog as the source-of-truth inverse of `repair`:
  `repair` discards the local edit (catalog -> target), while `import-target`
  keeps it (target -> catalog) so it can land in the skills repo through
  review. `--dry-run` is deterministic and read-only; `--apply` is
  approval-gated, copies the live target tree into the catalog source path
  (atomic backup-and-swap + hash verify), refreshes the receipt
  (`mode: "import"`) so the target reads `current`, and leaves the catalog as
  ordinary git changes for review. Import-target must not adopt unknown targets
  (use `track` or `reconcile`), install missing or behind skills (use `apply`),
  promote a target-created skill (use `promote`), mutate symlink-mode installs,
  operate without explicit `--skill` filters, or run implicitly from a drift
  report.
- `rollback` reverses prior `apply`, `reconcile`, or `repair` mutations using
  receipt rollback state.
- `promote` turns a target-created skill (for example a skill an agent wrote
  into an agent home directory) into a repo-owned catalog skill. `--dry-run`
  runs a read-only plan; `--apply` runs the approval-gated live promotion.
- `upstream` refreshes catalog source for declared upstream-managed skills.
  `upstream check` is read-only and reports declaration health, pinned package
  runner availability, and catalog hash drift. `upstream fetch --dry-run` runs
  the pinned fetch in an isolated temp workspace/home and reports a file-level
  catalog diff. `upstream import --apply` refuses dirty selected catalog source,
  repeats the pinned fetch, copies only the selected skill into the catalog
  source tree, updates `.skill-suitcase/upstream-lock.json`, and leaves ordinary
  repository diffs for review. It must not write live target homes, receipts, or
  commits.

A target-created skill must not be handled by `track` unless it already exists
in the catalog and matches the selected source. For a new skill created inside
an agent home, the promote workflow:

1. inspect the target skill directory read-only (`--dry-run`)
2. copy the skill into the catalog repo source path (`skills/<name>`)
3. hash-verify the copied repo source against the original target content
4. preserve the original target by moving it aside, then replace the agent-home
   directory with a symlink back to the repo source
5. write a receipt that records source provenance, install mode, and rollback
   state

Promotion must preserve a rollback path. Do not remove the original target
directory before the repo copy has been verified. If a conflict exists, such as
an existing repo skill name or unsafe path, report it as a machine-readable
planning error before mutation.

## Mutation Boundaries

Read-only commands may discover provider data and report missing targets, but
they must not create target roots, receipts, symlinks, or source repo files.

Live mutations require explicit approval input or an approved command mode:

- installing or replacing target files
- creating or replacing symlinks in an agent home
- writing receipts
- copying target-created skills into the catalog repo
- importing upstream-managed source into the catalog repo
- updating `.skill-suitcase/upstream-lock.json`
- editing manifest metadata during promotion
- deleting or trashing prior target state

The default path for new platform coverage is read-only first: `targets`,
`status`, and `diff` should prove the target model before `track`, `apply`,
`reconcile --apply`, `repair --apply`, `promote`, or `import-target --apply`
touches live paths.

## Import Direction

Default dependency direction:

```txt
cli.ts -> commands -> core/domain -> adapters/interfaces/shared
commands -> renderers
```

Rules:

- Core/domain modules must not import `commands/`.
- Core/domain modules must not import `renderers/`.
- Adapter modules must not import command modules.
- `process.argv` should stay at the CLI boundary.
- `process.stdout` and `process.stderr` should stay in `cli.ts` or renderers.
- New command behavior should not be added directly to `src/cli.ts`.

## Migration Path

Skill Suitcase has completed the initial migration: `src/cli.ts` is a thin
entrypoint and the `commands/`, `core/`, `adapters/`, `renderers/`, and `config/`
boundaries now exist. The original domain-shaped files in `src/` remain as
re-export shims over `src/core/`.

The migration followed this order, which also describes how to land future
boundary moves:

1. Add the command registry and move command-specific parsing/validation into
   `src/commands/`.
2. Extract JSON and error rendering into `src/renderers/`.
3. Move feature modules into `src/core/` only when a command or feature change
   already touches that area.
4. Add adapter modules when core behavior needs filesystem or target-install IO.
5. Add import-boundary checks once the folders exist.

Avoid moving every file at once. Each change should preserve behavior and leave
the repo shippable.

## Command Module Contract

Each command module should follow this pattern:

```ts
export function registerPlanCommand(registry: CommandRegistry): void {
  registry.command("plan", async (args, deps) => {
    const input = parsePlanArgs(args);
    const result = await plan(input, deps);
    return renderJsonResult(result);
  });
}
```

The exact API can change, but the separation should not:

- parse and validate at the command boundary
- execute durable behavior in core/domain code
- render through renderer helpers
- keep process IO out of domain code

## Output Contract

Existing JSON contracts must be preserved unless a specific issue says
otherwise.

For command results:

- success JSON should remain deterministic
- error JSON should use stable fields when introduced
- usage errors should exit with code `2`
- command execution failures should exit with code `1`
- successful commands should exit with code `0`

Do not print notices, usage text, or warnings to stdout when `--json` is used.

## Adding New CLI Features

When adding a new product feature:

1. Add or extend a command module under `src/commands/`.
2. Put business behavior in `src/core/<feature>/` or an existing domain module.
3. Put filesystem or target install IO behind an adapter.
4. Render JSON through `src/renderers/`.
5. Add command-boundary tests and core behavior tests.
6. Run `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm run architecture:check`,
   and `git diff --check`.

The blunt rule: do not fatten `src/cli.ts`.

## Definition Of Done

The architecture is working when:

- `src/cli.ts` is a thin entrypoint
- commands are discoverable by command name or family
- core/domain behavior is testable without CLI process IO
- JSON stdout remains stable
- `pnpm run architecture:check` prevents obvious boundary regressions
- new feature work naturally follows the same pattern
