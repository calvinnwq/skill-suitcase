# Command Reference

This reference describes the current `skill-suitcase` command surface.
The README is the product overview and safe starting path, [`SPEC.md`](../SPEC.md)
is the normative current-state contract, and this document carries the longer
operational detail.

All CLI command forms require `--json`.
Result objects go to stdout, including structured `ok: false` results with machine-readable errors.
Parser/usage failures and uncaught fatal diagnostics go to stderr.
Examples use portable paths; set `SRC` and target overrides for the machine running the CLI.

```bash
SRC="/path/to/skills-catalog"
```

## Read-Only Commands

### `import`

```bash
skill-suitcase import --source "$SRC" --json
```

Inspects an existing catalog without changing it. It checks for
`skill-suitcase.yaml`, the `skills/<name>/SKILL.md` layout, portability metadata,
variants, assignments, compatibility, and manifest logical groups.

Findings have `warning` or `error` levels. Warnings preserve `ok: true`; errors
produce a failure exit status. Support directories marked with
`.support-directory` are not treated as installable skills.

### `validate`

```bash
skill-suitcase validate --source "$SRC" --json
skill-suitcase validate --source "$SRC" --strict --json
```

Validates manifest structure and referenced catalog content. Strict mode also
applies the Skillify authoring contract, honoring only valid reviewed
`validationPolicy.skillify.skip` entries.

### `targets`

```bash
skill-suitcase targets --source "$SRC" --json
```

Reports target IDs, assignments, adapter metadata, resolved paths, per-path
existence, and safety classification. Local overrides have higher priority than
manifest assignments.

Available overrides are:

- `--agents-skills <dir>`
- `--codex-home <dir>`
- `--codex-skills <dir>`
- `--claude-skills <dir>`
- `--hermes-skills <dir>`
- `--grok-skills <dir>`

These overrides are accepted by `targets`, `status`, `diff`, `pack`, `apply`,
`track`, `reconcile`, `repair`, `prune`, and `import-target`.
For Hermes, use `--hermes-skills "$HOME/.hermes/skills"` for the default profile or point it at `$HOME/.hermes/profiles/<name>/skills` for a named profile.
For `hermes-external-skills-root`, `--hermes-skills` overrides only the dedicated
external-root `path`; the manifest's explicit `home` still identifies the
read-only `config.yaml` and local `$HERMES_HOME/skills` collision boundary.
Create that root, then register its exact path in Hermes `skills.external_dirs`
before `status`, `diff`, or a live target mutation. Skill Suitcase reports
`hermes_external_root_unregistered` and never creates the root or edits the file
for you.
The adapter also fails closed when the root overlaps `<home>/skills`, a local or
earlier external skill shadows a planned `SKILL.md` identity, an earlier root
overlaps the owned root, planned identities are duplicated, or a traversed
category is a symlink.
The resolved destination is preserved through plan locks, artifacts, apply,
status, diff, receipts, track, reconcile, repair, import-target, prune, and
rollback while the single receipt remains at the external root.

### `plan`

```bash
skill-suitcase plan --source "$SRC" --target codex --json
```

Resolves the selected assignment and emits each skill's action, variant, source
path, relative destination, evidence, and any blocked reason.
It does not resolve target install paths,
choose install modes, hash content, or read/write live targets.
Flat targets use the skill name as the destination; categorized Hermes targets
use `<category>/<skill>`.
If an assignment is exposed through both flat and categorized paths, select an
explicit assignment path ID as `--target`; assignment-only planning returns
`ambiguous_assignment_path_layout`.

### `diff`

```bash
skill-suitcase diff \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --json
```

Compares catalog source with the live modeled target. File actions are
`create`, `update`, `unchanged`, `extra`, `missing`, or `blocked`.
Planned entries retain the relative destination used beneath the install root.
Source-policy failures, blocked variants, and read-only targets are reported.
`diff` does not run the Git source-hygiene check; `pack`, plan-lock creation,
and `apply` enforce the untracked-source materialization gate.

### `status`

```bash
skill-suitcase status --source "$SRC" --json
skill-suitcase status \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --json
```

