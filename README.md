# Skill Suitcase

Skill Suitcase is a CLI for planning portable skill installs from a catalog repo.

Read-only commands (`plan`, `diff`, `pack`, `import`, `validate`, `targets`,
`status`) read a catalog manifest, resolve assignments and assignment paths, and
emit JSON plans, diffs, import findings, target discovery, bundle manifests, or
status reports without touching target install paths or runtime homes.

The `apply` command materializes skills in target install paths. It requires
an explicit approval input (plan-lock or staging artifact), refuses dirty or
unmanaged targets, writes copy installs transactionally, can create approved
repo-pointing symlinks with `--mode symlink`, and emits receipts.

The `rollback` command reverses receipt-backed apply or reconcile changes. It
restores recorded previous contents, removes files, directories, or symlinks the
mutation created, and refuses when the target has drifted from the recorded
applied state.

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

The `promote` command converts a target-created skill into a repo-owned catalog
skill. `promote --dry-run` reports the read-only plan and conflicts; `promote
--apply` copies the target into the catalog, verifies it, replaces the target
with a repo-pointing symlink, and writes a receipt.

## Install

```bash
npm install -g skill-suitcase
suitcase plan --source /path/to/skills-catalog --target openclaw --json
```

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
node dist/src/cli.js promote --source /Users/ngxcalvin/repos/skills --target-skill ~/.codex/skills/new-skill --dry-run --json
node dist/src/cli.js promote --source /Users/ngxcalvin/repos/skills --target-skill ~/.codex/skills/new-skill --apply --json
```

`import --json` is a read-only onboarding inspection for existing skills repos.
It checks for `skill-suitcase.yaml`, the `skills/<name>/SKILL.md` layout, and
catalog portability metadata such as assignments, assignment paths,
compatibility, and variants. Findings are emitted as deterministic JSON with
`warning` or `error` levels; warnings keep `ok: true`, while errors make the
command exit with failure status. The command never creates install roots,
runtime homes, receipts, or bundle artifacts. Directories under `skills/` that
contain `.support-directory` are treated as support data and are not counted as
installable skills.

Targets currently exercised against fixture #1:

- `openclaw`
- `codex`
- `openclaw-codex`
- `claude`

Platform adapters are explicit. `openclaw-skills-root` uses the declared `path`
as the workspace skill root. `codex-home` installs into `skillsPath` without
assuming a universal Codex home. `claude-skills-root` uses the declared `path`.
The `nested-home-codex` adapter is still supported for legacy nested homes, but
it is not part of the current default target set.

Smoke-test discovery with:

```bash
node dist/src/cli.js targets --source /path/to/skills-catalog --json
```

On machines where the shared catalog's checked-in install paths do not match
the local runtime homes, pass local target overrides instead of editing the
catalog:

```bash
node dist/src/cli.js targets --source /path/to/skills-catalog --codex-home ~/.codex --claude-skills ~/.claude/skills --json
node dist/src/cli.js status --source /path/to/skills-catalog --target codex --codex-home ~/.codex --json
node dist/src/cli.js diff --source /path/to/skills-catalog --target claude --claude-skills ~/.claude/skills --json
```

`--codex-home <dir>` overrides the `codex` `codexHome` and defaults its
`skillsPath` to `<dir>/skills`. `--codex-skills <dir>` can override that skills
path directly. `--claude-skills <dir>` overrides the `claude` skills root.
These flags work with `targets`, `status`, `diff`, `pack`, `apply`, `track`, and
`reconcile`. Use `status --target <target>` with an assignment path id or
assignment name. If an exact assignment path id exists, it wins, so
`--target codex` means the global Codex target rather than every target assigned
to Codex.

See [`docs/install-smoke.md`](docs/install-smoke.md) for command-level smoke
checks and [`docs/portability-matrix.md`](docs/portability-matrix.md) for
canonical bundle versus platform variant rules.
The `skills.sh` installer delegation spike is documented in
[`docs/skills-sh-delegation.md`](docs/skills-sh-delegation.md); current guidance
is to defer runtime delegation and keep Skill Suitcase native installs
authoritative.
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

Live `apply`, `track`, `reconcile --apply`, `rollback`, or `promote --apply`
should target disposable fixtures first or require explicit approval for the real
agent home.

## Fresh Codex/Claude Machine

For a machine with Codex and Claude but no OpenClaw, keep the catalog as the
shared source of truth and supply local paths at command time:

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

If matching skills already exist, adopt them without rewriting files:

```bash
node "$CLI" track --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill office-hours --skill gnhf-postflight --json
node "$CLI" track --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --skill office-hours --skill gnhf-postflight --json
```

If selected existing skills are unknown because they lack receipts and differ
from the catalog, inspect the repair first and run the live replacement only
with explicit approval:

```bash
node "$CLI" reconcile --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill office-hours --dry-run --json
node "$CLI" reconcile --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill office-hours --apply --json
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
    "compatibilityEntries": 1,
    "variantEntries": 1,
    "warnings": 0,
    "errors": 0,
    "findings": 0
  },
  "skills": [
    {
      "name": "office-hours",
      "path": "/Users/ngxcalvin/repos/skills/skills/office-hours",
      "skillFile": "/Users/ngxcalvin/repos/skills/skills/office-hours/SKILL.md",
      "referencedBy": ["core"],
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
`missing_assignment_paths`, `empty_suitcase`, `unused_compatibility`,
`missing_compatibility`, `missing_compatibility_agents`,
`missing_compatibility_variant`, `missing_variant_metadata`,
`missing_variant_agents`, and `unused_variants`. Error codes include
`missing_manifest`, `unreadable_manifest`, `missing_skills_directory`,
`unreadable_skills_directory`, `missing_suitcases`, `missing_assignments`,
`empty_assignment`, `unknown_suitcase`, `invalid_assignment_path`,
`unknown_assignment_path_target`, `invalid_skill_name`,
`missing_skill_directory`, `missing_skill_file`, `missing_variant_source`,
`invalid_variant_source`, `missing_variant_directory`, and
`missing_variant_skill_file`.

## `validate` Strict Mode

`validate --source <skills-repo> --json` runs fast catalog-health checks only
(manifest relationships plus per-skill `SKILL.md` presence). Adding `--strict`
extends the same command into strict Skillify-10 contract validation for every
skill referenced by a suitcase.

```bash
node dist/src/cli.js validate --source /Users/ngxcalvin/repos/skills --strict --json
```

Strict mode mirrors the deterministic checks in
`skills/skillify/scripts/check_skillify_contract.py` from the catalog repo, so
the CLI scores each skill the same way without shelling out to Python. The
result gains two fields:

- `strict`: `true` when strict scoring ran (`false` for basic validation, where
  `contracts` is always empty).
- `contracts`: one report per referenced skill, sorted by skill name. Each
  report has `skill`, `score`, `total` (always `10`), `complete`, and the ten
  `items`. Every item carries `id`, `name`, `ok`, `applicable`, `evidence`, and
  `missing` reasons. Evidence paths are emitted relative to the source root for
  deterministic JSON.

`summary` also gains `contractsEvaluated` and `contractsComplete` counts.

Strict mode distinguishes warnings from release-blocking failures:

- An **applicable** item that is not satisfied becomes a
  `skillify_contract_failed` error finding, which flips `ok` to `false` and exits
  non-zero. These are release-blocking.
- A **not-applicable** item (for example LLM evals on a skill that makes no model
  calls, or filing rules on a skill that writes no notes) that lacks evidence
  becomes a `skillify_contract_warning`, which is reported but keeps `ok: true`.

```json
{
  "ok": false,
  "strict": true,
  "summary": { "referencedSkills": 4, "contractsEvaluated": 4, "contractsComplete": 3, "findings": 3 },
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
`track`, `reconcile`, receipts, and `status`. See
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
Errors tied to a planned source skill may also include a `skill` field.

## `pack` Output

`pack --dry-run` reports the skill files that would be copied into a staging
bundle, including byte counts and SHA-256 checksums, but creates no bundle
directory and writes no receipts.

Like `diff`, `pack` resolves `--target` to an assignment plan, so `--target` may
be either an assignment name (`openclaw`) or an `assignmentPath` id
(`codex`). The resolved assignment drives the plan, while the output and
stored manifest `target` field echoes the value you passed.

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
`artifactId`, `source`, `target`, `action`, `createdAt`, `summary`, `files`,
`planned`, and `blocked`. `source` includes the resolved catalog repo,
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
          "skill": "office-hours",
          "status": "current",
          "target": "/tmp/codex/skills",
          "targetPath": "/tmp/codex/skills/office-hours",
          "reason": "installed skill matches source version and content hash",
          "installedVersion": "2026.06.10",
          "currentVersion": "2026.06.10",
          "installedCommit": "deadbeef",
          "currentCommit": "42fe414dc8770117bc0c5c3c8c7619d25627898a",
          "installedHash": "e1c..",
          "currentHash": "e1c..",
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
      "skill": "office-hours",
      "status": "current",
      "target": "/tmp/codex/skills",
      "targetPath": "/tmp/codex/skills/office-hours",
      "reason": "installed skill matches source version and content hash",
      "installedVersion": "2026.06.10",
      "currentVersion": "2026.06.10",
      "installedCommit": "deadbeef",
      "currentCommit": "42fe414dc8770117bc0c5c3c8c7619d25627898a",
      "installedHash": "e1c..",
      "currentHash": "e1c..",
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

`status.status` values:

- `current`: installed receipt version and content match the source skill
  (for symlink installs, the target link points at the selected source path)
- `behind`: source content changed after the recorded install
- `version`: source `SKILL.md` frontmatter `version` changed
- `dirty`: target files or symlink differ from the recorded install
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
pre-apply target status, materializes planned skills, and emits a receipt per
skill. Copy-mode receipts capture the pre-apply state of every written file (a
`rollback` record) so the install can later be reversed with `suitcase
rollback`.

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
- `diff_*` — a target-resolution error propagated from the diff layer;
  `diff_blocked_skill` reports a planned skill that is blocked for the target
  (for example when a required source variant is missing)
- `unmanaged_target` — target has no managed status entries; install it first
- `unsafe_target_state` — a planned skill is `dirty` or `unknown`
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

`assessPlanLock` rebuilds the lock from current state and returns `valid: true`
if nothing changed, or `valid: false` with one or more `reasons` strings
describing what drifted. Reason codes include `invalid_lock`,
`current_plan_unavailable`, `missing_source_metadata`, `source_repo_changed`,
`source_ref_changed`, `source_commit_changed`, `target_changed`,
`assignment_path_changed`, `selected_skills_changed`, `plan_entries_changed`,
`file_hashes_changed`, `plan_id_changed`, and `invalid_lock_schema`.

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
`skill-suitcase.yaml` shape from `/Users/ngxcalvin/repos/skills`.
