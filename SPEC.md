# Skill Suitcase Current Contract

This document specifies the behavior shipped by Skill Suitcase today. It is a
current-state contract, not a product-direction document. Product direction
belongs in [`VISION.md`](VISION.md), implementation boundaries belong in
[`ARCHITECTURE.md`](https://github.com/calvinnwq/skill-suitcase/blob/main/ARCHITECTURE.md), and detailed command usage belongs in
[`docs/command-reference.md`](docs/command-reference.md).

## Source Of Truth

Skill Suitcase manages approved skill installs from a caller-selected catalog.
A Git-backed catalog is the preferred operating model because it provides reviewable provenance and recovery, but planning and target materialization also accept a non-Git catalog directory.
Workflows with stronger source-control requirements, including upstream import, refuse a catalog outside a Git worktree.
The catalog is canonical; runtime and agent homes are targets.
A live target does not become catalog source merely because it contains a skill or a newer local edit.

The CLI separates three decisions:

1. inspect catalog and target state without mutation;
2. stage or record planned work for review;
3. mutate only through the approval boundary required by the selected command.

Upstream-to-catalog refresh and catalog-to-target installation are separate
decisions. Provider metadata may help discover compatible locations, but it does
not grant write authority or replace Suitcase receipts.

## Catalog

A catalog root contains `skill-suitcase.yaml`, canonical skill directories at
`skills/<name>/`, and any declared variant directories. The manifest may define:

- `suitcases`: named collections of skill names;
- `assignments`: target-facing selections of suitcases and optional per-skill
  `categories` for categorized target adapters;
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
generated or cache paths from packing, plan locks, diffs, and copy-mode
materialization. Symlink apply cannot hide excluded descendants, so it refuses
any exclude policy with `symlink_source_policy_exclude`, including a policy whose
patterns have no current matches.
`sourcePolicy.deny`, including built-in secret-like path denials, blocks the
materialization before a target write and reports path-level evidence.

See the [public sample catalog](examples/sample-catalog/README.md),
[internal regression fixture](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/fixtures/skills-catalog/skill-suitcase.yaml),
[manifest tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/suitcase-manifest.test.ts),
[validation tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/validator.test.ts), and
[source-policy tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/source-policy.test.ts).

## Target Adapters And Resolution

Target resolution uses this precedence:

1. supported CLI path overrides;
2. manifest `assignmentPaths`;
3. native Skill Suitcase adapter behavior;
4. the vendored `skills.sh` compatibility snapshot.

The currently modeled target IDs are `openclaw`, `codex`, `openclaw-codex`,
`agents`, `claude`, `hermes`, `opencode`, `pi`, and `grok`.
Supported path overrides are
`--agents-skills`, `--codex-home`, `--codex-skills`, `--claude-skills`,
`--hermes-skills`, and `--grok-skills`.
The writable `hermes-skills-root` adapter uses the same direct install-root pattern as `openclaw-skills-root`.
The default profile normally targets `$HOME/.hermes/skills`, while a named profile targets `$HOME/.hermes/profiles/<name>/skills`.
The writable `hermes-external-skills-root` adapter instead requires explicit
`home` and `path` fields and materializes each assigned skill at
`<path>/<category>/<skill>`. Its assignment must declare one safe plain category
segment for every selected skill:

```yaml
assignments:
  hermes:
    suitcases:
      - core
    categories:
      agent-swarm: autonomous-ai-agents

assignmentPaths:
  hermes:
    kind: hermes-external-skills-root
    assignment: hermes
    home: $HOME/.hermes
    path: $HOME/.hermes/skill-suitcase/skills
```

Before materialization, the operator creates the external root and registers its
exact path in `<home>/config.yaml` under `skills.external_dirs`. The adapter
requires both conditions and never edits that configuration. It also refuses a
same-name skill under `<home>/skills` or elsewhere in the owned external root,
category symlinks, path traversal, unmanaged destination collisions, and receipt destination drift.
The one receipt remains at the external root. Existing flat Hermes targets are
unchanged.

OpenCode and Pi are provider-backed compatibility targets and are read-only.
That policy follows the adapter kind even when a manifest supplies a custom
assignment path. Target-aware materialization and mutation flows (`pack`,
`apply`, `track`, `reconcile`, `repair`, `prune`, and `import-target`) return
`read_only_target` instead of adopting or writing those roots. Path-driven
`promote` and receipt-driven `rollback` do not resolve target adapters; their
explicit path or receipt scope and ownership checks are separate safety
boundaries. Provider fallback inventory without a catalog assignment may be
discovered, but it produces no catalog status entries.

Target resolution is covered by [target tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/targets.test.ts) and
[platform-adapter tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/platform-adapters.test.ts). The provider boundary
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
| `reconcile --dry-run` | Plans replacement of explicitly named receiptless mismatches from catalog source. |
| `repair --dry-run` | Plans restoration of explicitly named dirty receipt-owned copies from catalog source. |
| `prune --dry-run` | Builds a removal plan for explicitly named managed skills. |
| `promote --dry-run` | Plans moving one new target-created skill into catalog ownership. |
| `import-target --dry-run` | Plans importing explicitly named intentional target edits into catalog source. |
| `upstream check` | Validates pinned upstream declarations and lineage. |
| `upstream fetch --dry-run` | Fetches into an isolated temporary workspace and reports catalog differences. |

The complete status enum for catalog-planned entries is `current`, `missing`,
`version`, `behind`, `dirty`, `blocked`, and `unknown`. Read-only is target
metadata, not a status value.

Read-only commands do not create install roots, runtime homes, receipts,
symlinks, or catalog files. Their command-level guarantees and known refusal
codes are defined in
[`docs/command-reference.md`](docs/command-reference.md#read-only-commands) and
exercised by [command tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/commands.test.ts),
[status tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/status.test.ts), and [diff tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/diff.test.ts).

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

Neither approval input binds the resolved live install root, CLI target path overrides, or copy-versus-symlink mode.
Those choices are supplied or resolved again at apply time and must be reviewed separately.

See [packing tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/packer.test.ts),
[plan-lock tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/plan-lock.test.ts), and
[apply tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/apply.test.ts).

## Live Mutation

Live mutation requires an explicit command-specific boundary.
The CLI enforces only the boundaries listed below.
Operators should first review the corresponding read-only plan, fetch, or diff, but the CLI does not bind that review to the later mutation except where `apply` validates its approval input and `prune` validates an exact plan ID.

| Command | Enforced CLI boundary | Mutation scope |
| --- | --- | --- |
| `apply` | exactly one plan lock or staged artifact | selected writable target and receipt |
| `track` | explicit invocation; the target must exactly match catalog source | receipt only |
| `reconcile --apply` | `--apply` plus explicitly named skills | receiptless mismatched target replaced from catalog |
| `repair --apply` | `--apply` plus explicitly named skills | dirty receipt-owned copy restored from catalog |
| `prune --apply` | explicit skills plus exact plan ID from `--dry-run` | obsolete receipt-owned installs |
| `rollback` | explicit receipt path | receipt-backed state eligible for rollback |
| `promote --apply` | `--apply` plus an explicit target skill path | new target skill copied to catalog and linked back |
| `import-target --apply` | `--apply` plus explicitly named skills | intentional receipt-owned target edit copied to catalog |
| `upstream import --apply` | `--apply` plus exactly one named skill | selected catalog source and upstream lock only |

Mutation is limited to writable resolved roots or explicit path and receipt
scopes, and to named or planned skills.
Commands validate containment, ownership, current filesystem state, and relevant
hashes before destructive work. Transactional workflows attempt to restore
their pre-operation receipt and filesystem state when an operation fails. They
do not auto-commit catalog changes.

`apply` supports `copy` and `symlink` install modes. Copy is the default.
Symlink mode links the selected current catalog source to the target and records
that mode explicitly; filesystem shape alone does not establish ownership.

Detailed preconditions and refusal cases live in
[`docs/command-reference.md`](docs/command-reference.md#explicit-mutation-commands).

## Receipts

The receipt at `.skill-suitcase-receipt.json` is the target-side ownership
record. Its schema is `calvinnwq.skills.receipt.v0`. A managed install record
captures the skill, target path, source path and provenance, install mode,
version and content hashes, installed-file hashes, resolved relative
destination, and rollback metadata when available. Older receipt records without
`destination` remain valid.

Receipt updates use atomic replacement and a receipt-local transaction lock.
Concurrent workflows must not silently discard one another's records. A legacy
`.skills-sync.json` receipt can be recognized where explicitly supported, but
safety-sensitive workflows may refuse it rather than migrating ownership
implicitly.

A receipt proves what Skill Suitcase recorded; commands still compare it with
the current catalog and filesystem before mutation. Receipt behavior is covered
by [receipt tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/receipt.test.ts) and
[concurrent apply tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/apply.test.ts).

## Rollback And Recovery

Rollback is receipt-driven and scoped to rollback metadata that `apply`, `reconcile`, or `repair` captured.
It restores prior copy content or removes copy installs that were previously missing, removes a Suitcase-created symlink only when the link still matches its recorded source, and updates the receipt.
It refuses missing, invalid, escaped, or drifted state rather than deleting an unproven path.
It is not a general Git rollback and does not undo promotions or arbitrary catalog edits.

Recovery and promotion commands have distinct ownership meanings:

- `track` adopts an existing target only when it exactly matches catalog source;
- `reconcile` replaces a receiptless mismatch with catalog source;
- `repair` replaces accidental drift in a receipt-owned copy with catalog source;
- `prune` removes explicitly selected receipt-owned installs no longer assigned;
- `promote` imports a new target-created skill into catalog ownership;
- `import-target` imports an intentional edit to an existing catalog-owned skill.

`reconcile`, `repair`, `prune`, `promote`, and `import-target` provide read-only plans before apply.
Those plans report the evidence relevant to their workflows, including affected paths, hashes, differences, backup locations, or planned steps.
`prune` additionally binds apply to a stable plan ID and quarantines physical directories transactionally.
Recovery and promotion semantics are covered by [rollback tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/rollback.test.ts), [reconcile tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/reconcile.test.ts), [repair tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/repair.test.ts), [prune tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/prune.test.ts), [promote tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/promote.test.ts), and [import-target tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/import-target.test.ts).

## Upstream Refresh

`.skill-suitcase/upstream-lock.json` uses schema
`calvinnwq.skills.upstream-lock.v0` to declare pinned `skills-sh` or Git sources
and their last imported provenance. Upstream refresh is catalog-only:

```text
pinned fetch -> isolated temporary workspace -> catalog diff -> catalog import
```

`upstream check` and `upstream fetch --dry-run` are read-only.
`upstream import --apply` writes only the selected catalog skill and lock metadata, then leaves the Git diff for review.
It never installs directly into a live agent home and never replaces target receipts.
`skills-sh` declarations pin the installer package version, not the referenced repository content revision, so every fetched diff still requires review.
Git declarations pin a version tag or full commit SHA.

See [upstream tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/upstream.test.ts) and
[`docs/skills-sh-delegation.md`](docs/skills-sh-delegation.md).

## Output Contract

The CLI is JSON-first. With JSON output selected, one deterministic structured
result plus a trailing newline is written to stdout. Findings, warnings, and
known command errors represented as `ok: false` are part of that stdout result.

Parser and usage failures, uncaught fatal diagnostics, and non-JSON notices go
to stderr. They must not be mixed into machine-readable stdout. Exit status is
derived separately from the structured result or fatal failure.

This boundary is enforced by [renderer tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/renderers.test.ts),
[CLI tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/cli.test.ts),
[architecture contract tests](https://github.com/calvinnwq/skill-suitcase/blob/main/scripts/architecture-contract.test.mjs), and
[architecture guardrail tests](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/architecture-guardrails.test.ts).

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