Classifies planned installs using catalog content, live content, receipts, and
install mode.
Each status entry reports its resolved relative destination.
States include:

- `current`: for copy installs, receipt-owned target files still match the receipt and the receipt hash/version match catalog source; preserved target extras outside `installedFiles` do not make the skill dirty; for symlink installs, the live link points to the selected catalog source and `sourcePolicy.exclude` is empty (the stored receipt version/hash is not revalidated on that path)
- `missing`: planned target is absent
- `version`: the installed receipt version differs from current `SKILL.md`
  frontmatter; review the change, then stage and `apply` the catalog update
- `behind`: receipt-owned target is unchanged but catalog is newer
- `dirty`: live receipt-owned target drifted
- `blocked`: manifest or target policy prevents the install
- `unknown`: status could not be proven because of receiptless target state,
  unreadable source/target state, invalid target shape, incomplete receipt
  integrity metadata, or an unsupported install mode; only the receiptless
  mismatched-directory case routes to `reconcile`

Those seven values are the complete status enum. Provider fallback inventory
without a catalog assignment, such as the default OpenCode and Pi entries,
appears with `statusCount: 0` and no status entries. A custom provider path tied
to a catalog assignment may produce ordinary status entries; read-only is not a
separate status value.

For upstream-managed skills, status may add lineage: upstream package/version,
upstream repo/skill, imported hash, current catalog hash, target status,
receipt hash, and receipt commit.

### `upstream check`

```bash
skill-suitcase upstream check --source "$SRC" --json
```

Reports validated `.skill-suitcase/upstream-lock.json` declarations and imported
lineage without fetching or writing anything.

### `upstream fetch`

```bash
skill-suitcase upstream fetch \
  --source "$SRC" \
  --skill existing-skill \
  --dry-run \
  --json
```

Fetches the declared upstream through its pinned provider package/ref into an
isolated temporary workspace/home and reports its diff from the catalog. Git
declarations pin a source tag or commit; skills.sh declarations pin the
installer package version but not the referenced repository content revision.
It never writes the catalog or live agent homes.

## Staging

### `pack`

```bash
skill-suitcase pack --source "$SRC" --target codex --dry-run --json

OUT="$(mktemp -d "${TMPDIR:-/tmp}/skill-suitcase-pack.XXXXXX")"
skill-suitcase pack \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --output "$OUT" \
  --json
```

Dry-run reports the bundle plan. With `--output`, pack writes an immutable
bundle below the explicit directory and returns its artifact manifest. It does
not touch the live target. The manifest records source provenance, selected
skills, file hashes, planned target entries, resolved destinations, and blocked
entries.
Each staged file is stored beneath `skills/<destination>/`, and destination
metadata participates in the artifact ID.

Pack refuses output beneath an absolute resolved install root, including CLI target overrides.
The shipped guard does not expand home-relative strings such as `~`, so it is not a substitute for choosing a safe output.
Pack also refuses selected untracked, non-ignored source files, `sourcePolicy.deny` matches, and provider-managed read-only targets.
Git-ignored regular files may still be materialized unless `sourcePolicy` excludes or denies them, so inspect the staged artifact.
Always use a temporary output directory outside both the catalog and every resolved target root so staging does not dirty either workspace.
Skill Suitcase does not prune old artifact directories automatically.

### Plan-lock creation (library API)

There is no CLI command that creates a plan lock. Repository and library callers
can build the compiled module, create the deterministic lock, write the returned
JSON to an approved path, and then pass that path to `apply --lock`:

```js
import { writeFile } from "node:fs/promises";
import { buildPlanLock, assessPlanLock } from "./dist/src/plan-lock.js";

const source = "/path/to/skills-catalog";
const target = "codex";
const assignmentPath = "codex";

const lock = await buildPlanLock({ source, target, assignmentPath });
await writeFile("/path/to/plan-lock.json", `${JSON.stringify(lock, null, 2)}\n`);

const assessment = await assessPlanLock({
  source,
  target,
  assignmentPath,
  lock
});
// assessment: { valid: boolean, reasons: string[], current: lock | null }
```

