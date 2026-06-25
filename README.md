# Skill Suitcase

Skill Suitcase is a CLI for planning portable skill installs from a catalog repo.
See [`VISION.md`](VISION.md) for the product north star: an agent-first skill
package manager where the CLI is the backbone, a renamable skills repository is
the source-of-truth warehouse, and runtime integrations consume the same
contract.

Read-only commands (`plan`, `diff`, `pack --dry-run`, `import`, `validate`,
`targets`, `status`, `upstream check`, and `upstream fetch`) read a catalog
manifest, resolve assignments and assignment paths, and emit JSON plans, diffs,
import findings, target discovery, bundle manifests, status reports, or upstream
source-refresh reports without touching target install paths or runtime homes.

The `apply` command materializes skills in target install paths. It requires
an explicit approval input (plan-lock or staging artifact), refuses unmanaged
targets or untracked selected source files, writes copy installs transactionally,
can update a receipt-owned `dirty` skill only when the catalog is also ahead and
the approved input carries matching per-file hash proof for the same skill, can
create approved repo-pointing symlinks with `--mode symlink`, and emits receipts.

The `rollback` command reverses receipt-backed apply, reconcile, or repair
changes. It restores recorded previous contents, removes files, directories, or
symlinks the mutation created, and refuses when the target has drifted from the
recorded applied state.

The `track` command adopts skills that are already installed in a target. It
verifies the live files or root symlink match the catalog source, then writes
receipts so the existing install comes under Suitcase management without
rewriting any skill files. Repeat `--skill <name>` to adopt only selected
matching skills.

The `reconcile` command repairs selected catalog-owned target skills that are
unknown because the target exists without a Suitcase receipt and differs from the
catalog. `reconcile --dry-run` reports the live-vs-catalog changes and planned
backup path without mutation; `reconcile --apply` requires explicit approval,
replaces the selected target from catalog source, preserves the prior target as
rollback/backup state, writes a receipt, and verifies status can become current.
Use `track` for exact matches, `apply` for approved lock/artifact installs, and
`promote` for target-created skills that need to become catalog source.

The `repair` command restores selected receipt-owned copy-mode target skills
that became `dirty` after external edits. It is the safe recovery path when a
managed target differs from its Suitcase receipt: `repair --dry-run` reports the
target path, receipt hash, catalog hash, changed files, and backup/rollback plan
without mutation; `repair --apply` requires explicit approval, backs up the dirty
live content, replaces the target from catalog source, writes a receipt, and
verifies the skill returns to `current`. A later `rollback` restores the
pre-repair dirty target from the receipt-owned backup. Repair only owns
explicitly selected `dirty` receipt-owned copy installs and refuses every other
state: `unknown` routes to `track`/`reconcile`, `missing`/`behind` route to
`pack` + `apply`, and symlink-mode or read-only targets are rejected.

The `promote` command converts a target-created skill into a repo-owned catalog
skill. `promote --dry-run` reports the read-only plan and conflicts; `promote
--apply` copies the target into the catalog, verifies it, replaces the target
with a repo-pointing symlink, and writes a receipt.

The `import-target` command preserves intentional edits made to an existing
receipt-owned target skill. `import-target --dry-run` reports the target and
catalog hashes plus planned repo writes without mutation; `import-target
--apply` requires explicit approval, copies the target skill back into the
catalog source, refreshes the target receipt, and leaves ordinary git changes
for review.

The `upstream` command family refreshes catalog source from pinned upstream
providers.
`upstream check` reports declared upstream-managed skills and their lineage
metadata without mutation.
`upstream fetch --dry-run` fetches one selected skill into an isolated temp
workspace/home and reports the catalog diff.
`upstream import --apply` repeats that pinned fetch, refuses dirty selected
catalog source, writes only the selected catalog skill directory plus
`.skill-suitcase/upstream-lock.json`, and leaves ordinary git changes for review.

## Install

```bash
npm install -g skill-suitcase
skill-suitcase plan --source /path/to/skills-catalog --target openclaw --json
```

For agent setup, including installing the packaged `skill-suitcase` operator
skill into Codex or Claude, follow [`INSTALL.md`](INSTALL.md).

For local development, build and run the compiled CLI directly:

## Usage

```bash
pnpm run build
node dist/src/cli.js plan --source /Users/ngxcalvin/repos/skills --target openclaw --json
node dist/src/cli.js diff --source /Users/ngxcalvin/repos/skills --target openclaw --json
node dist/src/cli.js pack --source /Users/ngxcalvin/repos/skills --target openclaw --dry-run --json
node dist/src/cli.js pack --source /Users/ngxcalvin/repos/skills --target openclaw --output /tmp/skill-suitcase-openclaw --json
node dist/src/cli.js import --source /Users/ngxcalvin/repos/skills --json
node dist/src/cli.js validate --source /Users/ngxcalvin/repos/skills --json
node dist/src/cli.js validate --source /Users/ngxcalvin/repos/skills --strict --json
node dist/src/cli.js targets --source /Users/ngxcalvin/repos/skills --json
node dist/src/cli.js status --source /Users/ngxcalvin/repos/skills --json
node dist/src/cli.js status --source /Users/ngxcalvin/repos/skills --target codex --codex-home ~/.codex --json
node dist/src/cli.js apply --source /Users/ngxcalvin/repos/skills --target openclaw --lock /tmp/plan-lock.json --json
node dist/src/cli.js apply --source /Users/ngxcalvin/repos/skills --target openclaw --artifact /tmp/skill-suitcase-bundle.json --json
node dist/src/cli.js apply --source /Users/ngxcalvin/repos/skills --target openclaw --lock /tmp/plan-lock.json --mode symlink --json
node dist/src/cli.js rollback --receipt /tmp/openclaw-install/.skill-suitcase-receipt.json --json
node dist/src/cli.js track --source /Users/ngxcalvin/repos/skills --target openclaw --json
node dist/src/cli.js track --source /Users/ngxcalvin/repos/skills --target openclaw --skill office-hours --skill skillify --skill gnhf-postflight --json
node dist/src/cli.js reconcile --source /Users/ngxcalvin/repos/skills --target openclaw --skill skill-cleaner --dry-run --json
node dist/src/cli.js reconcile --source /Users/ngxcalvin/repos/skills --target openclaw --skill skill-cleaner --apply --json
node dist/src/cli.js repair --source /Users/ngxcalvin/repos/skills --target openclaw --skill skill-cleaner --dry-run --json
node dist/src/cli.js repair --source /Users/ngxcalvin/repos/skills --target openclaw --skill skill-cleaner --apply --json
node dist/src/cli.js promote --source /Users/ngxcalvin/repos/skills --target-skill ~/.codex/skills/new-skill --dry-run --json
node dist/src/cli.js promote --source /Users/ngxcalvin/repos/skills --target-skill ~/.codex/skills/new-skill --apply --json
node dist/src/cli.js import-target --source /Users/ngxcalvin/repos/skills --target openclaw --skill skill-cleaner --dry-run --json
node dist/src/cli.js import-target --source /Users/ngxcalvin/repos/skills --target openclaw --skill skill-cleaner --apply --json
node dist/src/cli.js upstream check --source /Users/ngxcalvin/repos/skills --json
node dist/src/cli.js upstream fetch --source /Users/ngxcalvin/repos/skills --skill hyperframes --dry-run --json
node dist/src/cli.js upstream import --source /Users/ngxcalvin/repos/skills --skill hyperframes --apply --json
```

`import --json` is a read-only onboarding inspection for existing skills repos.
It checks for `skill-suitcase.yaml`, the `skills/<name>/SKILL.md` layout, and
catalog portability metadata such as assignments, assignment paths,
compatibility, variants, and manifest-owned logical groups. Findings are
emitted as deterministic JSON with `warning` or `error` levels; warnings keep
`ok: true`, while errors make the command exit with failure status. The command
never creates install roots, runtime homes, receipts, or bundle artifacts.
Directories under `skills/` that contain `.support-directory` are treated as
support data and are not counted as installable skills.

Supported target adapters currently include:

- `openclaw`
- `codex`
- `openclaw-codex`
- `agents`
- `claude`
- `opencode`
- `pi`

Platform adapters are explicit. `openclaw-skills-root` uses the declared `path`
as the workspace skill root. `codex-home` installs into `skillsPath` without
assuming a universal Codex home. `agents-skills-root` uses the declared `path`
for generic `$HOME/.agents/skills` installs. `claude-skills-root` uses the
declared `path`. The `nested-home-codex` adapter is still supported for legacy
nested homes, but it is not part of the current default target set.
Provider-backed `opencode-skills-root` and `pi-skills-root` entries are compatibility/reference targets with read-only metadata, not Suitcase-owned install roots.

Smoke-test discovery with:

```bash
node dist/src/cli.js targets --source /path/to/skills-catalog --json
```

On machines where the shared catalog's checked-in install paths do not match
the local runtime homes, pass local target overrides instead of editing the
catalog:

```bash
node dist/src/cli.js targets --source /path/to/skills-catalog --agents-skills ~/.agents/skills --codex-home ~/.codex --claude-skills ~/.claude/skills --json
node dist/src/cli.js status --source /path/to/skills-catalog --target codex --codex-home ~/.codex --json
node dist/src/cli.js status --source /path/to/skills-catalog --target agents --agents-skills ~/.agents/skills --json
node dist/src/cli.js diff --source /path/to/skills-catalog --target claude --claude-skills ~/.claude/skills --json
```

`--codex-home <dir>` overrides the `codex` `codexHome` and defaults its
`skillsPath` to `<dir>/skills`. `--codex-skills <dir>` can override that skills
path directly. `--agents-skills <dir>` overrides the generic `agents` skills
root. `--claude-skills <dir>` overrides the `claude` skills root.
These flags work with `targets`, `status`, `diff`, `pack`, `apply`, `track`,
`reconcile`, `repair`, and `import-target`. Use `status --target <target>` with
an assignment path id or assignment name. If an exact assignment path id exists,
it wins, so `--target codex` means the global Codex target rather than every
target assigned to Codex.

See [`docs/install-smoke.md`](docs/install-smoke.md) for command-level smoke
checks and [`docs/portability-matrix.md`](docs/portability-matrix.md) for
canonical bundle versus platform variant rules.
The `skills.sh` installer delegation spike is documented in
[`docs/skills-sh-delegation.md`](docs/skills-sh-delegation.md); current guidance
is to defer runtime delegation, keep Skill Suitcase native installs
authoritative, and treat `skills.sh` / `npx skills` source refresh as a
catalog-only upstream lane. New-machine setup installs from the skills repo
through Suitcase; upstream refresh can later update selected catalog source
directories through reviewable repository diffs.
Release and public-readiness decisions are tracked in
[`docs/release-readiness.md`](docs/release-readiness.md).

## Safe Read-Only And Staging Workflows

Start with read-only commands. These inspect the catalog and target state
without creating install roots, runtime homes, receipts, symlinks, or source
repo files:

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

Use staging bundles before live mutation:

```bash
TMP="$(mktemp -d /tmp/skill-suitcase-pack.XXXXXX)"
node "$CLI" pack --source "$SRC" --target codex --codex-home "$HOME/.codex" --output "$TMP" --json
find "$TMP" -maxdepth 3 -type f | sort
rm -rf "$TMP"
```

