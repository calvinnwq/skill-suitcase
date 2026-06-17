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

Then smoke import and the read-only command boundaries:

```bash
node dist/src/cli.js import --source /path/to/skills-catalog --json
node dist/src/cli.js plan --source /path/to/skills-catalog --target openclaw --json
node dist/src/cli.js diff --source /path/to/skills-catalog --target openclaw --json
node dist/src/cli.js pack --source /path/to/skills-catalog --target openclaw --dry-run --json
node dist/src/cli.js status --source /path/to/skills-catalog --json
```

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
`apply`, `track`, and `reconcile`; `status --target` accepts either an
assignment path id or an assignment name. Exact assignment path ids win, so
`--target codex` selects the global Codex target when that id exists.

For Codex or Claude paths that have source variants, `plan`, `diff`, `pack`,
`apply`, `track`, `reconcile`, receipts, and `status` should carry the selected
variant name. If a slimmer live variant is required but no source variant exists,
those same boundaries should report blocked canonical entries instead of silently
replacing the live variant.

When smoke testing native symlink installs, use the same approved lock or
artifact path as copy installs and add `--mode symlink` to `apply`. The target
skill root should become a symlink pointing back to the selected catalog source
path, `status` should report it as `current`, and `rollback` should remove only
a symlink that `apply --mode symlink` created.

When smoke testing a selected unknown target repair, create a disposable target
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