`buildPlanLock` returns schema `calvinnwq.skills.plan-lock.v0` with source
provenance, target and assignment identity, selected skills, planned entries
including resolved destinations, per-file hashes, and a deterministic `planId`.
It refuses selected untracked, non-ignored source files through a thrown error; ignored regular files can still enter the lock hashes.
`assessPlanLock` rebuilds current facts and returns drift reason strings such as `source_commit_changed`, `plan_entries_changed`, or `file_hashes_changed`.
For backward compatibility, a flat v0 lock without `destination` is assessed as
if every entry used its skill name.
The lock does not resolve or bind a target install root, local target overrides, or copy versus symlink mode; approve those apply-time choices separately.
The module does not write the lock file itself.

## Explicit Mutation Commands

### `apply`

```bash
skill-suitcase apply \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --artifact "/path/to/staged/skill-suitcase-bundle.json" \
  --json

skill-suitcase apply \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --lock "/path/to/plan-lock.json" \
  --mode symlink \
  --json
```

Requires exactly one approved input: a staged artifact or plan lock.
Apply performs writes transactionally and updates the target receipt with a record for every installed skill.
Copy is the default mode.
Symlink mode links selected source paths inside the catalog source root.

The two approval inputs do not currently provide identical guarantees.
Lock mode reassesses the current plan and file hashes against the lock.
Artifact mode validates artifact schema, source/target metadata, and staging provenance, but ordinary missing/behind writes are rebuilt from current catalog source.
Artifact `fileHashes` are enforced only for the dirty-behind update exception.
A tracked catalog change or newly planned skill after packing may therefore be written by artifact apply without matching the staged bytes/plan.
Categorized destinations are an additional approval invariant:
`artifact_destination_mismatch` refuses apply when the staged destination no
longer matches the current plan.
Existing flat v0 artifacts without destination metadata remain valid and use
the skill name as their destination.
Neither approval input binds local target overrides, the resolved install root, or `--mode`; approve the exact source, target path, and copy/symlink mode at invocation time.
Re-run `pack` immediately before artifact apply and inspect the current `diff`; do not use an older artifact as byte-for-byte authorization.

Important refusals include stale or malformed approval input, blocked variants,
unmanaged existing targets, unapproved dirty content, source-policy failures,
read-only targets, and symlink source escapes/conflicts.
Copy mode omits paths selected by `sourcePolicy.exclude`.
Symlink mode cannot omit descendants and refuses every non-empty exclude policy
with `symlink_source_policy_exclude`, including one with no current matches.

### `track`

```bash
skill-suitcase track \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --skill existing-skill \
  --json
```

Adopts an already-correct copy or symlink install by writing a receipt.
It never rewrites skill files.
Repeat `--skill` for targeted adoption; omit it for the all-planned-skills mode.

### `reconcile`

```bash
skill-suitcase reconcile \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --skill existing-skill \
  --dry-run \
  --json

skill-suitcase reconcile \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --skill existing-skill \
  --apply \
  --json
```

Targets selected `unknown` catalog-planned skills.
At least one `--skill` is required, and the flag is repeatable.
Dry-run reports target and catalog differences plus the backup path.
Apply preserves the prior target as rollback state, installs catalog source, writes a receipt, and verifies status.

### `repair`

```bash
skill-suitcase repair \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --skill existing-skill \
  --dry-run \
  --json

skill-suitcase repair \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --skill existing-skill \
  --apply \
  --json
```

Targets selected `dirty`, receipt-owned copy installs when catalog source should win.
At least one `--skill` is required, and the flag is repeatable.
Dry-run reports receipt/catalog/live hashes, file changes, and the backup plan.
Apply backs up live content, installs catalog source, refreshes the receipt, and verifies `current` status.

### `prune`

```bash
skill-suitcase prune \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --skill obsolete-skill \
  --dry-run \
  --json

skill-suitcase prune \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --skill obsolete-skill \
  --plan-id <reviewed-plan-id> \
  --apply \
  --json
```

