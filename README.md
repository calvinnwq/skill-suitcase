# Skill Suitcase

Skill Suitcase is a CLI for planning portable skill installs from a catalog repo.

Milestone 1 is deliberately read-only. It reads a catalog manifest, resolves a
target assignment, and emits a JSON plan. It does not write receipts, copy skill
files, mutate target install paths, or touch runtime homes.

## Usage

```bash
node src/cli.js plan --source /Users/ngxcalvin/repos/skills --target openclaw --json
node src/cli.js pack --source /Users/ngxcalvin/repos/skills --target openclaw --dry-run --json
node src/cli.js pack --source /Users/ngxcalvin/repos/skills --target openclaw --output /tmp/skill-suitcase-openclaw --json
node src/cli.js validate --source /Users/ngxcalvin/repos/skills --json
```

Targets currently exercised against fixture #1:

- `openclaw`
- `codex`
- `openclaw-kody-codex`
- `claude`

## JSON Shape

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

## Development

```bash
npm test
```

CI runs the same test suite on GitHub Actions with Node 24.

The first milestone has no package dependencies. The manifest reader is strict
and intentionally scoped to the current `skill-suitcase.yaml` shape from
`/Users/ngxcalvin/repos/skills`.

`pack --dry-run` reports the skill files that would be copied into a staging
bundle, including byte counts and SHA-256 checksums, but creates no bundle
directory and writes no receipts.

`pack --output <dir>` writes only to an explicit staging directory. It refuses
existing output directories and manifest-declared install target paths.
