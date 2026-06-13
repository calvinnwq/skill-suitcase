# Skill Suitcase

Skill Suitcase is a CLI for planning portable skill installs from a catalog repo.

Read-only commands (`plan`, `diff`, `pack`, `import`, `validate`, `targets`,
`status`) read a catalog manifest, resolve assignments and assignment paths, and
emit JSON plans, diffs, import findings, target discovery, bundle manifests, or
status reports without touching target install paths or runtime homes.

The `apply` command writes skill files into target install paths. It requires
an explicit approval input (plan-lock or staging artifact), refuses dirty or
unmanaged targets, writes transactionally, and emits receipts.

The `rollback` command reverses an apply using the rollback state captured in a
receipt. It restores each written file to its pre-apply contents (or removes
files the apply created), refusing when the target has drifted from the recorded
applied state.

The `track` command adopts skills that are already installed in a target. It
verifies the live files match the catalog source, then writes receipts so the
existing install comes under Suitcase management without rewriting any skill
files.

## Usage

```bash
pnpm run build
node dist/src/cli.js plan --source /Users/ngxcalvin/repos/skills --target openclaw --json
node dist/src/cli.js diff --source /Users/ngxcalvin/repos/skills --target openclaw --json
node dist/src/cli.js pack --source /Users/ngxcalvin/repos/skills --target openclaw --dry-run --json
node dist/src/cli.js pack --source /Users/ngxcalvin/repos/skills --target openclaw --output /tmp/skill-suitcase-openclaw --json
node dist/src/cli.js import --source /Users/ngxcalvin/repos/skills --json
node dist/src/cli.js validate --source /Users/ngxcalvin/repos/skills --json
node dist/src/cli.js targets --source /Users/ngxcalvin/repos/skills --json
node dist/src/cli.js status --source /Users/ngxcalvin/repos/skills --json
node dist/src/cli.js apply --source /Users/ngxcalvin/repos/skills --target openclaw --lock /tmp/plan-lock.json --json
node dist/src/cli.js apply --source /Users/ngxcalvin/repos/skills --target openclaw --artifact /tmp/skill-suitcase-bundle.json --json
node dist/src/cli.js rollback --receipt /tmp/openclaw-install/.skill-suitcase-receipt.json --json
node dist/src/cli.js track --source /Users/ngxcalvin/repos/skills --target openclaw --json
```

`import --json` is a read-only onboarding inspection for existing skills repos.
It checks for `skill-suitcase.yaml`, the `skills/<name>/SKILL.md` layout, and
catalog portability metadata such as assignments, assignment paths,
compatibility, and variants. Findings are emitted as deterministic JSON with
`warning` or `error` levels; warnings keep `ok: true`, while errors make the
command exit with failure status. The command never creates install roots,
runtime homes, receipts, or bundle artifacts.

Targets currently exercised against fixture #1:

- `openclaw`
- `codex` / `codex-global`
- `openclaw-kody-codex`
- `openclaw-workspace-codex`
- `claude` / `claude-global`

Platform adapters are explicit. `openclaw-skills-root` uses the declared `path`
as the workspace skill root. `codex-home` and `nested-home-codex` install into
`skillsPath` without assuming a universal Codex home. `claude-skills-root` uses
the declared `path`.

Smoke-test discovery with:

```bash
node dist/src/cli.js targets --source /path/to/skills-catalog --json
```

See [`docs/install-smoke.md`](docs/install-smoke.md) for command-level smoke
checks and [`docs/portability-matrix.md`](docs/portability-matrix.md) for
canonical bundle versus platform variant rules.

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
`track`, receipts, and `status`. See
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
`assignmentPath` id (`codex-global`). `assignment` is the resolved assignment
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

## `pack` Output

`pack --dry-run` reports the skill files that would be copied into a staging
bundle, including byte counts and SHA-256 checksums, but creates no bundle
directory and writes no receipts.

Like `diff`, `pack` resolves `--target` to an assignment plan, so `--target` may
be either an assignment name (`openclaw`) or an `assignmentPath` id
(`codex-global`). The resolved assignment drives the plan, while the output and
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

`targets` returns assignment target discovery details instead of install plans:

