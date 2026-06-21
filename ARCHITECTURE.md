# Skill Suitcase CLI Architecture

This is the source of truth for how Skill Suitcase's TypeScript CLI should be
structured as it grows. It applies the shared TypeScript CLI refactor pattern
from Linear `NGX-420` to this repo.

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
  not as an implicit side effect.
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
