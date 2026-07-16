---
name: skill-suitcase
description: Use when asked to install, audit, sync, recover, track, reconcile, repair, prune, promote, import-target, apply, rollback, refresh upstream catalog source, or explain Skill Suitcase-managed agent skills, including dirty repair/import, obsolete-install pruning, target-created skill promotion, and upstream source-refresh flows, across OpenClaw, Codex, OpenClaw-Codex, Claude, Hermes, shared agents roots, Grok, or another machine using a skills catalog.
---

# Skill Suitcase

Use this skill to operate `skill-suitcase` as a cautious skill package manager.
The usual source catalog is `$HOME/.skill-suitcase/skills`; the CLI is either the installed
`skill-suitcase` binary or the source checkout at `~/repos/skill-suitcase`.

## Contract

- Treat read-only command modes as the default path: `import`, `validate`,
  `targets`, `plan`, `status`, `diff`, `pack --dry-run`,
  `reconcile --dry-run`, `repair --dry-run`, `prune --dry-run`,
  `promote --dry-run`, `import-target --dry-run`, `upstream check`, and
  `upstream fetch --dry-run`.
- Mutate a catalog or live skill root only after explicit human approval naming
  the source catalog, target or catalog skill, action, and mode.
- Work one target at a time. Do not bulk-repair every target after seeing a
  mixed status report.
- Use local path overrides instead of editing the shared catalog for another
  machine.
- Treat `skills.sh` / `npx skills` as catalog-only source refresh input when an issue explicitly asks for upstream-managed source refresh.
  Never run it directly against live Codex, Claude, OpenClaw, or other agent homes for setup or sync.
- Prefer provider/source matrix rows and `targets --json` discovery over
  hardcoding every current and future runtime variant.
- Treat manifest `groups` as reporting metadata for product families, upstream
  suites, and provider boundaries. They help summarize related skills but do not
  change install or receipt semantics.
- Use `track` only for exact existing matches.
  Preview candidates with `diff`; `track` has no dry-run flag and writes a
  receipt, so run it only after approval.
- Use `reconcile --dry-run` before `reconcile --apply`, and only for selected
  catalog-owned skills.
- Use `pack --output` then `apply --artifact` for missing or behind skills.
  Re-pack immediately before apply because ordinary artifact-mode writes come from current catalog source, not the staged file payload.
- Treat `dirty` as stop and inspect first. For a selected receipt-owned `dirty`
  skill, review `repair --dry-run`, then run `repair --apply` for that named
  skill only after explicit approval; use `rollback` to restore the pre-repair
  content. Refuse broad/all-target dirty repair.
- Use `prune --dry-run` only with an explicit repeated `--skill` list for
  receipt-owned installs no longer assigned to that target. Apply only after
  approval naming the target, exact skill list, and returned plan ID. Never
  substitute manual deletion or broad rollback.
- Use `import-target` only for the inverse of `repair`: a selected
  receipt-owned, catalog-owned skill that went `dirty` from an **intentional**
  local edit you want as the repo version. Review `import-target --dry-run`, then
  run `import-target --apply` for that named skill only after explicit approval;
  it moves target → catalog. Refuse broad/all-skills imports.
- Use `promote` only for a brand-new target-created skill that should become
  catalog source. Review `promote --dry-run`, then run `promote --apply` only
  after approval for the source catalog and exact target skill path.
- Stop and report on broad `unknown`, unexpected target paths, or provider-owned
  skills.
- Never force provider-managed Codex skills such as Codex `linear` into Suitcase
  ownership.
- Never run `pack`, `apply`, `track`, `reconcile`, `repair`, `prune`, or `import-target`
  to adopt OpenCode, Pi, or other provider-backed adapter roots, even when the
  catalog declares a custom manifest `assignmentPaths` entry for review.
- The current `rollback` command reverses apply, reconcile, and repair state, but it does not restore promotions.

## Phases

1. Discover the CLI, source catalog, target registry, and resolved install root.
2. Inspect catalog and target state with read-only commands and report blockers.
3. Stage missing or behind content outside the catalog and resolved target roots.
4. Request approval with the exact source, target, skills, action, mode, and current dry-run or diff evidence.
5. Run only the approved mutation, verify final status, and report rollback or backup evidence.

## Strict Validation Notes