Live `apply`, `track`, `reconcile --apply`, `repair --apply`, `rollback`,
`promote --apply`, or `import-target --apply` should target disposable fixtures
first or require explicit approval for the real agent home and catalog repo.

## Fresh Codex/Claude Machine

For a machine with Codex and Claude but no OpenClaw, keep the catalog as the
shared source of truth and supply local paths at command time:

Do not run `skills.sh` or `npx skills` directly against live Codex or Claude homes for new-machine setup.
If an upstream-managed skill needs a refresh, fetch it through the catalog-only source refresh lane first, review the ordinary repository diff, then use the normal Suitcase target sync commands below.

```bash
cd ~/repos/skill-suitcase
pnpm install
pnpm build

export SRC="$HOME/repos/skills"
export CLI="$HOME/repos/skill-suitcase/dist/src/cli.js"

mkdir -p "$HOME/.codex/skills" "$HOME/.claude/skills"

node "$CLI" import --source "$SRC" --json
node "$CLI" validate --source "$SRC" --strict --json
node "$CLI" plan --source "$SRC" --target codex --json
node "$CLI" plan --source "$SRC" --target claude --json

node "$CLI" status --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
node "$CLI" diff --source "$SRC" --target codex --codex-home "$HOME/.codex" --json

node "$CLI" status --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --json
node "$CLI" diff --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --json
```

## Upstream Source Refresh

Upstream-managed skills are declared in `.skill-suitcase/upstream-lock.json`.
The lock file is catalog metadata, separate from target assignments and receipts:

```json
{
  "schema": "calvinnwq.skills.upstream-lock.v0",
  "skills": {
    "hyperframes": {
      "provider": "skills-sh",
      "packageVersion": "1.5.11",
      "upstream": {
        "repo": "heygen-com/hyperframes",
        "skill": "hyperframes"
      },
      "group": "hyperframes",
      "imported": {
        "sha256": "previous-catalog-tree-hash",
        "packageVersion": "1.5.11",
        "at": "2026-06-24T01:00:00.000Z",
        "source": "skills-sh:heygen-com/hyperframes:hyperframes"
      }
    },
    "last30days": {
      "provider": "git",
      "packageVersion": "v3.8.1",
      "upstream": {
        "repo": "mvanhorn/last30days-skill",
        "skill": "."
      },
      "group": "last30days"
    }
  }
}
```

`provider` must be `skills-sh` or `git`. For `skills-sh`, `packageVersion` must
be an exact pinned package version and optional `packageName` defaults to
`skills`. For `git`, `packageVersion` must be a pinned version tag such as
`v3.8.1` or a full commit SHA, `repo` must be a GitHub owner/repo or HTTPS
GitHub URL, and `skill` is the repo-relative skill path (`"."` means repo root).
The optional `imported` block records the last imported catalog tree hash, the
package version or git ref that produced it, the import timestamp, and the
provider source string.
`upstream check --json` and `status --json` reuse this metadata in their
`lineage` blocks so operators can audit upstream-to-catalog and catalog-to-target
state without stitching reports together.
Target-scoped `status --json` reports compute lineage only for reported skills and do not hash unrelated upstream-managed catalog skills.

Check declared upstream skills without writing files:

```bash
node "$CLI" upstream check --source "$SRC" --json
```

Fetch a selected skill into an isolated temp workspace/home and review the
catalog diff:

```bash
node "$CLI" upstream fetch --source "$SRC" --skill hyperframes --dry-run --json
```

Import the selected fetched source into the catalog only:

```bash
node "$CLI" upstream import --source "$SRC" --skill hyperframes --apply --json
```

`upstream import` refuses malformed upstream locks and dirty or untracked selected catalog source before it fetches.
It updates the catalog skill directory and
`.skill-suitcase/upstream-lock.json`, but it does not auto-commit and does not
write to Codex, Claude, OpenClaw, or other live target roots. After reviewing
and committing the repo diff, use the normal `pack`/`apply`/`status` target sync
commands.

Lifecycle policy:

- Upstream unchanged: `upstream check` is enough. It implies no target action.
- Upstream changed: run `upstream fetch --dry-run`, review the catalog diff, run
  `upstream import --apply` only for the selected skill, commit the repo diff,
  then use normal target sync.
- Local catalog edit: treat it as catalog-hash drift from the last imported
  upstream hash. Do not silently overwrite it; commit/revert deliberately, or
  fork/adopt the skill out of upstream-managed mode in a future explicit flow.
- Upstream removed or renamed: report the missing upstream skill and preserve
  the current catalog source plus upstream lock until an operator decides
  whether to keep, fork/adopt, rename, or delete it.
- Target drift: use ordinary `status` semantics. `track` exact matches,
  `pack`/`apply` missing or behind skills, and stop on dirty targets for
  `repair` or `import-target`. Do not use `npx skills` against live target roots
  as a shortcut.

Trust boundary: Skill Suitcase only runs an exact pinned upstream package inside
an isolated temp workspace/home for source refresh, then validates the fetched
skill stays inside that sandbox and contains `SKILL.md`. Upstream tooling is not
trusted to choose live target roots, write receipts, prove rollback state, or
mutate agent homes.

If matching skills already exist, adopt them without rewriting files:

```bash
node "$CLI" track --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill office-hours --skill gnhf-postflight --json
node "$CLI" track --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --skill office-hours --skill gnhf-postflight --json
```

If selected existing skills are unknown because they lack receipts and differ
from the catalog, inspect the reconcile plan first and run the live replacement
only with explicit approval:

```bash
node "$CLI" reconcile --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill office-hours --dry-run --json
node "$CLI" reconcile --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill office-hours --apply --json
```

If selected receipt-owned skills are `dirty` because they were edited after
install, stop and inspect the planned repair first, then replace from catalog
with `repair --apply` only after explicit approval:

```bash
node "$CLI" repair --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill office-hours --dry-run --json
node "$CLI" repair --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill office-hours --apply --json
```

If a selected receipt-owned skill is `dirty` because you intentionally edited it
in the target and want that version in the catalog, stop and inspect the
import-target plan first, then import back into the repo only after explicit
approval:

```bash
node "$CLI" import-target --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill office-hours --dry-run --json
node "$CLI" import-target --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill office-hours --apply --json
```

Then apply missing or behind skills from a temporary bundle:

```bash
TMP=$(mktemp -d /tmp/skill-suitcase-codex.XXXXXX)
node "$CLI" pack --source "$SRC" --target codex --codex-home "$HOME/.codex" --output "$TMP" --json
ARTIFACT=$(find "$TMP" -name skill-suitcase-bundle.json -print -quit)
node "$CLI" apply --source "$SRC" --target codex --codex-home "$HOME/.codex" --artifact "$ARTIFACT" --json
rm -rf "$TMP"

TMP=$(mktemp -d /tmp/skill-suitcase-claude.XXXXXX)
node "$CLI" pack --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --output "$TMP" --json
ARTIFACT=$(find "$TMP" -name skill-suitcase-bundle.json -print -quit)
node "$CLI" apply --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --artifact "$ARTIFACT" --json
rm -rf "$TMP"
```

Final verification should show no creates, updates, dirty files, unknown entries,
or blocked skills for the local targets.

## `import` Output

`import` accepts `--source <skills-repo> --json` and inspects an existing catalog
without requiring a target. It returns absolute `source` and `manifestPath`
values, summary counts, a sorted `skills` inventory, and deterministic findings.

```json
{
  "ok": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "manifestPath": "/Users/ngxcalvin/repos/skills/skill-suitcase.yaml",
  "summary": {
    "discoveredSkills": 1,
    "referencedSkills": 1,
    "suitcases": 1,
    "assignments": 1,
    "assignmentPaths": 1,
    "groups": 1,
    "compatibilityEntries": 1,
    "variantEntries": 1,
    "warnings": 0,
    "errors": 0,
    "findings": 0
  },
  "groups": [
    {
      "name": "portable-core",
      "title": "Portable Core",
      "description": "Skills intended to travel across supported agent runtimes.",
      "provider": null,
      "upstream": null,
      "skills": [],
      "suitcases": ["core"],
      "assignments": ["codex"],
      "tags": ["portable"]
    }
  ],
  "skills": [
    {
      "name": "office-hours",
      "path": "/Users/ngxcalvin/repos/skills/skills/office-hours",
      "skillFile": "/Users/ngxcalvin/repos/skills/skills/office-hours/SKILL.md",
      "referencedBy": ["core"],
      "groups": ["portable-core"],
      "compatibility": {
        "declared": true,
        "agents": ["codex"],
        "blockedAgents": [],
        "variant": "canonical",
        "evidence": ["README.md"]
      },
      "variants": [
        {
          "name": "codex",
          "source": "variants/codex/office-hours",
          "agents": ["codex"],
          "exists": true,
          "skillFileExists": true
        }
      ]
    }
  ],
  "findings": []
}
```

Each finding has `level`, `code`, `message`, and `path`. Warning codes include
`missing_assignment_paths`, `empty_suitcase`, `empty_group`,
`unused_compatibility`,
`missing_compatibility`, `missing_compatibility_agents`,
`missing_compatibility_variant`, `missing_variant_metadata`,
`missing_variant_agents`, and `unused_variants`. Error codes include
`missing_manifest`, `unreadable_manifest`, `missing_skills_directory`,
`unreadable_skills_directory`, `missing_suitcases`, `missing_assignments`,
`empty_assignment`, `unknown_suitcase`, `invalid_group`,
`unknown_group_skill`, `unknown_group_suitcase`, `unknown_group_assignment`,
`invalid_assignment_path`,
`unknown_assignment_path_target`, `invalid_skill_name`,
`missing_skill_directory`, `missing_skill_file`, `missing_variant_source`,
`invalid_variant_source`, `missing_variant_directory`, and
`missing_variant_skill_file`.

## Manifest Logical Groups

`skill-suitcase.yaml` may declare a top-level `groups` map for product families,
upstream suites, provider boundaries, or reporting buckets:

```yaml
groups:
  portable-core:
    title: Portable Core
    description: Skills intended to travel across supported runtimes.
    suitcases:
      - core
    assignments:
      - codex
      - claude
    tags:
      - portable
```

Groups are catalog metadata only. They do not change planning, packing,
installation, receipts, or assignment semantics. A group can reference
`skills`, `suitcases`, and `assignments`; `import --json` reports group
summaries and per-skill group membership, while `validate --json` checks that
referenced skills, suitcases, and assignments exist. Use groups when reports
need to summarize related skills without relying on directory names, ad hoc
descriptions, or target-specific assumptions.

## Manifest Source Policy

`skill-suitcase.yaml` may declare a top-level `sourcePolicy` for pack-time
materialization boundaries:

```yaml
sourcePolicy:
  exclude:
    - "**/.cache/**"
    - "**/dist/**"
  deny:
    - "**/secrets/**"
```

