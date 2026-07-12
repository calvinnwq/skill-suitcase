# Skill Suitcase Current Contract

This document specifies the behavior shipped by Skill Suitcase today. It is a
current-state contract, not a product-direction document. Product direction
belongs in [`VISION.md`](VISION.md), implementation boundaries belong in
[`ARCHITECTURE.md`](ARCHITECTURE.md), and detailed command usage belongs in
[`docs/command-reference.md`](docs/command-reference.md).

## Source Of Truth

Skill Suitcase manages approved skill installs from a caller-selected, Git-backed
catalog. The catalog is canonical; runtime and agent homes are targets. A live
target does not become catalog source merely because it contains a skill or a
newer local edit.

The CLI separates three decisions:

1. inspect catalog and target state without mutation;
2. stage or lock the exact work to review;
3. mutate only through the approval boundary required by the selected command.

Upstream-to-catalog refresh and catalog-to-target installation are separate
decisions. Provider metadata may help discover compatible locations, but it does
not grant write authority or replace Suitcase receipts.

## Catalog

A catalog root contains `skill-suitcase.yaml`, canonical skill directories at
`skills/<name>/`, and any declared variant directories. The manifest may define:

- `suitcases`: named collections of skill names;
- `assignments`: target-facing selections of suitcases;
- `assignmentPaths`: target adapter kinds, assignment names, and install paths;
- `groups`: reporting metadata that references existing skills, suitcases, or
  assignments without changing install semantics;
- `compatibility`: supported or blocked agents, evidence, variants, and reasons;
- `variants`: alternate source directories selected for declared agents;
- `sourcePolicy`: reviewed exclusion and denial patterns for materialization;
- `validationPolicy.skillify.skip`: reviewed strict-validation exceptions with
  provenance appropriate to their ownership kind.

Names and references must validate deterministically. Assignments determine the
skills selected for a target; groups do not. `sourcePolicy.exclude` omits approved
generated or cache paths from packing, plan locks, diffs, and applies.
`sourcePolicy.deny`, including built-in secret-like path denials, blocks the
materialization before a target write and reports path-level evidence.

See the [catalog fixture](tests/fixtures/skills-catalog/skill-suitcase.yaml),
[manifest tests](tests/suitcase-manifest.test.ts),
[validation tests](tests/validator.test.ts), and
[source-policy tests](tests/source-policy.test.ts).

## Target Adapters And Resolution

Target resolution uses this precedence:

1. supported CLI path overrides;
2. manifest `assignmentPaths`;
3. native Skill Suitcase adapter behavior;
4. the vendored `skills.sh` compatibility snapshot.

The currently modeled target IDs are `openclaw`, `codex`, `openclaw-codex`,
`agents`, `claude`, `opencode`, `pi`, and `grok`. Supported path overrides are
`--agents-skills`, `--codex-home`, `--codex-skills`, `--claude-skills`, and
`--grok-skills`.

OpenCode and Pi are provider-backed compatibility targets and are read-only.
That policy follows the adapter kind even when a manifest supplies a custom
assignment path. Materializing or mutating commands return `read_only_target`
instead of adopting or writing those roots. Provider fallback inventory without
a catalog assignment may be discovered, but it produces no catalog status
entries.

Target resolution is covered by [target tests](tests/targets.test.ts) and
[platform-adapter tests](tests/platform-adapters.test.ts). The provider boundary
is explained in [`docs/skills-sh-delegation.md`](docs/skills-sh-delegation.md).

## Read-Only Commands

The default inspection path is read-only:

| Command | Current contract |
| --- | --- |
| `import` | Inspects and summarizes a catalog without resolving live install paths. |
| `validate` | Validates catalog structure and, with `--strict`, the local Skillify authoring contract. |
| `targets` | Resolves manifest and provider target metadata without creating paths. |
| `plan` | Resolves selected skills and variants for one target without reading or writing the target. |
| `status` | Classifies catalog-planned target entries without mutation. |
| `diff` | Compares catalog and target state without mutation. |
| `pack --dry-run` | Reports the bundle that would be staged. |
| `prune --dry-run` | Builds a removal plan for explicitly named managed skills. |
| `upstream check` | Validates pinned upstream declarations and lineage. |
| `upstream fetch` | Fetches into an isolated temporary workspace and reports catalog differences. |

The complete status enum for catalog-planned entries is `current`, `missing`,
`version`, `behind`, `dirty`, `blocked`, and `unknown`. Read-only is target
metadata, not a status value.

Read-only commands do not create install roots, runtime homes, receipts,
symlinks, or catalog files. Their command-level guarantees and known refusal
codes are defined in
[`docs/command-reference.md`](docs/command-reference.md#read-only-commands) and
exercised by [command tests](tests/commands.test.ts),
[status tests](tests/status.test.ts), and [diff tests](tests/diff.test.ts).

## Staging And Approval Inputs

`pack --output <directory>` is a staging operation. It writes only beneath the
explicit output directory and produces a bundle manifest; it does not write an
agent home. `pack --dry-run` writes nothing. Selected Git-backed source containing
untracked, non-ignored files is refused before materialization. Git-ignored files
may still be materialized unless `sourcePolicy` excludes or denies them.

A plan lock is a deterministic library artifact created by `buildPlanLock`; the
CLI does not currently expose a plan-lock creation command. A staged bundle and
a plan lock are the two accepted `apply` approval inputs, and `apply` requires
exactly one of `--artifact` or `--lock`.

The approval inputs do not make identical promises. Lock mode reassesses the
current plan and hashes against the lock. Artifact mode validates the bundle
manifest, but ordinary missing or behind writes are rebuilt from current catalog
source. Artifact file hashes authorize only the dirty-behind exception. An old
bundle is therefore not byte-for-byte authorization for every later write.

See [packing tests](tests/packer.test.ts),
[plan-lock tests](tests/plan-lock.test.ts), and
[apply tests](tests/apply.test.ts).

## Live Mutation

Live mutation requires an explicit command-specific boundary:

| Command | Required boundary | Mutation scope |
| --- | --- | --- |
| `apply` | exactly one reviewed plan lock or staged artifact | selected writable target and receipt |
| `track` | explicit invocation after an exact unreceipted match is inspected | receipt only |
| `reconcile --apply` | matching `--dry-run` review and explicit approval | receiptless mismatched target replaced from catalog |
| `repair --apply` | matching `--dry-run` review and explicit approval | dirty receipt-owned copy restored from catalog |
| `prune --apply` | explicit skills plus exact plan ID from `--dry-run` | obsolete receipt-owned installs |
| `rollback` | explicit receipt path | receipt-backed state eligible for rollback |
| `promote --apply` | matching `--dry-run` review and explicit approval | new target skill copied to catalog and linked back |
| `import-target --apply` | matching `--dry-run` review and explicit approval | intentional receipt-owned target edit copied to catalog |
| `upstream import --apply` | reviewed fetch/diff and explicit approval | selected catalog source and upstream lock only |

Mutation is limited to writable, resolved roots and named or planned skills.
Commands validate containment, ownership, current filesystem state, and relevant
hashes before destructive work. Transactional workflows attempt to restore
their pre-operation receipt and filesystem state when an operation fails. They
do not auto-commit catalog changes.

`apply` supports `copy` and `symlink` install modes. Copy is the default.
Symlink mode links the selected current catalog source to the target and records
that mode explicitly; filesystem shape alone does not establish ownership.

Detailed preconditions and refusal cases live in
[`docs/command-reference.md`](docs/command-reference.md#mutating-commands).

## Receipts

The receipt at `.skill-suitcase-receipt.json` is the target-side ownership
record. Its schema is `calvinnwq.skills.receipt.v0`. A managed install record
captures the skill, target path, source path and provenance, install mode,
version and content hashes, installed-file hashes, and rollback metadata when
available.

Receipt updates use atomic replacement and a receipt-local transaction lock.
Concurrent workflows must not silently discard one another's records. A legacy
`.skills-sync.json` receipt can be recognized where explicitly supported, but
safety-sensitive workflows may refuse it rather than migrating ownership
implicitly.

A receipt proves what Skill Suitcase recorded; commands still compare it with
the current catalog and filesystem before mutation. Receipt behavior is covered
by [receipt tests](tests/receipt.test.ts) and
[concurrent apply tests](tests/apply.test.ts).

## Rollback And Recovery

Rollback is receipt-driven and scoped to rollback metadata that the installing
or repair workflow captured. It restores prior copy content, removes a
Suitcase-created symlink only when the link still matches its recorded source,
and updates the receipt. It refuses missing, invalid, escaped, or drifted state
rather than deleting an unproven path. It is not a general Git rollback and does
not undo promotions or arbitrary catalog edits.

Recovery commands have distinct ownership meanings:

- `track` adopts an existing target only when it exactly matches catalog source;
- `reconcile` replaces a receiptless mismatch with catalog source;
- `repair` replaces accidental drift in a receipt-owned copy with catalog source;
- `prune` removes explicitly selected receipt-owned installs no longer assigned;
- `promote` imports a new target-created skill into catalog ownership;
- `import-target` imports an intentional edit to an existing catalog-owned skill.

`repair`, `prune`, and `import-target` provide read-only plans with hashes and
affected paths before apply. `prune` additionally binds apply to a stable plan
ID and quarantines physical directories transactionally. Recovery semantics are
covered by [rollback tests](tests/rollback.test.ts),
[repair tests](tests/repair.test.ts), [prune tests](tests/prune.test.ts), and
[import-target tests](tests/import-target.test.ts).

## Upstream Refresh

`.skill-suitcase/upstream-lock.json` uses schema
`calvinnwq.skills.upstream-lock.v0` to declare pinned `skills-sh` or Git sources
and their last imported provenance. Upstream refresh is catalog-only:

```text
pinned fetch -> isolated temporary workspace -> catalog diff -> catalog import
```

`upstream check` and `upstream fetch` are read-only. `upstream import --apply`
writes only the selected catalog skill and lock metadata, then leaves the Git
diff for review. It never installs directly into a live agent home and never
replaces target receipts. `skills-sh` declarations pin the installer package
version, not the referenced repository content revision, so every fetched diff
still requires review. Git declarations pin a version tag or full commit SHA.

See [upstream tests](tests/upstream.test.ts) and
[`docs/skills-sh-delegation.md`](docs/skills-sh-delegation.md).

## Output Contract

The CLI is JSON-first. With JSON output selected, one deterministic structured
result plus a trailing newline is written to stdout. Findings, warnings, and
known command errors represented as `ok: false` are part of that stdout result.

Parser and usage failures, uncaught fatal diagnostics, and non-JSON notices go
to stderr. They must not be mixed into machine-readable stdout. Exit status is
derived separately from the structured result or fatal failure.

This boundary is enforced by [renderer tests](tests/renderers.test.ts),
[CLI tests](tests/cli.test.ts), and the architectural dependency guard in
[architecture guardrail tests](tests/architecture-guardrails.test.ts).

## Non-Goals

The current contract does not:

- treat live runtime homes as canonical source;
- infer approval from detected drift;
- allow provider compatibility data to grant target write ownership;
- call `npx skills` as a normal live target installer;
- make upstream import equivalent to target installation;
- auto-commit catalog mutations;
- provide a CLI command that creates plan locks;
- guarantee that an older staged artifact authorizes current catalog bytes;
- restore arbitrary catalog changes through `rollback`;
- assign install semantics to manifest groups;
- expand support to an undeclared target merely because a provider knows its
  path.