Deterministic code is not applicable because this operator skill orchestrates the shipped `skill-suitcase` CLI and must not carry a second implementation of its behavior.
LLM and prompt evaluation is applicable because an agent model consumes this operator skill and its packaged default prompt.
Packaged happy-path, edge-case, and adversarial prompt fixtures verify that the expected agent response audits first and refuses unapproved catalog or target mutations.
Filing rules are not applicable because this skill does not create notes, memory, wiki, vault, or other durable knowledge artifacts.
Trigger coverage must include user requests to install, audit, sync, recover, promote, or refresh Skill Suitcase-managed skills.

## Setup

Find the CLI and catalog:

```bash
command -v skill-suitcase || true
test -d "$HOME/repos/skill-suitcase" && ls "$HOME/repos/skill-suitcase/dist/src/cli.js"
test -d "$HOME/.skill-suitcase/skills" && git -C "$HOME/.skill-suitcase/skills" status --short --branch
```

Prefer the global binary when it exists. Otherwise use the built source CLI:

```bash
cd "$HOME/repos/skill-suitcase"
pnpm() {
  npm exec --yes --package=pnpm@10.34.4 -- pnpm "$@"
}
test "$(pnpm --version)" = "10.34.4" \
  && pnpm install --frozen-lockfile \
  && pnpm run build

export SRC="$HOME/.skill-suitcase/skills"
export CLI="$HOME/repos/skill-suitcase/dist/src/cli.js"
```

With a global install:

```bash
export SRC="$HOME/.skill-suitcase/skills"
export CLI="skill-suitcase"
```

Inspect the catalog checkout before deciding whether it needs an update:

```bash
git -C "$SRC" status --short --branch
```

If the user asks to update the catalog and approves that repository mutation,
unset `SRC` before pulling.
Re-export it only after the pull and checkout inspection both succeed;
otherwise stop.
Then restart the read-only audit.

New-machine setup uses this catalog plus Suitcase `pack`, `apply`, `track`, `status`, and `diff` flows.
If a selected upstream-managed skill needs source refresh, fetch it only through the catalog-only refresh lane, review the ordinary repository diff, and then return to the normal target sync workflow.

## Upstream Source Refresh

Use this lane only when the task explicitly asks to refresh catalog source from
an upstream provider such as `skills.sh` or a pinned GitHub git source. It never
writes live agent homes.

```bash
"$CLI" upstream check --source "$SRC" --json
"$CLI" upstream fetch --source "$SRC" --skill <skill-name> --dry-run --json
# after approval for catalog-only source import:
"$CLI" upstream import --source "$SRC" --skill <skill-name> --apply --json
```

The declaration file is `.skill-suitcase/upstream-lock.json` with schema
`calvinnwq.skills.upstream-lock.v0`.
`skills-sh` entries pin an exact package version, but the referenced repository content is not pinned to a source revision or content hash, so review every fetched diff.
`git` entries pin `packageVersion` to a version tag such as `v3.8.1`
or a full commit SHA and use a GitHub owner/repo plus repo-relative skill path.
`upstream fetch` uses an isolated temp workspace/home and reports file-level
catalog diffs.
`upstream import` refuses malformed upstream lock metadata before fetching, then writes only the selected catalog skill directory plus the upstream lock metadata on success.
It does not auto-commit and does not install, receipt, or sync targets.
Strict validation checks the upstream declaration and `SKILL.md` presence for
these skills, but excludes upstream-managed skills from Skillify-10 contract
scoring because that contract applies only to locally authored/managed skills.
For other carried skills, strict validation may skip Skillify-10 scoring through manifest `validationPolicy.skillify.skip`.
Use `external-managed` only for a real external source of truth with `source`, `owner`, and `reason`; add `reviewAfter` when the provenance should be rechecked.
Use `legacy-local` only as temporary migration debt with `source`, `owner`, `reason`, and `reviewAfter`; expect a `legacy_skillify_skip` warning until the debt is removed.
If skip policy is malformed, fix the manifest rather than rewriting or installing the skill to silence validation.

Lifecycle policy:

- Upstream unchanged: report only; no target action is implied.
- Upstream changed: `upstream fetch --dry-run`, review diff,
  `upstream import --apply` for the selected skill, Git review/commit, then
  ordinary target sync.
- Local catalog edit: treat as catalog-hash drift. Commit/revert deliberately,
  or fork/adopt out of upstream-managed mode in a future explicit flow; do not
  silently overwrite it.
- Upstream removed or renamed: report missing upstream source and preserve the
  catalog until an operator decides keep, fork/adopt, rename, or delete.
- Target drift: use ordinary `status` semantics and receipts. Never call
  `npx skills` against live homes as a shortcut.