Prunes only explicit receipt-owned installs that are no longer assigned to the
selected writable target. Dry-run is read-only and returns a stable plan ID
derived from the receipt hash, selected skills, object kinds, directory file
hashes, and symlink targets. Apply requires the same skill list and exact plan
ID, then recomputes all state before mutation.

Physical directories move into a plan-scoped quarantine. Symlinks are removed
only when their current target still matches their receipt source. Apply writes
a transaction journal and receipt backup, updates the receipt atomically, and
attempts to restore the prior receipt and completed filesystem mutations after
any failure. Apply refuses and preserves a pre-existing plan quarantine root
instead of reusing or cleaning it. Assigned,
unreceipted, drifted, read-only/provider-backed, and path-escaping candidates
are refused. Retain the reported quarantine and backup paths for reviewed
cleanup; never replace prune with manual deletion or broad rollback.
Prune requires the modern `.skill-suitcase-receipt.json` receipt and safely
refuses legacy `.skills-sync.json` instead of migrating it.
Receipt-owned symlinks created by `promote` are prunable once they are no longer
assigned to the selected target. A missing install root is refused and is not
recreated. Apply refusals keep `dryRun: false` to represent the requested mode,
set `readOnly: true`, and perform no mutation.

### `rollback`

```bash
skill-suitcase rollback \
  --receipt "/path/to/target/.skill-suitcase-receipt.json" \
  --json
```

Reverses recorded apply, reconcile, or repair state. Rollback first verifies
that current target bytes still match the applied receipt; drift is a refusal,
not something it overwrites. The current rollback command does not restore
promotions.
For categorized Hermes records, rollback uses the recorded nested target and
destination while refusing category-parent symlinks or containment escapes.
The receipt may be addressed through a valid symlinked install-root or parent
alias. Rollback resolves that alias for containment checks, still refuses a
symlinked target leaf, and does not create parents for a missing receipt path.

### `promote`

```bash
skill-suitcase promote \
  --source "$SRC" \
  --target-skill "$HOME/.codex/skills/new-skill" \
  --dry-run \
  --json

skill-suitcase promote \
  --source "$SRC" \
  --target-skill "$HOME/.codex/skills/new-skill" \
  --apply \
  --json
```

Moves a new target-created skill into catalog ownership. Apply copies the
content, verifies hashes, replaces the original directory with a symlink to the
catalog, and records the preserved backup path in its receipt. The promotion
receipt is not executable by the current `rollback` command, which treats the
symlink install as a safe no-op.

### `import-target`

```bash
skill-suitcase import-target \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --skill existing-skill \
  --dry-run \
  --json

skill-suitcase import-target \
  --source "$SRC" \
  --target codex \
  --codex-home "$HOME/.codex" \
  --skill existing-skill \
  --apply \
  --json
```

Targets intentional edits to selected dirty, receipt-owned catalog skills.
At least one `--skill` is required, and the flag is repeatable.
Dry-run reports receipt, catalog, and target hashes plus planned repository writes.
Apply copies target content into the catalog atomically, refreshes the receipt, and leaves normal Git changes for review.

### `upstream import`

```bash
skill-suitcase upstream import \
  --source "$SRC" \
  --skill existing-skill \
  --apply \
  --json
```

Repeats the pinned isolated fetch, refuses dirty selected catalog source, and
writes only `skills/<name>` plus `.skill-suitcase/upstream-lock.json`. It never
installs into a live target and never commits the resulting Git diff.

## Receipt Library API

The compiled `dist/src/receipt.js` module exports helpers for building, reading, merging, and writing schema `calvinnwq.skills.receipt.v0` receipts.

```js
import {
  buildInstallRecord,
  buildInstalledFiles,
  upsertAndWriteReceipt
} from "./dist/src/receipt.js";

const installedFiles = await buildInstalledFiles("/target/root/my-skill");
const installRecord = buildInstallRecord({
  agent: "claude",
  mode: "copy",
  sourcePath: "/path/to/skills-catalog/skills/my-skill",
  targetPath: "/target/root/my-skill",
  destination: "my-skill",
  version: "1.2.0",
  installedFiles
});

await upsertAndWriteReceipt({
  installRoot: "/target/root",
  skillName: "my-skill",
  installRecord
});
```

