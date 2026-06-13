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

For Codex or Claude paths that have source variants, `plan`, `diff`, `pack`,
`apply`, `track`, receipts, and `status` should carry the selected variant name.
If a slimmer live variant is required but no source variant exists, those same
boundaries should report blocked canonical entries instead of silently replacing
the live variant.