For upstream-managed skills, `upstream check --json` and `status --json` expose
lineage metadata so an operator can see the upstream package/version, upstream
repo/skill, imported hash, current catalog hash and drift, target status,
receipt hash, and receipt commit without stitching together multiple reports.
Target-scoped status should load lineage for reported skills only and should not hash unrelated upstream-managed catalog skills.

Trust boundary: trust only the exact pinned upstream package or git ref in the isolated temp workspace/home for catalog source refresh.
For skills.sh, that pin controls the installer package, not the referenced repository revision.
Do not trust upstream tooling to choose target roots, write receipts, prove rollback, or mutate live agent homes.

## Read-Only Audit

Run the catalog gates first:

```bash
"$CLI" import --source "$SRC" --json
"$CLI" validate --source "$SRC" --strict --json
"$CLI" upstream check --source "$SRC" --json
"$CLI" targets --source "$SRC" --json
"$CLI" plan --source "$SRC" --target codex --json
"$CLI" status --source "$SRC" --json
```

`import --json` and `validate --json` should report or validate manifest-owned
logical groups. Broken group references are catalog metadata problems; do not
turn a group into an implicit install target.

Manifest `sourcePolicy` is a materialization boundary. `exclude` patterns omit
reviewed generated/cache paths from packs, plan locks, diffs, and copy-mode apply
writes.
Symlink apply refuses every non-empty exclude policy with
`symlink_source_policy_exclude`, including one with no current matches.
`deny` patterns and built-in secret-like denials block selected source skills
with `source_denied_path`/`diff_source_denied_path`.
Do not work around a denied path by copying it manually into a target home.
Manifest `validationPolicy.skillify.skip` is a strict-validation boundary only.
It does not change planning, packing, installation, receipt ownership, or target drift handling.

## Source And Target Matrix

Use this matrix to choose the command shape. Add new providers as rows in the
same model; do not rewrite the workflow around provider-specific prose.

| Surface | Target id | Discover with | Local override | Mutation stance |
| --- | --- | --- | --- | --- |
| OpenClaw workspace | `openclaw` | `targets --json` | usually none | live only after approval |
| Global Codex | `codex` | `targets --json` | `--codex-home` or `--codex-skills` | live only after approval |
| OpenClaw Codex home | `openclaw-codex` | `targets --json` | target-specific Codex home if needed | live only after approval |
| Generic agent skills root | `agents` | `targets --json` | `--agents-skills` | live only after approval |
| Claude skills root | `claude` | `targets --json` | `--claude-skills` | live only after approval |
| Hermes skills root | `hermes` | `targets --json` | `--hermes-skills` | live only after approval |
| Hermes categorized external root | `hermes` | `targets --json`, then inspect `skills.external_dirs` | `--hermes-skills` overrides the owned external root only | live only after explicit config registration and approval |
| Grok Build skills root | `grok` | `targets --json` | `--grok-skills` | live only after approval |
| Provider-managed skills | provider-specific | provider/plugin docs | none in Suitcase | read-only or skip; `pack`/mutation commands refuse even custom manifest assignment paths |
| Future provider | manifest target id | `targets --json` | provider adapter override if supported | read-only until proven |

For any provider, first inspect the target:

```bash
"$CLI" targets --source "$SRC" --json
"$CLI" status --source "$SRC" --target <target-id> <local-overrides> --json
"$CLI" diff --source "$SRC" --target <target-id> <local-overrides> --json
```

Use local overrides on machines whose homes differ from the catalog defaults:

```bash
"$CLI" status --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
"$CLI" diff --source "$SRC" --target codex --codex-home "$HOME/.codex" --json

"$CLI" status --source "$SRC" --target agents --agents-skills "$HOME/.agents/skills" --json
"$CLI" diff --source "$SRC" --target agents --agents-skills "$HOME/.agents/skills" --json

"$CLI" status --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --json
"$CLI" diff --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --json

"$CLI" status --source "$SRC" --target hermes --hermes-skills "$HOME/.hermes/skills" --json
"$CLI" diff --source "$SRC" --target hermes --hermes-skills "$HOME/.hermes/skills" --json

"$CLI" status --source "$SRC" --target grok --grok-skills "$HOME/.grok/skills" --json
"$CLI" diff --source "$SRC" --target grok --grok-skills "$HOME/.grok/skills" --json
```