```json
{
  "ok": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "targets": [
    {
      "id": "codex-global",
      "name": "codex-global",
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

`status` walks every manifest `assignmentPaths` entry, resolves the referenced
assignment plan, reads each install root and optional `.skill-suitcase-receipt.json`
receipt (or `.skills-sync.json` for migration compatibility), and reports one
status per planned or blocked skill. It uses `path` for `openclaw-skills-root`
and `claude-skills-root` entries, and `skillsPath` for `codex-home` and
`nested-home-codex` entries. Install roots must already exist.

```json
{
  "ok": true,
  "source": "/Users/ngxcalvin/repos/skills",
  "manifestPath": "/Users/ngxcalvin/repos/skills/skill-suitcase.yaml",
  "assignments": [
    {
      "assignmentPath": "codex-global",
      "assignment": "codex",
      "kind": "codex-home",
      "installRoot": "/tmp/codex/skills",
      "statusCount": 1,
      "statuses": [
        {
          "assignment": "codex",
          "assignmentPath": "codex-global",
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
      "assignmentPath": "codex-global",
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

## `apply` Output

`apply` requires exactly one of `--lock` (a plan-lock file path) or `--artifact`
(a staging bundle path or directory). It validates the approval input, checks
pre-apply target status, writes skill files transactionally, and emits a receipt
per skill. Each receipt also captures the pre-apply state of every written file
(a `rollback` record) so the install can later be reversed with
`suitcase rollback`.

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
- `status_*` — a pre-apply status-layer error (prefixed with `status_`)
- `write_error` — a file write or rollback failure

## `rollback` Output

`rollback` reverses an apply from a receipt. It resolves `--receipt` to a receipt
file (a directory argument resolves to `<dir>/.skill-suitcase-receipt.json`),
then walks each install record's captured `rollback` state. For each skill it
first checks that the target still matches the recorded applied state; on a match
it restores every file to its pre-apply contents and removes files the apply
created.

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

- `restored`: the recorded previous file states were restored (and apply-created
  files removed)
- `noop`: the record has no rollback state, or it was already rolled back
- `refused`: the target drifted from the recorded applied state, or every file
  failed to restore
- `partial`: some files were restored or removed but at least one failed

`summary` holds aggregate counts across the receipt: `restored` and `removed`
count individual files, `noop` and `refused` count skills, and `failed` counts
files that could not be restored or removed. After a fully successful rollback
of a previously installed skill, the receipt's rollback record is marked
`rolled-back`, so re-running `rollback` is a deterministic no-op. If the apply
created the whole skill install, rollback removes that install record from the
receipt.

On failure (`ok: false`), `errors` contains objects with `code` and `message`
(plus optional `skill` and `path`). Error codes include:

- `invalid_receipt` — the receipt is missing, unreadable, or has malformed JSON,
  schema, installs map, install records, or rollback records
- `target_drift` — the target differs from the applied state recorded at apply time
- `restore_impossible` — the previous state cannot be restored (for example the
  original target was not a regular file)
- `rollback_record_invalid` — stored rollback bytes do not match their recorded digest
- `restore_write_failed` — restoring a file's previous contents failed
- `rollback_remove_failed` — removing an apply-created file failed
- `receipt_write_failed` — rollback restored files but could not persist the
  updated receipt

## `track` Output

`track` adopts an existing install into a receipt without rewriting files. It
runs a `diff` of `--source` against `--target`, then writes a receipt for every
planned skill whose live install already matches the catalog source exactly.

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
  "errors": []
}
```

Each tracked skill is written with `mode: "track"` and a `priorState` of
`{ "status": "unknown", "reason": "target existed before Suitcase tracking" }`,
since Suitcase did not perform the original install. On success, `tracked.skills`
lists the adopted skills (sorted) and `tracked.files` counts the receipted files.

`track` writes no receipts unless every planned skill matches. It refuses (with
`ok: false` and `summary.refused` counting the failures) when a target skill
directory is absent, when any file would be created/updated, when the target has
extra or unreadable files, or when a skill is blocked. Error codes include:

- `missing_install_root` — the target could not be resolved to an install root
- `target_missing` — a planned skill's target directory or file is absent
- `target_mismatch` — target files do not match the source (`update`/`extra`)
- `target_unreadable` — a target skill path is not a directory or cannot be read
- `target_symlink` — the target skill tree contains a symlink
- `source_missing` — a source entry is absent
- `source_unreadable` — a source skill directory cannot be read
- `blocked_skill` — compatibility rules block the skill for that assignment
- `invalid_receipt` — the existing receipt cannot be read or normalized
- `receipt_write_failed` — the adoption receipt could not be written
- `diff_*` — a diff-layer error propagated from target resolution

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
