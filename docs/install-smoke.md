# Platform Discovery Smoke Tests

Use these checks after changing platform adapters, assignment paths, or variant
compatibility data.

Build once:

```bash
pnpm run build
```

Run read-only discovery against a catalog:

```bash
node dist/src/cli.js targets --source /path/to/skills-catalog --json
```

Expected target adapters:

- `openclaw-skills-root` resolves to platform adapter `openclaw`, install root
  field `path`, and metadata `workspaceSkillRoot: true`.
- `codex-home` resolves to platform adapter `codex`, install root field
  `skillsPath`, and requires both `codexHome` and `skillsPath`.
- `nested-home-codex` resolves to platform adapter `codex`, install root field
  `skillsPath`, and requires `home`, `codexHome`, and `skillsPath`.
- `claude-skills-root` resolves to platform adapter `claude`, install root field
  `path`.
- `opencode-skills-root` resolves to platform adapter `opencode`, install root
  field `path`, compatibility name `opencode`, and read-only provider metadata.
- `pi-skills-root` resolves to platform adapter `pi`, install root field
  `path`, compatibility name `pi`, and read-only provider metadata.

Then smoke import and the read-only command boundaries:

```bash
node dist/src/cli.js import --source /path/to/skills-catalog --json
node dist/src/cli.js validate --source /path/to/skills-catalog --strict --json
node dist/src/cli.js plan --source /path/to/skills-catalog --target openclaw --json
node dist/src/cli.js diff --source /path/to/skills-catalog --target openclaw --json
node dist/src/cli.js pack --source /path/to/skills-catalog --target openclaw --dry-run --json
node dist/src/cli.js status --source /path/to/skills-catalog --json
```

For Git-backed catalogs, `pack` refuses selected source skills with untracked,
non-ignored files. Commit, stage, or remove scratch files inside selected skills
before expecting the pack smoke to pass.
When a catalog declares a custom `assignmentPaths` entry with a provider-backed
kind such as `opencode-skills-root` or `pi-skills-root`, smoke the boundary as
read-only: `targets`, `status`, and `diff` may report the target, but `pack`,
`apply`, `track`, `reconcile`, `repair`, and `import-target` should return
`read_only_target` instead of writing artifacts, receipts, or target files.

If the catalog declares upstream-managed skills in
`.skill-suitcase/upstream-lock.json`, smoke the source-refresh read-only
boundary before any catalog import:

```bash
node dist/src/cli.js upstream check --source /path/to/skills-catalog --json
node dist/src/cli.js upstream fetch --source /path/to/skills-catalog --skill existing-skill --dry-run --json
```

`upstream check` should report declared skills, pinned package metadata, lineage
metadata, package runner availability, and refresh status without writing files.
The lineage block should include upstream package/version, upstream repo/skill,
imported hash, current catalog hash, and catalog drift.
If upstream is unchanged, no target action is implied.
`upstream fetch` may execute the pinned provider in an isolated temp
workspace/home, but it must not write the catalog or any live target root.
Only run `upstream import --apply` against a disposable Git-backed catalog or an intentionally approved catalog source.
It must refuse malformed upstream lock metadata before fetching, write `skills/<name>` and `.skill-suitcase/upstream-lock.json` only on success, then leave ordinary repository diffs for review.
Treat local catalog edits as catalog-hash drift, preserve catalog source when an
upstream skill is removed or renamed, and use ordinary target status workflows
for target drift.
For upstream-managed skills, `status --json` should carry the same lineage and
add target status, receipt hash, and receipt commit from the selected target
receipt.
Target-scoped status should load lineage for reported skills only and should not hash unrelated upstream-managed catalog skills.
Trust only the exact pinned provider in the isolated temp workspace/home.
Do not trust upstream tooling to choose target roots, write receipts, prove
rollback, or mutate live agent homes.

For a Codex/Claude-only machine, smoke local target overrides and target-scoped
status without requiring OpenClaw paths from the shared catalog to exist:

```bash
node dist/src/cli.js targets --source /path/to/skills-catalog --codex-home ~/.codex --claude-skills ~/.claude/skills --json
node dist/src/cli.js status --source /path/to/skills-catalog --target codex --codex-home ~/.codex --json
node dist/src/cli.js diff --source /path/to/skills-catalog --target codex --codex-home ~/.codex --json
node dist/src/cli.js status --source /path/to/skills-catalog --target claude --claude-skills ~/.claude/skills --json
node dist/src/cli.js diff --source /path/to/skills-catalog --target claude --claude-skills ~/.claude/skills --json
```

`--codex-home`, `--codex-skills`, and `--claude-skills` are local overrides for
global target paths. They are intended for `targets`, `status`, `diff`, `pack`,
`apply`, `track`, `reconcile`, `repair`, and `import-target`; `status --target`
accepts either an assignment path id or an assignment name. Exact assignment
path ids win, so `--target codex` selects the global Codex target when that id
exists.

For Codex or Claude paths that have source variants, `plan`, `diff`, `pack`,
`apply`, `track`, `reconcile`, `repair`, `import-target`, receipts, and `status`
should carry the selected variant name. If a slimmer live variant is required
but no source variant exists, those same boundaries should report blocked
canonical entries instead of silently replacing the live variant.

When smoke testing native symlink installs, use the same approved lock or
artifact path as copy installs and add `--mode symlink` to `apply`. The target
skill root should become a symlink pointing back to the selected catalog source
path, `status` should report it as `current`, and `rollback` should remove only
a symlink that `apply --mode symlink` created.

When smoke testing a selected unknown target reconcile, create a disposable target
skill directory that differs from the catalog and has no receipt, then run
reconcile in read-only mode first:

```bash
node dist/src/cli.js reconcile --source /path/to/skills-catalog --target openclaw --skill existing-skill --dry-run --json
```

The dry run should report `ok: true`, `readOnly: true`, one candidate, the
live-vs-catalog changes, and a `.suitcase-pre-reconcile-*` backup template. Only
run `--apply` against disposable fixtures or an intentionally approved
catalog-owned target; live reconcile replaces the target from catalog source,
writes a `mode: "reconcile"` receipt, verifies status is current, and leaves the
prior target in rollback/backup state.

When smoke testing a selected receipt-owned dirty repair, start with a disposable
copy-mode install that has a Suitcase receipt, edit the target skill after
install, then run repair in read-only mode first:

```bash
node dist/src/cli.js repair --source /path/to/skills-catalog --target openclaw --skill existing-skill --dry-run --json
```

The dry run should report `ok: true`, `readOnly: true`, one dirty candidate,
receipt and catalog hashes, changed files, and a `.suitcase-pre-repair-*` backup
template. Only run `--apply` against disposable fixtures or an intentionally
approved receipt-owned target; live repair backs up the dirty target, replaces it
from catalog source, writes a `mode: "repair"` receipt, verifies status is
current, and leaves rollback metadata that can restore the pre-repair dirty
content.

When smoke testing import-target, start with a disposable receipt-owned copy-mode
install, edit the target skill intentionally after install, then run
import-target in read-only mode first:

```bash
node dist/src/cli.js import-target --source /path/to/skills-catalog --target openclaw --skill existing-skill --dry-run --json
```

The dry run should report `ok: true`, `readOnly: true`, one dirty candidate,
receipt, catalog, and target hashes, changed files, and the planned repo writes.
Only run `--apply` against disposable fixtures or an intentionally approved
receipt-owned target and catalog repo; live import-target copies the target
skill into the catalog source, writes a refreshed `mode: "import"` receipt,
verifies status is current, and leaves ordinary git changes for review.

When smoke testing a target-created skill, create a throwaway skill directory
outside the catalog with `SKILL.md`, then run promote in read-only mode first:

```bash
node dist/src/cli.js promote --source /path/to/skills-catalog --target-skill /path/to/agent-home/skills/new-skill --dry-run --json
```

The dry run should report `ok: true`, `readOnly: true`, and the
`copy`/`verify`/`symlink`/`receipt` plan. Only run `--apply` against disposable
fixtures or an intentionally approved target-created skill; live promotion
copies the skill into `skills/<name>`, replaces the target with a symlink back to
that catalog source, writes a receipt, and preserves the original target in a
hidden backup path.