`buildInstalledFiles` hashes regular files while skipping `__pycache__` directories and `.pyc` files; its optional `{ exclude }` iterable omits selected paths.
`buildReceipt` creates a receipt shell, `upsertInstallRecord` merges an install record in memory, and `upsertAndWriteReceipt` merges against disk before writing `.skill-suitcase-receipt.json`.
`readReceipt` reads modern receipts or migrates legacy `.skills-sync.json` data in memory without writing, while `writeReceipt` replaces the full receipt payload.
All receipt writers serialize through a receipt-local lock, replace receipt files atomically, preserve an existing receipt's permissions, and create new receipts with mode `0600`.
`updateAndWriteReceipt` performs an arbitrary read-modify-write while holding that lock.
Core live-mutation workflows that need receipt unwind use `withReceiptTransaction`; pass its `receiptLock` and `recordMutation` members to nested receipt writers, then call `rollbackRecordedMutations` if the workflow fails.
`withReceiptLock`, `ReceiptMutation`, and `rollbackReceiptMutations` remain the lower-level primitives for transactions with intentionally different semantics, including prune's journaled quarantine transaction and rollback's single guarded receipt update.
The lock is released when its callback ends, and orphaned locks from terminated processes are recovered automatically.
Custom receipt paths must remain inside `installRoot`, and multiple installs for one skill are represented as an array under that skill name.
Managed workflows write each install's relative `destination`.
Flat legacy records without that field remain valid, while categorized Hermes
ownership requires it to match `<category>/<skill>`.

## Common Refusal Codes

Command results use command-specific machine-readable errors. Common safety
codes include:

- `read_only_target`: a target-aware materialization or mutation flow cannot
  adopt or write a provider-managed target
- `source_denied_path` / `diff_source_denied_path`: source policy blocked a path
- `symlink_source_policy_exclude`: symlink apply cannot enforce a non-empty
  source exclusion policy
- `source_untracked_files`: selected materialized source is not fully reviewable
  in Git; reported by pack and apply rather than `diff` (plan-lock creation
  enforces the same gate through a thrown error)
- `unsafe_target_state`: apply found unmanaged or unapproved live state
- `plan_lock_<reason>`: current facts no longer match lock proof, for example
  `plan_lock_current_plan_unavailable`, `plan_lock_target_mismatch`, or
  `plan_lock_source_mismatch`
- `symlink_source_escape`: requested link would leave the approved catalog root
- `symlink_target_conflict`: live target shape cannot be replaced implicitly
- `receipt_lock_failed`: a mutating workflow could not acquire or use the
  serialized receipt transaction lock
- `missing_skill_category` / `invalid_skill_category`: a categorized Hermes
  assignment lacks one safe category segment for a selected skill
- `ambiguous_assignment_path_layout`: one assignment is exposed through both
  flat and categorized paths without an explicit path selection
- `hermes_external_root_unregistered`: the categorized root does not both exist
  and resolve from Hermes `skills.external_dirs`
- `hermes_external_root_local_overlap` /
  `hermes_external_root_precedence_overlap`: the owned root overlaps the local
  skills tree or an earlier external root
- `hermes_local_skill_shadow` / `hermes_external_skill_shadow` /
  `hermes_managed_skill_shadow` / `hermes_planned_skill_identity_conflict`: a
  higher-precedence, duplicate, or misplaced `SKILL.md` identity would make
  Hermes resolve a different skill
- `hermes_shadow_directory_symlink` / `external_category_symlink` /
  `external_destination_escape`: safe categorized containment cannot be proven
- `artifact_destination_mismatch`: an artifact's approved categorized
  destination differs from the current plan
- state-specific repair/reconcile/prune/import refusals when the selected skill does
  not meet that workflow's ownership and drift contract

Treat a refusal as a request to inspect state and choose the correct workflow,
not as a reason to bypass the receipt or approval boundary.
