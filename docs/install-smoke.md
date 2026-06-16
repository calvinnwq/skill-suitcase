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
`apply`, and `track`; `status --target` accepts either an assignment path id or
an assignment name. Exact assignment path ids win, so `--target codex` selects
the global Codex target when that id exists.

For Codex or Claude paths that have source variants, `plan`, `diff`, `pack`,
`apply`, `track`, receipts, and `status` should carry the selected variant name.
If a slimmer live variant is required but no source variant exists, those same
boundaries should report blocked canonical entries instead of silently replacing
the live variant.

When smoke testing native symlink installs, use the same approved lock or
artifact path as copy installs and add `--mode symlink` to `apply`. The target
skill root should become a symlink pointing back to the selected catalog source
path, `status` should report it as `current`, and `rollback` should remove only
a symlink that `apply --mode symlink` created.