`exclude` patterns are intentionally omitted from `pack`, plan-lock hashes, and
the source side of `diff`/`apply`. Use them for generated artifacts or cache
directories that should stay in the repo but never ship to agent homes. `deny`
patterns are hard refusals: if a selected skill contains a matching path, pack,
plan-lock creation, and apply return `source_denied_path` (or
`diff_source_denied_path` when surfaced through apply's diff layer) with the
skill and relative path. Built-in secret-like denials cover `.env`, `.npmrc`,
`.pypirc`, private key files, and common SSH key names.

## `validate` Strict Mode

`validate --source <skills-repo> --json` runs fast catalog-health checks only, including manifest relationships, logical-group references, per-skill `SKILL.md` presence, and upstream lock metadata when `.skill-suitcase/upstream-lock.json` exists.
Adding `--strict` extends the same command into strict Skillify-10 contract
validation for catalog-authored skills referenced by a suitcase. Skills declared
in `.skill-suitcase/upstream-lock.json` are upstream-managed provider source, so
strict mode tracks their declarations but skips Skillify-10 scoring for them.
For skills carried from another maintained source that should not be rewritten
to match the local Skillify contract, declare an explicit validation policy in
`skill-suitcase.yaml`:

```yaml
validationPolicy:
  skillify:
    skip:
      lavish:
        kind: external-managed
        source: agents-global
        owner: upstream
        reason: Maintained by an external agent-skill source; Suitcase carries it for install/sync only.
        reviewAfter: 2026-09-01
```

Use `external-managed` only when the skill has a real external source of truth.
The entry must include `source`, `owner`, and `reason`; `reviewAfter` is optional
but recommended so provenance can be rechecked. Use `legacy-local` only as a
temporary local migration exemption; it requires `reviewAfter` and always emits
a warning. Upstream-lock remains the preferred source of truth for
`upstream-managed` skills.
If a manifest uses `kind: upstream-managed`, the same skill must also be declared in `.skill-suitcase/upstream-lock.json`; duplicate `source`, `owner`, or `reason` metadata on that manifest entry is only advisory and produces a warning.
Basic validation parses this section but validates skip entries only in strict mode.

```bash
node dist/src/cli.js validate --source /Users/ngxcalvin/repos/skills --strict --json
```

Strict mode mirrors the deterministic checks in
`skills/skillify/scripts/check_skillify_contract.py` from the catalog repo, so
the CLI scores each skill the same way without shelling out to Python.
All validation results include `summary.groups`, the number of manifest-owned logical groups, and `summary.upstreamDeclarations`, the number of valid upstream-managed skills declared in `.skill-suitcase/upstream-lock.json`.

Strict validation gains these top-level fields:

- `strict`: `true` when strict scoring ran (`false` for basic validation, where
  `contracts` is always empty).
- `contracts`: one report per referenced skill, sorted by skill name. Each
  report has `skill`, `score`, `total` (always `10`), `complete`, and the ten
  `items`. Every item carries `id`, `name`, `ok`, `applicable`, `evidence`, and
  `missing` reasons. Evidence paths are emitted relative to the source root for
  deterministic JSON.

The `summary` object also includes `contractsEvaluated`, `contractsComplete`, `contractsSkippedUpstream`, `contractsSkippedExternal`, and `contractsSkippedLegacy` counts.
These contract counters are `0` for basic validation.
`contractsSkippedUpstream` is the number of referenced upstream-managed skills excluded from Skillify-10 scoring.
`contractsSkippedExternal` counts referenced `external-managed` policy skips.
`contractsSkippedLegacy` counts referenced `legacy-local` policy skips.
Upstream lock findings are release-blocking errors.
Those error codes include `invalid_upstream_lock_json`,
`invalid_upstream_lock_schema`, `invalid_upstream_skill_name`,
`invalid_upstream_declaration`, `unsupported_upstream_provider`,
`invalid_upstream_package_version`, `invalid_upstream_package_name`,
`invalid_upstream_identity`, `invalid_upstream_group`,
`invalid_upstream_imported`, and `unreferenced_upstream_skill`.
Skillify skip policy errors are also release-blocking in strict mode.
Those error codes include `invalid_skillify_skip_skill_name`, `unreferenced_skillify_skip`, `invalid_skillify_skip_kind`, `invalid_skillify_skip_upstream`, `invalid_skillify_skip_upstream_overlap`, `missing_skillify_skip_metadata`, `missing_skillify_skip_review_after`, and `invalid_skillify_skip_review_after`.

Strict mode distinguishes warnings from release-blocking failures:

- An **applicable** item that is not satisfied becomes a
  `skillify_contract_failed` error finding, which flips `ok` to `false` and exits
  non-zero. These are release-blocking.
- A **not-applicable** item (for example LLM evals on a skill that makes no model
  calls, or filing rules on a skill that writes no notes) that lacks evidence
  becomes a `skillify_contract_warning`, which is reported but keeps `ok: true`.
- An `external-managed` policy skip removes that skill from Skillify-10 scoring
  only after provenance metadata validates.
  A missing `reviewAfter` is a warning, but an invalid date is an error.
- A `legacy-local` policy skip also removes that skill from Skillify-10 scoring,
  but emits `legacy_skillify_skip` so old local debt remains visible until the
  review date.
  Missing or invalid `reviewAfter` is an error for `legacy-local`.

```json
{
  "ok": false,
  "strict": true,
  "summary": { "referencedSkills": 5, "groups": 1, "upstreamDeclarations": 1, "contractsEvaluated": 3, "contractsComplete": 2, "contractsSkippedUpstream": 1, "contractsSkippedExternal": 1, "contractsSkippedLegacy": 0, "findings": 3 },
  "contracts": [
    {
      "skill": "office-hours",
      "score": 7,
      "total": 10,
      "complete": false,
      "items": [
        {
          "id": 4,
          "name": "Integration tests or realistic local fixture tests",
          "ok": false,
          "applicable": true,
          "evidence": [],
          "missing": ["add integration test using real endpoint or realistic local fixture"]
        }
      ]
    }
  ],
  "findings": [
    {
      "level": "error",
      "code": "skillify_contract_failed",
      "message": "Skill office-hours fails Skillify-10 item 4 (Integration tests or realistic local fixture tests): add integration test using real endpoint or realistic local fixture.",
      "path": "skills.office-hours.contract.4"
    }
  ]
}
```

## `upstream` Output

`upstream` is a source-refresh command family for catalog-owned skills.
Every subcommand requires `--source <skills-repo> --json`.
It does not accept target flags because upstream refresh writes catalog source
only, then ordinary `pack`, `apply`, `status`, and `diff` commands synchronize
live targets from the reviewed catalog.

`upstream check` is read-only and reports the declarations and lineage metadata
in `.skill-suitcase/upstream-lock.json`:

```json
{
  "ok": true,
  "readOnly": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "lockPath": "/Users/ngxcalvin/repos/skills/.skill-suitcase/upstream-lock.json",
  "declarations": [
    {
      "skill": "hyperframes",
      "provider": "skills-sh",
      "packageName": "skills",
      "packageVersion": "1.5.11",
      "upstreamRepo": "heygen-com/hyperframes",
      "upstreamSkill": "hyperframes",
      "group": "hyperframes",
      "importedHash": "previous-catalog-tree-hash",
      "importedPackageVersion": "1.5.11",
      "importedAt": "2026-06-24T01:00:00.000Z",
      "importedSource": "skills-sh:heygen-com/hyperframes:hyperframes",
      "catalogHash": "current-catalog-tree-hash",
      "lineage": {
        "upstream": {
          "provider": "skills-sh",
          "packageName": "skills",
          "packageVersion": "1.5.11",
          "repo": "heygen-com/hyperframes",
          "skill": "hyperframes",
          "group": "hyperframes"
        },
        "imported": {
          "hash": "previous-catalog-tree-hash",
          "packageVersion": "1.5.11",
          "at": "2026-06-24T01:00:00.000Z",
          "source": "skills-sh:heygen-com/hyperframes:hyperframes"
        },
        "catalog": {
          "hash": "current-catalog-tree-hash",
          "drift": "catalog-hash-drift"
        },
        "target": null
      },
      "packageAvailable": true,
      "refresh": "catalog-hash-drift",
      "errors": []
    }
  ],
  "summary": { "declared": 1, "packageAvailable": 1, "failures": 0 },
  "errors": []
}
```

`refresh` is `unknown` when no imported hash or catalog hash is available,
`unchanged` when the imported hash matches the current catalog tree, and
`catalog-hash-drift` when the catalog has changed after the last recorded
import.

`lineage` is the audit-friendly form of the same source data. In
`upstream check`, `lineage.target` is always `null` because upstream refresh is
catalog-only and never reads or writes live targets.

`upstream fetch --skill <name> --dry-run` fetches a selected upstream skill into
an isolated temp workspace/home, validates that the fetched directory remains
inside that sandbox and contains `SKILL.md`, and returns a file-level diff
without writing the catalog or targets:

```json
{
  "ok": true,
  "readOnly": true,
  "dryRun": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "skill": "hyperframes",
  "fetchedSkillPath": "/var/folders/.../skill-suitcase-upstream-.../workspace/...",
  "diff": [
    { "relativePath": "SKILL.md", "action": "update", "catalogHash": "old", "upstreamHash": "new" },
    { "relativePath": "new-only.txt", "action": "create", "catalogHash": null, "upstreamHash": "new" }
  ],
  "summary": { "create": 1, "update": 1, "delete": 0, "unchanged": 0 },
  "errors": []
}
```

`upstream import --skill <name> --apply` first checks the selected catalog skill
directory and upstream lock path with Git.
It refuses malformed upstream locks, non-Git catalogs, uncommitted local edits, untracked selected source files, and unpinned upstream package versions before fetching.
If validation or fetch output is invalid, it preserves the existing catalog skill, upstream lock, and live targets.
On success it copies the fetched skill into `skills/<name>`, updates `.skill-suitcase/upstream-lock.json`, and reports ordinary repository diffs for review:

```json
{
  "ok": true,
  "readOnly": false,
  "apply": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "skill": "hyperframes",
  "catalogSkillPath": "/Users/ngxcalvin/repos/skills/skills/hyperframes",
  "summary": { "create": 1, "update": 1, "delete": 0, "unchanged": 0, "filesWritten": 2 },
  "metadata": {
    "lockPath": "/Users/ngxcalvin/repos/skills/.skill-suitcase/upstream-lock.json",
    "importedHash": "new-catalog-tree-hash"
  },
  "errors": []
}
```

Upstream error codes include `unknown_upstream_skill`,
`invalid_upstream_lock_json`, `invalid_upstream_lock_schema`,
`invalid_upstream_skill_name`, `invalid_upstream_declaration`,
`unsupported_upstream_provider`, `invalid_upstream_package_version`,
`invalid_upstream_package_name`, `invalid_upstream_identity`,
`invalid_upstream_group`, `invalid_upstream_imported`,
`upstream_package_runner_missing`, `upstream_fetch_failed`,
`upstream_fetch_missing_skill`, `upstream_fetch_outside_sandbox`,
`upstream_fetch_missing_skill_file`, `source_hygiene_requires_git`,
`source_hygiene_failed`, `dirty_catalog_source`, and
`upstream_import_failed`.

## `plan` Output

```json
{
  "ok": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "target": "openclaw",
  "planned": [
    {
      "skill": "office-hours",
      "action": "install",
      "variant": "canonical",
      "sourcePath": "/Users/ngxcalvin/repos/skills/skills/office-hours",
      "evidence": ["docs/install-smoke.md"]
    }
  ],
  "blocked": [],
  "errors": []
}
```

`plan` reports package-level actions (`install`/`blocked`) and no file-level
`entries`.

Each planned item records the resolved `variant` name, which defaults to
`canonical` (or the `compatibility.<skill>.variant` label). When the catalog
declares a matching source variant for the resolved platform, `variant` is that
variant's name and an extra `source` field carries its catalog-relative source
path. These `variant` and `source` fields flow through `diff`, `pack`, `apply`,
`track`, `reconcile`, `repair`, `import-target`, receipts, and `status`. See
[`docs/portability-matrix.md`](docs/portability-matrix.md) for the variant
selection rules.

`diff` resolves `--target` to an assignment plus install root, then adds
file-level `entries` and a summary:

## `diff` Output

```json
{
  "ok": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "target": "openclaw",
  "assignment": "openclaw",
  "installRoot": "/tmp/openclaw/skills",
  "planned": [
    {
      "skill": "office-hours",
      "action": "install",
      "variant": "canonical",
      "sourcePath": "/Users/ngxcalvin/repos/skills/skills/office-hours",
      "evidence": ["docs/install-smoke.md"]
    }
  ],
  "blocked": [],
  "entries": [
    {
      "action": "create",
      "skill": "office-hours",
      "relativePath": "SKILL.md",
      "targetPath": "/tmp/openclaw/skills/office-hours/SKILL.md",
      "sourcePath": "/Users/ngxcalvin/repos/skills/skills/office-hours/SKILL.md",
      "sourceSha256": "b0d..",
      "targetSha256": null,
      "bytes": 123
    },
    {
      "action": "unchanged",
      "skill": "office-hours",
      "relativePath": "runtime.js",
      "targetPath": "/tmp/openclaw/skills/office-hours/runtime.js",
      "sourcePath": "/Users/ngxcalvin/repos/skills/skills/office-hours/runtime.js",
      "sourceSha256": "e1c..",
      "targetSha256": "e1c..",
      "bytes": 56
    }
  ],
  "summary": {
    "create": 1,
    "update": 0,
    "unchanged": 1,
    "extra": 0,
    "missing": 0,
    "blocked": 0
  },
  "errors": []
}
```

For `diff`, `target` may be either an assignment name (`openclaw`) or an
`assignmentPath` id (`codex`). `assignment` is the resolved assignment
name used to produce the package plan, while `installRoot` is the concrete target
skills directory used for file comparison.

`entries.action` values:

- `create`: present in source, absent on target
- `update`: present on both, contents differ
- `unchanged`: present on both, contents match
- `extra`: present on target only
- `missing`: source entry could not be read/listed
- `blocked`: compatibility blocked this skill

`diff` is read-only: it never creates missing `installRoot` directories and does
not write files. If target resolution fails (for example ambiguous or missing
`assignmentPath` entries), `ok` is `false`, `installRoot` is `null`, and
`errors` includes structured codes like `ambiguous_install_root` and
`missing_install_root`.
Provider-backed adapter kinds such as OpenCode and Pi stay read-only even when
the catalog declares a custom `assignmentPaths` entry, so `diff` reports
`readOnly: true` for that resolved install root and does not plan file entries
for Suitcase adoption.
Errors tied to a planned source skill may also include a `skill` field.

## `pack` Output

`pack --dry-run` reports the skill files that would be copied into a staging
bundle, including byte counts and SHA-256 checksums, but creates no bundle
directory and writes no receipts.

Like `diff`, `pack` resolves `--target` to an assignment plan, so `--target` may
be either an assignment name (`openclaw`) or an `assignmentPath` id
(`codex`). The resolved assignment drives the plan, while the output and
stored manifest `target` field echoes the value you passed.
Provider-backed adapter kinds such as OpenCode and Pi are read-only even when
the catalog declares a custom `assignmentPaths` entry for review. `pack` refuses
those targets with `read_only_target` before staging an artifact, so broad sync
cannot turn a provider-managed home into a Suitcase-owned install root.

When the source is a Git checkout, `pack` refuses to materialize any selected
source skill that contains untracked, non-ignored files. Track or remove those
files before packing. Ignored files and untracked files outside the selected
source skills do not block the pack. Files matching manifest `sourcePolicy`
`exclude` patterns are omitted from packs and plan locks; files matching
`sourcePolicy.deny` or built-in secret-like deny patterns block materialization.
Hygiene failures surface in `errors` as `source_untracked_files`,
`source_denied_path`, `source_path_outside_repo`, or `source_hygiene_failed`.

```json
{
  "ok": true,
  "dryRun": false,
  "source": "/Users/ngxcalvin/repos/skills",
  "target": "openclaw",
  "bundle": {
    "action": "pack",
    "outputPath": "/tmp/skill-suitcase-openclaw",
    "artifactId": "d4e5..",
    "artifactPath": "/tmp/skill-suitcase-openclaw/.skill-suitcase/artifacts/d4e5..",
    "manifestPath": "/tmp/skill-suitcase-openclaw/.skill-suitcase/artifacts/d4e5../skill-suitcase-bundle.json",
    "schema": "calvinnwq.skills.pack-bundle.v0",
    "reason": "written"
  },
  "planned": [
    {
      "skill": "office-hours",
      "action": "install",
      "variant": "canonical",
      "sourcePath": "/Users/ngxcalvin/repos/skills/skills/office-hours",
      "evidence": ["docs/install-smoke.md"]
    }
  ],
  "blocked": [],
  "files": [
    {
      "skill": "office-hours",
      "relativePath": "SKILL.md",
      "sourcePath": "/Users/ngxcalvin/repos/skills/skills/office-hours/SKILL.md",
      "bundlePath": "skills/office-hours/SKILL.md",
      "bytes": 123,
      "sha256": "e1c.."
    }
  ],
  "summary": {
    "skills": 1,
    "blocked": 0,
    "files": 1,
    "bytes": 123
  },
  "errors": []
}
```

For dry runs, `bundle.outputPath`, `bundle.artifactId`,
`bundle.artifactPath`, and `bundle.manifestPath` are `null`, and
`bundle.reason` is `dry-run`.

`pack --output <dir>` writes managed immutable artifacts under:

`<dir>/.skill-suitcase/artifacts/<artifactId>/`

Each artifact directory contains:

- `skill-suitcase-bundle.json` (provenance, checksums, manifest metadata)
- staged skill files under `skills/<skill-name>/...`

The stored manifest uses schema `calvinnwq.skills.pack-bundle.v0` and records
`artifactId`, `source`, `target`, `action`, `createdAt`, `summary`,
`fileHashes`, `files`, `planned`, and `blocked`. `fileHashes` maps each packed
skill to its per-file SHA-256 hashes. `source` includes the resolved catalog repo,
`skill-suitcase.yaml` path, and best-effort `git rev-parse HEAD` commit/ref;
the commit and ref are `null` when the source is not a Git checkout. Stored
manifest `sourcePath` values are relative to the catalog source root.

The artifact id is computed from the complete packed contents and source
provenance, so repeated runs with the same source/plan produce the same id.
`pack` refuses to overwrite an existing artifact id directory, which protects
existing snapshots from mutation.

`pack --output <dir>` still validates that output is outside manifest-declared
install target paths and will keep writing under `<dir>` if that output directory
already exists. If the output path exists and is not a directory, `pack` fails.

Retention and cleanup:

- `.skill-suitcase/artifacts` is a write-once history of pack snapshots.
- This CLI does not auto-delete artifacts; operators must prune old snapshot
  directories explicitly when retention policy requires it.

`targets` returns assignment target discovery details instead of install plans.
Local target overrides are applied before discovery, so the returned
`codex` and `claude` paths reflect any override flags passed to
the command:

```json
{
  "ok": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "targets": [
    {
      "id": "codex",
      "name": "codex",
      "assignment": "codex",
      "kind": "codex-home",
      "path": "/tmp/codex",
      "codexHome": "/tmp/codex",
      "skillsPath": "/tmp/codex/skills",
      "platform": {
        "adapter": "codex",
        "installRoot": "/tmp/codex/skills",
        "compatibility": ["codex"],
        "metadata": {}
      },
      "exists": {
        "path": false,
        "codexHome": false,
        "skillsPath": false
      },
      "safety": {
        "classification": "missing"
      }
    }
  ],
  "findings": []
}
```

## `status` Output

`status` walks manifest `assignmentPaths` entries, resolves the referenced
assignment plans, reads each install root and optional
`.skill-suitcase-receipt.json` receipt (or `.skills-sync.json` for migration
compatibility), and reports one status per planned or blocked skill. Pass
`--target <target>` to limit the walk to matching assignment path ids or
assignment names. Exact assignment path ids win over assignment-name expansion.
It uses `path` for `openclaw-skills-root` and
`claude-skills-root` entries, and `skillsPath` for `codex-home` and
`nested-home-codex` entries. Install roots must already exist.

```json
{
  "ok": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "manifestPath": "/Users/ngxcalvin/repos/skills/skill-suitcase.yaml",
  "assignments": [
    {
      "assignmentPath": "codex",
      "assignment": "codex",
      "kind": "codex-home",
      "installRoot": "/tmp/codex/skills",
      "statusCount": 1,
      "statuses": [
        {
          "assignment": "codex",
          "assignmentPath": "codex",
          "kind": "codex-home",
          "skill": "hyperframes",
          "status": "current",
          "target": "/tmp/codex/skills",
          "targetPath": "/tmp/codex/skills/hyperframes",
          "reason": "installed skill matches source version and content hash",
          "installedVersion": "2026.06.10",
          "currentVersion": "2026.06.10",
          "installedCommit": "deadbeef",
          "currentCommit": "42fe414dc8770117bc0c5c3c8c7619d25627898a",
          "installedHash": "e1c..",
          "currentHash": "e1c..",
          "lineage": {
            "upstream": {
              "provider": "skills-sh",
              "packageName": "skills",
              "packageVersion": "1.5.11",
              "repo": "heygen-com/hyperframes",
              "skill": "hyperframes",
              "group": "hyperframes"
            },
            "imported": {
              "hash": "e1c..",
              "packageVersion": "1.5.11",
              "at": "2026-06-24T01:00:00.000Z",
              "source": "skills-sh:heygen-com/hyperframes:hyperframes"
            },
            "catalog": {
              "hash": "e1c..",
              "drift": "unchanged"
            },
            "target": {
              "status": "current",
              "receiptHash": "e1c..",
              "receiptCommit": "deadbeef"
            }
          },
          "variant": "canonical"
        }
      ],
      "errors": []
    }
  ],
  "statuses": [
    {
      "assignment": "codex",
      "assignmentPath": "codex",
      "kind": "codex-home",
      "skill": "hyperframes",
      "status": "current",
      "target": "/tmp/codex/skills",
      "targetPath": "/tmp/codex/skills/hyperframes",
      "reason": "installed skill matches source version and content hash",
      "installedVersion": "2026.06.10",
      "currentVersion": "2026.06.10",
      "installedCommit": "deadbeef",
      "currentCommit": "42fe414dc8770117bc0c5c3c8c7619d25627898a",
      "installedHash": "e1c..",
      "currentHash": "e1c..",
      "lineage": {
        "upstream": { "provider": "skills-sh", "packageName": "skills", "packageVersion": "1.5.11", "repo": "heygen-com/hyperframes", "skill": "hyperframes", "group": "hyperframes" },
        "imported": { "hash": "e1c..", "packageVersion": "1.5.11", "at": "2026-06-24T01:00:00.000Z", "source": "skills-sh:heygen-com/hyperframes:hyperframes" },
        "catalog": { "hash": "e1c..", "drift": "unchanged" },
        "target": { "status": "current", "receiptHash": "e1c..", "receiptCommit": "deadbeef" }
      },
      "variant": "canonical"
    }
  ],
  "summary": {
    "current": 1,
    "behind": 0,
    "version": 0,
    "dirty": 0,
    "missing": 0,
    "unknown": 0,
    "blocked": 0
  },
  "errors": []
}
```

For upstream-managed skills, `status` attaches the same `lineage` object and
fills `lineage.target` with the target receipt state.
This makes the chain auditable in one status entry: pinned upstream
package/version, upstream repo/skill, imported hash, current catalog hash and
drift, target status, receipt hash, and receipt commit.
`status` loads that lineage lazily for the planned or blocked skills in the selected report, so `status --target <target>` does not hash unrelated upstream-managed catalog skills.
If the upstream lock is malformed or unreadable, `status` reports upstream-scoped
errors, returns `ok: false`, and omits lineage until the lock metadata is valid.

`status.status` values:

- `current`: installed receipt version and content match the source skill
  (for symlink installs, the target link points at the selected source path)
- `behind`: source content changed after the recorded install
- `version`: source `SKILL.md` frontmatter `version` changed
- `dirty`: target files or symlink differ from the recorded install; stop and
  inspect, then run `repair --dry-run` and, after approval, `repair --apply` for
  a receipt-owned copy-mode skill (see [`repair` Output](#repair-output));
  symlink-mode dirty installs are refused rather than converted
- `missing`: planned target skill directory is absent
- `unknown`: status could not be proven, such as a missing receipt for an
  existing target or an unreadable source/target
- `blocked`: compatibility rules block the skill for that assignment

`status` treats `<installRoot>/.skill-suitcase-receipt.json` as optional. The
preferred schema is `calvinnwq.skills.receipt.v0` with a machine-readable
`installs` map keyed by skill name. Each install record should include:

- `agent`, `mode`, `source` or `sourcePath`, `targetPath`
- `version`, `sourceCommit`, or `sourceHash` (at least one)
- optional `target`, `variant`, `installedFiles`, `priorState`, and `rollback`

For migration compatibility, `status` also reads legacy `.skills-sync.json` files
using `calvinnwq.skills.sync-lock.v0` when no modern receipt exists.

Receipt `installs` values may be a single object or an array of records for
multi-target installs. `status` selects the record whose `targetPath` resolves
to either the assignment install root or `<installRoot>/<skill-name>`; relative
`targetPath` values resolve under `installRoot`. Ambiguous or missing matches
are reported as `invalid_receipt`.

When `--target <target>` does not match any assignment path id or assignment
name, `status` returns `ok: false` with an `unknown_target` error.

## `apply` Output

`apply` requires exactly one of `--lock` (a plan-lock file path) or `--artifact`
(a staging bundle path or directory). It validates the approval input, checks
pre-apply target status, verifies selected source hygiene for Git-backed
catalogs, materializes planned skills, and emits a receipt per skill. Copy-mode
receipts capture the pre-apply state of every written file (a `rollback` record)
so the install can later be reversed with `skill-suitcase rollback`.

Dirty targets remain stop-and-inspect by default. The one supported dirty
pre-state is a receipt-owned copy install whose receipt hash is behind the
catalog, whose live target is still a real managed directory, whose approved
lock/artifact writes that same skill, and whose approval input carries matching
file hashes for every write. Written target files must still match the receipt
before apply touches them, and unchanged target files must already be recorded
in the receipt. This lets `pack` + `apply` resolve narrow
stale-receipt/catalog-update cases without routing into a `repair` dead end;
ordinary dirty edits, unknown targets, symlink replacements, target extras,
unreceipted unchanged files, and dirty skills with no approved writes are still
refused.

`--mode` selects how each planned skill is materialized. The default
`--mode copy` writes the source files into the target root. `--mode symlink`
instead links each agent skill path to its catalog source path (agent skill
path -> repo source path) and records `mode: "symlink"` in the receipt rather
than inferring the mode from filesystem shape. Symlink mode runs the same
approval and pre-apply safety checks, refuses to point a managed link outside
the approved source root, and refuses to replace an existing real directory or
wrong/broken link (converting those requires explicit approval). Unknown values
return an `invalid_apply_mode` error. The top-level output `mode` still reports
the approval input kind (`lock` or `artifact`); the install mode is recorded per
receipt install record.

On success (`ok: true`):

```json
{
  "ok": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "target": "openclaw",
  "mode": "lock",
  "input": "/tmp/plan-lock.json",
  "assignment": "openclaw",
  "planTarget": "openclaw",
  "installRoot": "/tmp/openclaw-install",
  "preApplyStatus": {
    "source": "/Users/ngxcalvin/repos/skills",
    "statuses": [{ "skill": "office-hours", "status": "behind", "reason": "..." }],
    "summary": { "total": 1, "behind": 1, "current": 0, "dirty": 0, "missing": 0, "unknown": 0, "blocked": 0, "version": 0, "unchanged": 0 }
  },
  "postApplyStatus": { "ok": true, "statuses": [{ "skill": "office-hours", "status": "current" }] },
  "summary": { "planned": 1, "blocked": 0, "create": 0, "update": 1, "unchanged": 0, "extra": 0, "missing": 0 },
  "applied": { "skills": ["office-hours"], "files": 1 },
  "errors": []
}
```

On failure (`ok: false`), the `errors` array contains one or more objects with
`code` and `message`. Error codes include:

- `missing_apply_input` — neither `--lock` nor `--artifact` was provided
- `invalid_apply_input` — both flags were provided, or the lock file is not a valid plan-lock
- `plan_lock_target_mismatch` / `plan_lock_source_mismatch` — the lock's target or source does not match the apply invocation
- `plan_lock_*` — the plan-lock is stale, suffixed with the drift reason (for example `plan_lock_source_commit_changed`)
- `invalid_artifact_manifest` — artifact bundle is missing, unreadable, or malformed
- `artifact_target_mismatch` / `artifact_source_mismatch` — approval metadata does not match the apply invocation
- `artifact_blocked` — artifact contains blocked plan entries
- `artifact_missing_planned` — artifact contains no planned skills
- `read_only_target` - the resolved target provider is modeled read-only
- `source_untracked_files` — a selected source skill contains untracked,
  non-ignored files; track or remove them before packing/applying
- `source_denied_path` / `diff_source_denied_path` — a selected source skill
  contains a path denied by manifest `sourcePolicy.deny` or a built-in
  secret-like deny pattern; remove the path or adjust the reviewed policy
- `source_path_outside_repo` / `source_hygiene_failed` — source hygiene could
  not prove that the selected source skill is inside the Git checkout and clean
- `diff_*` — a target-resolution error propagated from the diff layer;
  `diff_blocked_skill` reports a planned skill that is blocked for the target
  (for example when a required source variant is missing)
- `unmanaged_target` — target has no managed status entries; install it first
- `unsafe_target_state` — a planned skill is `unknown`, or is `dirty` without
  also being a receipt-owned behind-catalog update whose approved writes and
  receipt metadata prove no unrelated target drift will be overwritten or blessed
- `symlink_source_escape` — a planned symlink source path escapes the approved source root
- `symlink_target_conflict` — a planned symlink target already exists as a real directory, wrong link, or broken link and would require explicit approval to replace
- `symlink_write_error` — a symlink creation or receipt write failed during symlink-mode apply
- `status_*` — a pre-apply status-layer error (prefixed with `status_`)
- `write_error` — a file write or rollback failure

## `rollback` Output

`rollback` reverses a receipt-backed mutation. It resolves `--receipt` to a
receipt file (a directory argument resolves to
`<dir>/.skill-suitcase-receipt.json`), then walks each install record's captured
`rollback` state. For each skill it first checks that the target still matches
the recorded applied state; on a match it restores every file to its previous
contents and removes files or directories the mutation created.

On success (`ok: true`):

```json
{
  "ok": true,
  "receipt": "/tmp/openclaw-install/.skill-suitcase-receipt.json",
  "installRoot": "/tmp/openclaw-install",
  "summary": {
    "restored": 1,
    "removed": 0,
    "noop": 0,
    "failed": 0,
    "refused": 0
  },
  "rollbacks": [
    {
      "skill": "office-hours",
      "targetPath": "/tmp/openclaw-install/office-hours",
      "status": "restored",
      "restored": 1,
      "removed": 0,
      "failed": 0
    }
  ],
  "errors": []
}
```

Per-skill `status` values:

- `restored`: the recorded previous file states were restored (and
  mutation-created files removed)
- `noop`: the record has no rollback state, or it was already rolled back
- `refused`: the target drifted from the recorded applied state, or every file
  failed to restore
- `partial`: some files were restored or removed but at least one failed

`summary` holds aggregate counts across the receipt: `restored` and `removed`
count individual files or directories, `noop` and `refused` count skills, and
`failed` counts entries that could not be restored or removed. After a fully
successful rollback of a previously installed skill, the receipt's rollback
record is marked `rolled-back`, so re-running `rollback` is a deterministic
no-op. If the mutation created the whole managed install, rollback removes that
install record from the receipt.

For `mode: "symlink"` installs, rollback reverses only links that `apply --mode
symlink` created (recorded with `created: true`): it removes the
Suitcase-created link — the link itself, never the catalog source it points at —
reports it under `removed`, and drops the install record from the receipt.
Track-adopted symlinks (no rollback state) and links `apply` only refreshed
(`created: false`) are a safe `noop`. Rollback refuses (`target_drift`) rather
than delete a real directory, a retargeted link, or a broken link found where
the created symlink was expected, so it can never delete state it did not
capture.

For `mode: "reconcile"` installs, rollback restores the pre-reconcile target
from the recorded file states, removes catalog-created files/directories, removes
the hidden `.suitcase-pre-reconcile-*` backup after a successful restore, and
drops the reconcile install record from the receipt. Rollback refuses unexpected
backup paths so it does not remove unrelated target state.

For `mode: "repair"` installs, rollback restores the pre-repair dirty target
from the recorded file states and keeps the skill receipt-owned by marking the
repair rollback state as rolled back. The hidden `.suitcase-pre-repair-*` backup
is retained because the install record remains as provenance for the restored
dirty content.

On failure (`ok: false`), `errors` contains objects with `code` and `message`
(plus optional `skill` and `path`). Error codes include:

- `invalid_receipt` — the receipt is missing, unreadable, or has malformed JSON,
  schema, installs map, install records, or rollback records
- `target_drift` — the target differs from the applied state recorded at apply time
- `restore_impossible` — the previous state cannot be restored (for example the
  original target was not a regular file)
- `rollback_record_invalid` — stored rollback bytes do not match their recorded digest
- `restore_write_failed` — restoring a file's previous contents failed
- `rollback_remove_failed` — removing a created file, directory, symlink, or
  reconcile backup failed
- `receipt_write_failed` — rollback restored files but could not persist the
  updated receipt

## `track` Output

`track` adopts an existing install into a receipt without rewriting files. It
runs a `diff` of `--source` against `--target`, then writes a receipt for every
planned skill whose live install already matches the catalog source exactly.
By default, `track` remains target-level all-or-nothing: every planned skill must
match before any receipt is written.
Provider-backed adapter kinds such as OpenCode and Pi are not adopted by
`track`, including when a custom manifest `assignmentPaths` entry points at a
review root for that provider.

Use repeatable `--skill <name>` filters to adopt only selected, already-matching
skills before applying new skills. In targeted mode, only selected skills are
eligible for tracking. Selected skills must be `unchanged`; selected create,
update, extra, missing, blocked, or non-planned skills are refused. Unselected
skills, including create-only skills that will be applied later, do not block the
targeted adoption. Targeted `track` still writes receipts only and never rewrites
live skill files. Skill filters are trimmed, deduplicated, and sorted in
`selected.skills`; a blank filter is refused.

On success (`ok: true`):

```json
{
  "ok": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "target": "openclaw",
  "assignment": "openclaw",
  "installRoot": "/tmp/openclaw/skills",
  "summary": {
    "planned": 2,
    "tracked": 2,
    "files": 4,
    "refused": 0,
    "blocked": 0
  },
  "tracked": {
    "skills": ["gnhf-postflight", "office-hours"],
    "files": 4
  },
  "selected": {
    "skills": []
  },
  "refused": {
    "skills": []
  },
  "errors": []
}
```

Each tracked copy install is written with `mode: "track"` and a `priorState` of
`{ "status": "unknown", "reason": "target existed before Suitcase tracking" }`.
A tracked symlink adoption is written with `mode: "symlink"` and a `priorState`
of `{ "status": "unknown", "reason": "existing symlink adopted by Suitcase tracking" }`.
In both cases Suitcase did not perform the original install. On success, `tracked.skills`
lists the adopted skills (sorted), `tracked.files` counts the receipted files,
and `selected.skills` lists the normalized requested filters (empty for
all-skills mode). On refusal, `refused.skills` lists the selected or planned
skills that blocked receipt adoption.

In all-skills mode, `track` writes no receipts unless every planned skill
matches. It refuses (with `ok: false` and `summary.refused` counting the
failures) when a target skill directory is absent, when any file would be
created/updated, when the target has extra or unreadable files, or when a skill
is blocked. With `--skill`, the same refusal rules apply only to selected skills
and `summary.planned` counts only selected planned skills. Error codes include:

- `missing_install_root` — the target could not be resolved to an install root
- `read_only_target` - the resolved target provider is modeled read-only
- `invalid_skill_filter` — targeted tracking was requested without a non-blank
  skill filter
- `target_missing` — a planned skill's target directory or file is absent
- `target_mismatch` — target files do not match the source (`update`/`extra`)
- `target_unreadable` — a target skill path is not a directory or cannot be read
- `target_symlink` — the target skill tree contains a file-level symlink (copy installs only)
- `target_symlink_mismatch` — an existing symlink at the skill root does not point at the selected source path and cannot be tracked
- `source_missing` — a source entry is absent
- `source_unreadable` — a source skill directory cannot be read
- `blocked_skill` — compatibility rules block the skill for that assignment
- `skill_not_planned` — a selected skill is not planned or blocked for the target
- `invalid_receipt` — the existing receipt cannot be read or normalized
- `receipt_write_failed` — the adoption receipt could not be written
- `diff_*` — a diff-layer error propagated from target resolution

## `reconcile` Output

`reconcile` repairs selected catalog-planned skills whose target directory
exists, has no Suitcase receipt, and differs from the catalog. It is
intentionally targeted: pass one or more `--skill <name>` filters, plus exactly
one of `--dry-run` or `--apply`.

`--dry-run` is read-only. It uses `diff` and `status` to prove the selected skill
is an unknown, mismatched target, then reports the live-vs-catalog file actions
and the hidden backup path template that `--apply` would use.

On a clean dry run (`ok: true`):

```json
{
  "ok": true,
  "dryRun": true,
  "readOnly": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "target": "openclaw",
  "assignment": "openclaw",
  "installRoot": "/tmp/openclaw/skills",
  "selected": { "skills": ["skill-cleaner"] },
  "candidates": [
    {
      "skill": "skill-cleaner",
      "sourcePath": "/Users/ngxcalvin/repos/skills/skills/skill-cleaner",
      "targetPath": "/tmp/openclaw/skills/skill-cleaner",
      "variant": "canonical",
      "status": "unknown",
      "reason": "target exists but has no Suitcase receipt",
      "changes": { "create": 1, "update": 1, "extra": 1, "missing": 0, "unchanged": 0 },
      "entries": [
        { "action": "update", "skill": "skill-cleaner", "relativePath": "SKILL.md", "sourcePath": "/Users/ngxcalvin/repos/skills/skills/skill-cleaner/SKILL.md", "targetPath": "/tmp/openclaw/skills/skill-cleaner/SKILL.md" }
      ],
      "backup": {
        "strategy": "rename-target-directory",
        "backupPathTemplate": "/tmp/openclaw/skills/.skill-cleaner.suitcase-pre-reconcile-<timestamp>"
      }
    }
  ],
  "refused": { "skills": [] },
  "summary": { "planned": 1, "candidates": 1, "refused": 0, "blocked": 0, "create": 1, "update": 1, "extra": 1, "missing": 0, "unchanged": 0 },
  "reconciled": { "skills": [], "files": 0, "backups": [] },
  "receiptPath": null,
  "postReconcileStatus": null,
  "errors": []
}
```

`--apply` re-runs the same candidate checks, copies the catalog source to a
temporary path, hash-verifies the copy, renames the existing target aside to a
hidden `.suitcase-pre-reconcile-*` backup, installs the catalog copy, writes a
`mode: "reconcile"` receipt with rollback state, and verifies post-reconcile
`status` reports the skill as `current`.

On success (`ok: true`), `reconciled.skills` lists replaced skills,
`reconciled.files` counts receipted catalog files, `reconciled.backups` lists the
preserved prior target paths, `receiptPath` points to the written receipt, and
`postReconcileStatus` contains the verification result:

```json
{
  "ok": true,
  "dryRun": false,
  "readOnly": false,
  "reconciled": {
    "skills": ["skill-cleaner"],
    "files": 2,
    "backups": [
      {
        "skill": "skill-cleaner",
        "targetPath": "/tmp/openclaw/skills/skill-cleaner",
        "backupPath": "/tmp/openclaw/skills/.skill-cleaner.suitcase-pre-reconcile-<id>"
      }
    ]
  },
  "receiptPath": "/tmp/openclaw/skills/.skill-suitcase-receipt.json",
  "postReconcileStatus": { "ok": true, "statuses": [{ "skill": "skill-cleaner", "status": "current" }] },
  "errors": []
}
```

The reconcile receipt records `mode: "reconcile"`, `priorState.status: "unknown"`,
source provenance, installed file hashes, and rollback schema
`calvinnwq.skills.rollback.v0` with `targetPath`, `sourcePath`, `backupPath`,
previous file states, and applied file hashes. A later `rollback` restores the
pre-reconcile target and removes the reconcile backup after a successful restore.

On failure (`ok: false`), `errors` contains objects with `code` and `message`
(plus optional `skill` and `path`). Error codes include:

- `invalid_skill_filter` — no non-blank `--skill` filter was provided
- `invalid_reconcile_mode` — neither or both of `--dry-run` and `--apply` were provided
- `read_only_target` — the resolved target provider is modeled read-only
- `missing_install_root` — the target could not be resolved to an install root
- `diff_*` / `status_*` — target-resolution or status errors propagated from those layers
- `blocked_skill` — compatibility rules block the selected skill for the target
- `skill_not_planned` — a selected skill is not planned for the target
- `unsafe_path` — the skill, source path, or target path would escape the approved roots
- `unsupported_target_state` — the selected target is not an unknown receiptless directory
- `missing_source` — the catalog source has missing entries
- `target_matches_catalog_use_track` — the selected target already matches and should be adopted with `track`
- `unsupported_source_tree` / `source_unreadable` — the catalog source cannot be copied safely
- `unsafe_target_tree` / `target_unreadable` — the target contains symlinks, special entries, empty directories, or unreadable state that rollback cannot safely record
- `invalid_receipt` — the existing receipt could not be read before mutation
- `reconcile_write_failed` — copying, swapping, verification, or receipt write failed and was rolled back best-effort
- `post_status_unavailable` / `post_status_not_current` — post-reconcile status verification failed

## `repair` Output

`repair` restores selected receipt-owned copy-mode target skills that became
`dirty` after external edits. It is intentionally narrow: pass one or more
`--skill <name>` filters, plus exactly one of `--dry-run` or `--apply`. Unlike
`reconcile` (which adopts receiptless `unknown` targets), `repair` only owns
targets that already carry a Suitcase receipt and have drifted from it.
Symlink-mode installs are refused rather than converted to copy-mode installs.
Every other state is refused and routed to the command that owns it.

`--dry-run` is read-only. It uses `diff` and `status` to prove the selected skill
is a receipt-owned `dirty` target, then reports the target path, receipt hash,
catalog hash, changed files, and the hidden backup path template that `--apply`
would use. The `finalAction` is always `replace-target-from-catalog`.

On a clean dry run (`ok: true`):

```json
{
  "ok": true,
  "dryRun": true,
  "readOnly": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "target": "openclaw",
  "assignment": "openclaw",
  "installRoot": "/tmp/openclaw/skills",
  "selected": { "skills": ["skill-cleaner"] },
  "candidates": [
    {
      "skill": "skill-cleaner",
      "sourcePath": "/Users/ngxcalvin/repos/skills/skills/skill-cleaner",
      "targetPath": "/tmp/openclaw/skills/skill-cleaner",
      "variant": "canonical",
      "status": "dirty",
      "reason": "target files differ from receipt",
      "receiptHash": "e1c..",
      "catalogHash": "9a4..",
      "changes": { "create": 0, "update": 1, "extra": 1, "missing": 0, "unchanged": 1 },
      "entries": [
        { "action": "update", "skill": "skill-cleaner", "relativePath": "runtime.js", "sourcePath": "/Users/ngxcalvin/repos/skills/skills/skill-cleaner/runtime.js", "targetPath": "/tmp/openclaw/skills/skill-cleaner/runtime.js" },
        { "action": "extra", "skill": "skill-cleaner", "relativePath": "extra.js", "sourcePath": null, "targetPath": "/tmp/openclaw/skills/skill-cleaner/extra.js" }
      ],
      "backup": {
        "strategy": "rename-target-directory",
        "backupPathTemplate": "/tmp/openclaw/skills/.skill-cleaner.suitcase-pre-repair-<timestamp>"
      },
      "finalAction": "replace-target-from-catalog"
    }
  ],
  "refused": { "skills": [] },
  "summary": { "planned": 1, "candidates": 1, "refused": 0, "blocked": 0, "dirty": 1, "create": 0, "update": 1, "extra": 1, "missing": 0, "unchanged": 1 },
  "repaired": { "skills": [], "files": 0, "backups": [] },
  "receiptPath": null,
  "postRepairStatus": null,
  "errors": []
}
```

`--apply` re-runs the same candidate checks, copies the catalog source to a
temporary path, hash-verifies the copy, renames the existing dirty target aside
to a hidden `.suitcase-pre-repair-*` backup, installs the catalog copy, writes a
`mode: "repair"` receipt with rollback state, and verifies post-repair `status`
reports the skill as `current`. No target is mutated before its backup and
rollback metadata are prepared, and any mid-apply failure unwinds every completed
swap and restores the original receipt, leaving the dirty target intact.

On success (`ok: true`), `repaired.skills` lists restored skills,
`repaired.files` counts receipted catalog files, `repaired.backups` lists the
preserved pre-repair dirty target paths, `receiptPath` points to the written
receipt, and `postRepairStatus` contains the verification result:

```json
{
  "ok": true,
  "dryRun": false,
  "readOnly": false,
  "repaired": {
    "skills": ["skill-cleaner"],
    "files": 2,
    "backups": [
      {
        "skill": "skill-cleaner",
        "targetPath": "/tmp/openclaw/skills/skill-cleaner",
        "backupPath": "/tmp/openclaw/skills/.skill-cleaner.suitcase-pre-repair-<id>"
      }
    ]
  },
  "receiptPath": "/tmp/openclaw/skills/.skill-suitcase-receipt.json",
  "postRepairStatus": { "ok": true, "statuses": [{ "skill": "skill-cleaner", "status": "current" }] },
  "errors": []
}
```

The repair receipt records `mode: "repair"`, `priorState.status: "dirty"`, source
provenance, installed file hashes, and rollback schema
`calvinnwq.skills.rollback.v0` carrying the captured pre-repair dirty bytes plus
the durable `backupPath`. A later `rollback --receipt <path>` restores the
pre-repair dirty target and keeps the skill receipt-owned (the backup is retained
because the record is retained).

On failure (`ok: false`), `errors` contains objects with `code` and `message`
(plus optional `skill` and `path`). Error codes include:

- `invalid_skill_filter` — no non-blank `--skill` filter was provided
- `invalid_repair_mode` — neither or both of `--dry-run` and `--apply` were provided
- `read_only_target` — the resolved target provider is modeled read-only
- `missing_install_root` — the target could not be resolved to an install root
- `already_current` — a selected skill already matches the catalog; repair is a no-op
- `route_to_track_or_reconcile` — a selected skill is `unknown`; adopt it with `track` or `reconcile` instead
- `route_to_pack_apply` — a selected skill is `missing`, `behind`, or `version`; install/update it with `pack` + `apply` instead
- `blocked_skill` — compatibility rules block the selected skill for the target
- `skill_not_planned` — a selected skill is not planned for the target
- `diff_*` / `status_*` — target-resolution or status errors propagated from those layers
- `unsafe_path` — the skill, source path, or target path would escape the approved roots
- `unsupported_install_mode` — the selected skill is a symlink-mode install and will not be converted by repair
- `unsupported_target_state` — the selected target has no usable status entry to repair
- `missing_source` — the catalog source has missing entries
- `unsupported_source_tree` / `source_unreadable` — the catalog source cannot be copied safely
- `unsafe_target_tree` / `target_unreadable` — the target contains symlinks, special entries, empty directories, or unreadable state that rollback cannot safely record
- `invalid_receipt` — the existing receipt could not be read before mutation
- `repair_write_failed` — copying, swapping, verification, or receipt write failed and was rolled back best-effort
- `post_status_unavailable` / `post_status_not_current` — post-repair status verification failed

## `promote` Output

`promote` turns a target-created skill (for example a skill an agent wrote into
`~/.codex/skills/new-skill`) into a repo-owned Skill Suitcase skill. It follows
the source-of-truth direction: the catalog repo owns the skill files, and the
agent home links back to that source.

`promote` requires an explicit mode. `--dry-run` runs the read-only plan;
`--apply` runs the approval-gated live promotion. The two are mutually
exclusive — passing neither or both is a usage error.

The `--dry-run` plan inspects the `--target-skill` directory and the catalog
`--source` repo without mutating anything, then reports the intended
copy → verify → symlink → receipt workflow plus any blocking conflicts.

On a clean plan (`ok: true`):

```json
{
  "ok": true,
  "dryRun": true,
  "readOnly": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "targetSkill": "/Users/ngxcalvin/.codex/skills/new-skill",
  "skillName": "new-skill",
  "repoSkillPath": "/Users/ngxcalvin/repos/skills/skills/new-skill",
  "plan": [
    { "action": "copy", "description": "Copy the target skill contents into the catalog source path.", "from": "/Users/ngxcalvin/.codex/skills/new-skill", "to": "/Users/ngxcalvin/repos/skills/skills/new-skill" },
    { "action": "verify", "description": "Hash-verify the copied catalog source against the original target contents before swapping.", "from": "/Users/ngxcalvin/.codex/skills/new-skill", "to": "/Users/ngxcalvin/repos/skills/skills/new-skill" },
    { "action": "symlink", "description": "Replace the target directory with a symlink back to the catalog source after verification.", "from": "/Users/ngxcalvin/.codex/skills/new-skill", "to": "/Users/ngxcalvin/repos/skills/skills/new-skill" },
    { "action": "receipt", "description": "Write receipt metadata linking the target to the promoted catalog source.", "to": "/Users/ngxcalvin/repos/skills/skills/new-skill" }
  ],
  "conflicts": [],
  "summary": { "conflicts": 0, "steps": 4 }
}
```

The dry-run is purely read-only: it never creates the catalog copy, never
replaces the target directory with a symlink, and never writes a receipt. The
`plan` array always describes the intended workflow; `ok` and `conflicts` decide
whether a later live promotion would be allowed to run. All applicable conflicts
are collected (not short-circuited) so callers see every blocker at once.
Conflict codes are machine-readable:

- `existing_repo_skill` — the catalog already has a skill at `repoSkillPath`; a
  conflict decision is required before overwriting it
- `unsafe_path` — the skill name is not a plain directory segment, the promoted
  path would escape the catalog `skills/` directory, the catalog `skills/`
  directory resolves outside the source repo, the promoted path would be nested
  inside the target skill, or the target skill already lives inside the source
  repo (so it is not a target-created skill)
- `dirty_target` — the target skill root is itself a symlink, or its tree
  contains a nested symlink, so it cannot be hash-verified or copied faithfully
- `unsupported_layout` — the source root, catalog `skills/` directory, or target
  path is missing or not a directory; the target also must have `SKILL.md`

### Live promotion (`--apply`)

`--apply` performs the mutation the dry-run plan describes. It first re-runs the
plan and refuses (without touching anything) if any conflict is present, then:

1. copies the target skill tree into the catalog source path
2. hash-verifies the catalog copy against the original target content
3. preserves the original target by moving it aside to a hidden backup
   (`.<skill>.suitcase-pre-promote-<id>`) — the original is never deleted before
   the copy is verified
4. replaces the agent-home directory with a symlink back to the catalog source
5. writes a receipt recording source provenance, the `symlink` install mode, and
   rollback state (including the preserved `backupPath`)

The operation is transactional: any failure rolls back so the original target is
left as the untouched real directory it started as, with no catalog copy,
symlink, or receipt left behind. On success the result reports `ok: true`, the
completed `steps`, the written `receiptPath`, and the `backupPath` holding the
preserved original (kept as trashable rollback state):

```json
{
  "ok": true,
  "dryRun": false,
  "source": "/Users/ngxcalvin/repos/skills",
  "targetSkill": "/Users/ngxcalvin/.codex/skills/new-skill",
  "skillName": "new-skill",
  "repoSkillPath": "/Users/ngxcalvin/repos/skills/skills/new-skill",
  "steps": [
    { "action": "copy", "from": "/Users/ngxcalvin/.codex/skills/new-skill", "to": "/Users/ngxcalvin/repos/skills/skills/new-skill" },
    { "action": "verify", "from": "/Users/ngxcalvin/.codex/skills/new-skill", "to": "/Users/ngxcalvin/repos/skills/skills/new-skill" },
    { "action": "symlink", "from": "/Users/ngxcalvin/.codex/skills/new-skill", "to": "/Users/ngxcalvin/repos/skills/skills/new-skill" },
    { "action": "receipt", "to": "/Users/ngxcalvin/.codex/skills/.skill-suitcase-receipt.json" }
  ],
  "conflicts": [],
  "receiptPath": "/Users/ngxcalvin/.codex/skills/.skill-suitcase-receipt.json",
  "backupPath": "/Users/ngxcalvin/.codex/skills/.new-skill.suitcase-pre-promote-<id>",
  "errors": []
}
```

The promote receipt uses a distinct `calvinnwq.skills.promote-rollback.v0`
rollback schema, so the existing `rollback` command treats it as a safe no-op
rather than removing the link (reversing a promote means restoring the backup,
not just unlinking).

Live promotion failures are reported with stable `errors[].code` values:

- `promote_conflicts` — one or more dry-run conflicts blocked mutation
- `existing_repo_skill` — a catalog path appeared after planning and before copy
- `promote_receipt_failed` — the existing receipt could not be snapshotted or
  the new receipt could not be written
- `promote_copy_failed` — copying the target into the catalog failed
- `promote_verify_failed` — hash verification could not be completed
- `promote_verify_mismatch` — the copied catalog tree did not match the target
- `promote_swap_failed` — moving the original aside or creating the symlink
  failed, after which the original target is restored best-effort

## `import-target` Output

`import-target` is the source-of-truth inverse of `repair`. Both own a
receipt-owned copy-mode target skill that went `dirty`, but they move bytes in
opposite directions: `repair` discards the local edit by replacing the target
from the catalog, while `import-target` keeps the **intentional** local edit by
replacing the **catalog-owned** source from the target so the change can land in
the skills repo through review/PR. Pass an explicit `--skill <name>` (there is no
all-skills import) plus exactly one of `--dry-run` or `--apply`. Every
non-`dirty` or non-receipt-owned state is refused and routed to the command that
owns it.

### Decision tree: `track` vs `reconcile` vs `repair` vs `promote` vs `import-target`

All five commands adopt or move a single target skill; the target's `status` and
who owns the drift decide which one is correct:

| Situation | Status | Drift owner | Command | Direction |
| --- | --- | --- | --- | --- |
| Target already matches the catalog, only a receipt is missing | `unknown` (exact match) | catalog | `track` | none (writes a receipt) |
| Catalog-owned skill, **no receipt**, target drifted from the catalog | `unknown` | catalog | `reconcile` | catalog → target |
| Brand-new skill created in the target, not in the catalog | `unknown` | target | `promote` | target → catalog (new skill) |
| Receipt-owned skill went `dirty` from **accidental/unwanted** edits | `dirty` | catalog | `repair` | catalog → target (discard edit) |
| Receipt-owned skill went `dirty` from **intentional** edits you want in the repo | `dirty` | target | `import-target` | target → catalog (keep edit) |

`repair` and `import-target` see the same `dirty` receipt-owned target; only the
operator knows whether the drift was a mistake (`repair`) or a deliberate local
edit worth importing (`import-target`). That product decision is why
`import-target` is approval-gated (see the drift audit below) and never runs
implicitly.

`--dry-run` is read-only. It uses `diff` and `status` to prove the selected skill
is a receipt-owned `dirty` target whose catalog has **not** moved since it was
tracked, then reports the target id, install root, target skill path, catalog
skill path, receipt state, the receipt hash, the current catalog hash, the live
target hash, the changed files, and the planned repo writes the import would
make. The `finalAction` is always `replace-catalog-from-target`.

On a clean dry run (`ok: true`):

```json
{
  "ok": true,
  "dryRun": true,
  "readOnly": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "target": "openclaw",
  "assignment": "openclaw",
  "installRoot": "/tmp/openclaw/skills",
  "selected": { "skills": ["foo"] },
  "candidates": [
    {
      "skill": "foo",
      "targetId": "openclaw",
      "installRoot": "/tmp/openclaw/skills",
      "targetSkillPath": "/tmp/openclaw/skills/foo",
      "catalogSkillPath": "/Users/ngxcalvin/repos/skills/skills/foo",
      "status": "dirty",
      "reason": "target files differ from receipt",
      "receiptState": "receipt-owned",
      "receiptHash": "e1c..",
      "catalogHash": "e1c..",
      "targetHash": "9a4..",
      "variant": "canonical",
      "changes": { "create": 1, "update": 1, "delete": 0, "unchanged": 2 },
      "repoWrites": [
        { "action": "update", "skill": "foo", "relativePath": "SKILL.md", "catalogPath": "/Users/ngxcalvin/repos/skills/skills/foo/SKILL.md", "targetPath": "/tmp/openclaw/skills/foo/SKILL.md" },
        { "action": "create", "skill": "foo", "relativePath": "helper.js", "catalogPath": "/Users/ngxcalvin/repos/skills/skills/foo/helper.js", "targetPath": "/tmp/openclaw/skills/foo/helper.js" }
      ],
      "finalAction": "replace-catalog-from-target"
    }
  ],
  "refused": { "skills": [] },
  "summary": { "planned": 1, "candidates": 1, "refused": 0, "blocked": 0, "dirty": 1, "create": 1, "update": 1, "delete": 0, "unchanged": 2 },
  "imported": { "skills": [], "files": 0 },
  "receiptPath": null,
  "postImportStatus": null,
  "errors": []
}
```

The `repoWrites` invert the catalog-vs-target diff for the import direction: an
`update` rewrites the catalog file with the target version, a `create` adds a
catalog file for a target-only file, and a `delete` removes a catalog file the
target dropped. A valid candidate always has `receiptHash === catalogHash` (the
catalog has not changed since the target was tracked) and a differing
`targetHash` (the intentional local edit).

`--apply` re-runs the same candidate checks, then for each candidate copies the
live target tree into a catalog-sibling staging dir, hash-verifies the staged
copy against the target, renames the old catalog skill aside, renames the staged
copy into place, and re-verifies the installed catalog tree matches the target.
It then refreshes the target receipt (`mode: "import"`, `sourceHash` = the new
catalog hash) so `status` reports the freshly-imported target as `current`
instead of `dirty`, and verifies post-import status. The live target root is
never mutated beyond that receipt refresh. Because the catalog is a git repo, git
is the rollback: on success the catalog-side backups are removed, leaving the
skills repo with only normal git changes for review/PR. Any mid-apply failure
unwinds every completed swap, restores the catalog from backup, and restores the
original receipt.

On success (`ok: true`), `imported.skills` lists the imported skills,
`imported.files` counts the imported target files, `receiptPath` points to the
refreshed target receipt, and `postImportStatus` contains the verification:

```json
{
  "ok": true,
  "dryRun": false,
  "readOnly": false,
  "imported": {
    "skills": ["foo"],
    "files": 4
  },
  "receiptPath": "/tmp/openclaw/skills/.skill-suitcase-receipt.json",
  "postImportStatus": { "ok": true, "statuses": [{ "skill": "foo", "status": "current" }] },
  "errors": []
}
```

### Drift audit / heartbeat

`import-target` is the approval-gated tail of a lightweight drift audit. Run a
periodic `status` / `diff` heartbeat across modeled writable targets to report
when a catalog-owned skill has drifted `dirty` in a live target. Reporting drift
is automatic; importing it is not. Treat a `dirty` catalog-owned target as stop
and inspect: surface the target id, skill, receipt/catalog/target hashes, and the
changed files, then run `import-target --dry-run` to preview the planned repo
writes, and only run `import-target --apply` for that named skill after
**explicit approval** that the drift is intentional and should become the repo
version. A drift report must never trigger an implicit import.

On failure (`ok: false`), `errors` contains objects with `code` and `message`
(plus optional `skill` and `path`). Error codes include:

- `invalid_skill_filter` — no non-blank `--skill` filter was provided
- `invalid_import_mode` — neither or both of `--dry-run` and `--apply` were provided
- `read_only_target` — the resolved target provider is modeled read-only
- `missing_install_root` — the target could not be resolved to an install root
- `already_current` — a selected skill already matches the catalog; import is a no-op
- `route_to_promote` — a selected skill is `unknown`; add a target-created skill with `promote`, not `import-target`
- `route_to_pack_apply` — a selected skill is `missing`, `behind`, or `version`; the catalog is ahead, so install/update with `pack` + `apply`
- `blocked_skill` — compatibility rules block the selected skill for the target
- `skill_not_planned` — a selected skill is not planned for the target
- `unsafe_path` — the skill, source path, or target path would escape the approved roots
- `unsupported_install_mode` — the selected skill is a symlink-mode install; the target already resolves to the catalog, so there is nothing to import
- `unsupported_target_state` — the selected target has no usable `dirty` status entry to import
- `catalog_diverged` — the target is `dirty` but the catalog also moved since the skill was tracked; reconcile the catalog (`pack` + `apply`, then `repair`) before importing, so a stale local copy never clobbers newer catalog work
- `catalog_unreadable` / `unsafe_catalog_tree` / `missing_catalog` — the catalog source cannot be compared or copied safely
- `target_unreadable` / `unsafe_target_tree` — the target contains symlinks, special entries, or unreadable state that cannot be imported safely
- `invalid_receipt` — the existing receipt could not be read before mutation
- `import_write_failed` — copying, swapping, verification, or receipt write failed and was rolled back best-effort
- `post_status_unavailable` / `post_status_not_current` — post-import status verification failed

## Receipt Module

`src/receipt.ts` (and its compiled output at `dist/src/receipt.js`) provides
helpers for building and persisting Suitcase receipts.

```js
import {
  buildReceipt,
  buildInstallRecord,
  buildInstalledFiles,
  readReceipt,
  upsertInstallRecord,
  upsertAndWriteReceipt,
  writeReceipt,
  RECEIPT_FILE,
  RECEIPT_SCHEMA
} from "./dist/src/receipt.js";

// Hash all files under a skill root
const installedFiles = await buildInstalledFiles(skillRoot);

// Build a typed install record
const installRecord = buildInstallRecord({
  agent: "claude",
  mode: "copy",
  sourcePath: "/path/to/skills/my-skill",
  targetPath: "/target/root/my-skill",
  version: "1.2.0",
  installedFiles
});

// Upsert the record into an existing receipt (or create one) and write to disk
await upsertAndWriteReceipt({
  installRoot: "/target/root",
  skillName: "my-skill",
  installRecord
});
```

`buildReceipt` produces a bare receipt shell with `schema`, `source`, and
`installs`. `buildInstalledFiles` hashes regular files under a skill root,
skipping `__pycache__` directories and `.pyc` files; pass an optional
`{ exclude }` iterable of paths to omit specific files or directories (for
example transient apply backups) from the hash set. `upsertInstallRecord` merges
one install record into an in-memory receipt, replacing an existing record for
the same resolved `targetPath` or appending a new record when target paths
differ. `upsertAndWriteReceipt` performs the same merge against the receipt on
disk (creating it if absent and migrating legacy `.skills-sync.json` receipts
when needed), then writes `<installRoot>/.skill-suitcase-receipt.json`.
`readReceipt` reads and normalizes the same modern or legacy receipt path
without writing it. `writeReceipt` writes the full receipt directly without
merging. Both writers
validate all install records before writing, normalize legacy schemas to
`calvinnwq.skills.receipt.v0`, and allow custom receipt paths only when they stay
inside `installRoot`.

Receipt `installs` values are keyed by skill name. A single install is stored as
an object; multiple installs for the same skill are stored as an array.

## Plan Lock (internal API)

`src/plan-lock.ts` (and its compiled output at `dist/src/plan-lock.js`) implements the plan identity contract used to detect when a
previously computed install plan is still valid or has become stale.

```js
import { buildPlanLock, assessPlanLock } from "./dist/src/plan-lock.js";

const lock = await buildPlanLock({ source, target, assignmentPath, sourceCommit });
// lock: { schema, source: { repo, ref, commit }, target, assignmentPath,
//          selectedSkills, planEntries, fileHashes, planId }

const result = await assessPlanLock({ source, target, assignmentPath, lock, sourceCommit });
// result: { valid: boolean, reasons: string[], current: lock | null }
```

`buildPlanLock` produces a deterministic record with schema
`calvinnwq.skills.plan-lock.v0`. It captures the source repo, resolved commit,
selected skills, planned entry metadata, assignment path, per-file SHA-256
hashes for regular skill files, and a `planId` hash over the entire record.
Symlinks, `__pycache__` directories, and `.pyc` files are ignored. If
`sourceCommit` is omitted, the module attempts `git rev-parse HEAD` from the
source root and records `null` when no commit can be resolved.

When the source is a Git checkout, lock creation refuses selected source skills
with untracked, non-ignored files so a lock cannot approve files outside Git
tracking. Ignored files can still be included in the deterministic file hashes.

`assessPlanLock` rebuilds the lock from current state and returns `valid: true`
if nothing changed, or `valid: false` with one or more `reasons` strings
describing what drifted. Reason codes include `invalid_lock`,
`current_plan_unavailable`, `missing_source_metadata`, `source_repo_changed`,
`source_ref_changed`, `source_commit_changed`, `target_changed`,
`assignment_path_changed`, `selected_skills_changed`, `plan_entries_changed`,
`file_hashes_changed`, `plan_id_changed`, and `invalid_lock_schema`.
An unclean selected source skill makes the current plan unavailable.

This module does not write files or require the apply/install layer to exist.

## Development

```bash
pnpm test
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run format:check
pnpm run architecture:check
```

CI runs `pnpm test` on GitHub Actions with Node 24. The script pipeline now builds
TypeScript output to `dist`, then runs Node's built-in test runner against
`dist/tests/*.test.js`. `architecture:check` runs `scripts/check-architecture.mjs`
to enforce the module boundaries described in [`ARCHITECTURE.md`](ARCHITECTURE.md).

The first milestone has no runtime package dependencies (only the TypeScript dev
toolchain). The manifest reader is strict and intentionally scoped to the current
`skill-suitcase.yaml` shape from `/Users/ngxcalvin/repos/skills`, including
manifest-owned logical groups as reporting metadata.