For categorized Hermes materialization, require the manifest adapter kind
`hermes-external-skills-root`, explicit `home` and owned external-root `path`,
and an assignment `categories` entry for every selected skill. Verify the exact
root already exists and is listed in `<home>/config.yaml` under
`skills.external_dirs`.
Never add it automatically, never write into `<home>/skills`, and stop on
registration, overlap, shadow, duplicate identity, or category-symlink findings.
In particular, stop on `hermes_external_root_unregistered`,
`hermes_external_root_local_overlap`, `hermes_external_root_precedence_overlap`,
`hermes_local_skill_shadow`, `hermes_external_skill_shadow`,
`hermes_managed_skill_shadow`, or `hermes_planned_skill_identity_conflict`.
Review each
planned `destination` (`<category>/<skill>`) and confirm the central receipt is
at the external root before any live apply.

For nested or provider-specific homes, inspect `targets` first and use only
install roots that exist on the machine and are intended to be Suitcase-owned.
Provider-backed OpenCode and Pi roots are not Suitcase-owned, so a
`read_only_target` refusal is the correct outcome for target-aware pack or
mutation flows.
Provider fallback inventory without a catalog assignment has no status entries.
A custom assigned provider path may have ordinary status entries while remaining
read-only for target-aware pack and mutation flows.
Path-driven `promote` and receipt-driven `rollback` use separate explicit scope
and ownership boundaries rather than target adapters.

## Sync Workflow

For exact installed matches that only need receipts:

```bash
"$CLI" track --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill office-hours --skill improve --skill gnhf-postflight --json
```

For selected catalog-owned receiptless drift:

```bash
"$CLI" reconcile --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill <skill-name> --dry-run --json
# after approval:
"$CLI" reconcile --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill <skill-name> --apply --json
```

For a selected receipt-owned skill that went `dirty` after external edits, stop
and inspect the planned repair first, then replace it from the catalog only after
approval (`rollback` restores the pre-repair dirty content):

```bash
"$CLI" repair --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill <skill-name> --dry-run --json
# after approval:
"$CLI" repair --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill <skill-name> --apply --json
```

For explicit receipt-owned installs that are no longer assigned to the target,
review one deterministic prune plan. Repeat the identical skill list for apply;
any receipt, directory, or symlink drift invalidates the plan ID:

```bash
"$CLI" prune --source "$SRC" --target codex --codex-home "$HOME/.codex" \
  --skill <obsolete-skill> --dry-run --json
# after approval naming target, skills, and plan id:
"$CLI" prune --source "$SRC" --target codex --codex-home "$HOME/.codex" \
  --skill <obsolete-skill> --plan-id <reviewed-plan-id> --apply --json
```

Prune quarantines physical directories, removes only symlinks whose live target
matches their receipt source, atomically updates the receipt, and reports a
transaction journal plus receipt backup. Register retained quarantine/backup
paths with the active artifact-retention workflow. If the plan quarantine root
already exists, apply refuses and preserves it. Do not manually delete it.
Prune requires `.skill-suitcase-receipt.json` and refuses legacy
`.skills-sync.json` receipts without migrating them.
Receipt-owned symlinks created by `promote` are eligible once the skill is no
longer assigned. Apply refusals keep `dryRun: false` and report `readOnly: true`,
and a missing install root is refused rather than recreated.

For a selected receipt-owned, catalog-owned skill that went `dirty` from an
intentional local edit you want in the repo, import it the other direction
(target → catalog) after approval, then verify status:

```bash
"$CLI" import-target --source "$SRC" --target openclaw --skill <skill-name> --dry-run --json
# after approval:
"$CLI" import-target --source "$SRC" --target openclaw --skill <skill-name> --apply --json
"$CLI" status --source "$SRC" --target openclaw --json
```

For a brand-new target-created skill that should become catalog source, inspect
the exact target skill directory and catalog destination first:

```bash
"$CLI" promote --source "$SRC" --target-skill "/path/to/agent-skills/new-skill" --dry-run --json
# after approval for the source catalog and exact target skill path:
"$CLI" promote --source "$SRC" --target-skill "/path/to/agent-skills/new-skill" --apply --json
```

Promotion copies the skill into catalog source, replaces the target with a
symlink, and writes receipt state.
It does not update `skill-suitcase.yaml` or add target assignment state.
If the promoted skill also needs catalog assignment, inspect and obtain separate
approval for the exact manifest change before editing it.
Inspect the ordinary Git diff after every approved catalog mutation.
Rollback does not restore promotions.

For missing, behind, or receipt-owned dirty+behind skills, stage an immutable
bundle and apply the artifact. The dirty+behind case is allowed only when the
catalog is ahead, the approved bundle writes that same skill, the bundle carries
matching packed file hashes, the live target is still a real managed directory,
and receipt metadata proves apply will not overwrite or bless unrelated target
drift. Ordinary dirty edits still require `repair` or `import-target` after
inspection:

```bash
TMP="$(mktemp -d "${TMPDIR:-/tmp}/skill-suitcase-codex.XXXXXX")"
"$CLI" pack --source "$SRC" --target codex --codex-home "$HOME/.codex" --output "$TMP" --json
find "$TMP" -maxdepth 4 -type f | sort
ARTIFACT="$(find "$TMP" -name skill-suitcase-bundle.json -print -quit)"
# after approval:
"$CLI" apply --source "$SRC" --target codex --codex-home "$HOME/.codex" --artifact "$ARTIFACT" --json
"$CLI" status --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
```

Artifact mode validates the bundle, but ordinary missing/behind writes are rebuilt from current catalog source and artifact hashes gate only the dirty-behind exception.
Neither an artifact nor a plan lock binds local target overrides, the resolved install root, or copy versus symlink mode, so approve those invocation-time choices separately.
Re-run `pack` and inspect the current `diff` immediately before artifact apply; do not treat an older artifact as byte-for-byte authorization.
Pack guards absolute resolved target paths, including CLI overrides, but does
not expand `~`, so keep staging outside the catalog and every resolved target
root.

For Git-backed catalogs, `pack`, plan-lock creation, and `apply` refuse selected
source skills that contain untracked, non-ignored files. Track or remove scratch
files in the selected skill before trying to materialize it. Manifest
`sourcePolicy.exclude` can deliberately omit reviewed generated/cache paths from
copy-mode materialization.
Symlink apply cannot omit descendants and refuses any non-empty exclude policy
with `symlink_source_policy_exclude`, including one with no current matches.
Manifest `sourcePolicy.deny` and built-in secret-like denials block materialization.
Plan-lock creation is available only through the compiled library API; there is no CLI command that writes a lock file.

For another target, keep the same pattern and replace only the target id and
override flags from the matrix.

## Decision Tree And Drift Audit

Pick the command for a single skill by its `status` and who owns the drift:
`track` for an exact match that only needs a receipt, `reconcile` for a
catalog-owned receiptless `unknown`, `promote` for a brand-new target-created
skill, `repair` to discard an accidental `dirty` edit (catalog → target), and
`import-target` to keep an intentional `dirty` edit (target → catalog). `repair`
and `import-target` see the same receipt-owned `dirty` target; only the operator
knows whether the drift was a mistake or intentional, so neither runs implicitly.

Run a lightweight drift audit/heartbeat: re-run `status` and `diff` periodically
to report when a catalog-owned skill has drifted `dirty` in a writable target.
Reporting drift is automatic; importing it is not. Review the
`import-target --dry-run` plan, then run `import-target --apply` only after
explicit approval that the drift is intentional and should become the repo
version. A drift report must never trigger an implicit import.

## Interpretation

Status meanings:

- `current`: a copy install's receipt-owned files still match the receipt and catalog; preserved extras outside `installedFiles` may remain; a symlink points to the selected catalog source without revalidating its stored receipt version/hash, provided `sourcePolicy.exclude` is empty.
- `missing`: the planned target is absent; stage with `pack --output`, then apply the artifact.
- `behind`: the receipt-owned target is unchanged while the catalog is newer; stage with `pack --output`, then apply the artifact.
  A receipt-owned `dirty` skill whose receipt hash is also behind the catalog can
  use the same pack/apply path only when the approved artifact writes that skill
  and packed-file plus receipt metadata proves the written files still match the
  last install.
- `version`: the receipt version differs from current `SKILL.md` frontmatter; inspect, stage, and apply the catalog update.
- `unknown`: existing target lacks a usable Suitcase receipt. Use `track` for
  exact matches or selected `reconcile` for catalog-owned receiptless drift.
- `dirty`: target differs from the last recorded Suitcase install. Stop and
  report the exact target path and skill. For a receipt-owned skill, `repair`
  discards the edit (catalog → target) and `import-target` keeps an intentional
  edit (target → catalog); both run `--dry-run` then `--apply` after approval.
- `blocked`: catalog compatibility intentionally refuses that target.

These seven values are the complete status enum.
Goal state for an intended target is zero `behind`, `version`, `dirty`, `missing`, `unknown`, and `blocked`.

## Output Format

After every operation, report:

- source catalog path and Git branch/SHA
- target id and resolved install root
- actions run, grouped as read-only or live mutation
- final summary counts
- rollback receipt path or backup path when live mutation ran
- skipped provider-managed skills

If any target cannot be made current, give the exact command output summary and
the next safest action.
