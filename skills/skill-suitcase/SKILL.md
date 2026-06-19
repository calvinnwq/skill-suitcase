---
name: skill-suitcase
description: Use when asked to install, audit, sync, track, reconcile, apply, rollback, or explain Skill Suitcase-managed agent skills across OpenClaw, Codex, OpenClaw-Codex, Claude, or another machine using a skills catalog.
---

# Skill Suitcase

Use this skill to operate `skill-suitcase` as a cautious skill package manager.
The usual source catalog is `~/repos/skills`; the CLI is either the installed
`skill-suitcase` binary or the source checkout at `~/repos/skill-suitcase`.

## Contract

- Treat read-only commands as the default path: `import`, `validate --strict`,
  `targets`, `plan`, `status`, `diff`, and `pack --dry-run`.
- Mutate live skill roots only after explicit human approval naming the target
  and action.
- Work one target at a time. Do not bulk-repair every target after seeing a
  mixed status report.
- Use local path overrides instead of editing the shared catalog for another
  machine.
- Use `track` only for exact existing matches.
- Use `reconcile --dry-run` before `reconcile --apply`, and only for selected
  catalog-owned skills.
- Use `pack --output` then `apply --artifact` for missing or behind skills.
- Stop and report on `dirty`, broad `unknown`, unexpected target paths, or
  provider-owned skills.
- Never force provider-managed Codex skills such as Codex `linear` into Suitcase
  ownership.

## Setup

Find the CLI and catalog:

```bash
command -v skill-suitcase || true
test -d "$HOME/repos/skill-suitcase" && ls "$HOME/repos/skill-suitcase/dist/src/cli.js"
test -d "$HOME/repos/skills" && git -C "$HOME/repos/skills" status --short --branch
```

Prefer the global binary when it exists. Otherwise use the built source CLI:

```bash
cd "$HOME/repos/skill-suitcase"
pnpm install
pnpm build

export SRC="$HOME/repos/skills"
export CLI="$HOME/repos/skill-suitcase/dist/src/cli.js"
```

With a global install:

```bash
export SRC="$HOME/repos/skills"
export CLI="skill-suitcase"
```

Refresh the catalog before inspecting:

```bash
git -C "$SRC" pull --ff-only
```

## Read-Only Audit

Run the catalog gates first:

```bash
"$CLI" import --source "$SRC" --json
"$CLI" validate --source "$SRC" --strict --json
"$CLI" targets --source "$SRC" --json
"$CLI" status --source "$SRC" --json
```

Current primary target ids:

- `openclaw`
- `codex`
- `openclaw-codex`
- `claude`

Use local overrides on machines whose homes differ from the catalog defaults:

```bash
"$CLI" status --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
"$CLI" diff --source "$SRC" --target codex --codex-home "$HOME/.codex" --json

"$CLI" status --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --json
"$CLI" diff --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --json
```

For OpenClaw-Codex, inspect `targets` first and use the configured path only if
that OpenClaw Codex home exists on the machine.

## Sync Workflow

For exact installed matches that only need receipts:

```bash
"$CLI" track --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill office-hours --skill improve --skill gnhf-postflight --json
```

For selected catalog-owned drift:

```bash
"$CLI" reconcile --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill <skill-name> --dry-run --json
# after approval:
"$CLI" reconcile --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill <skill-name> --apply --json
```

For missing or behind skills, stage an immutable bundle and apply the artifact:

```bash
TMP="$(mktemp -d /tmp/skill-suitcase-codex.XXXXXX)"
"$CLI" pack --source "$SRC" --target codex --codex-home "$HOME/.codex" --output "$TMP" --json
find "$TMP" -maxdepth 4 -type f | sort
ARTIFACT="$(find "$TMP" -name skill-suitcase-bundle.json -print -quit)"
# after approval:
"$CLI" apply --source "$SRC" --target codex --codex-home "$HOME/.codex" --artifact "$ARTIFACT" --json
"$CLI" status --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
```

For Claude, replace `--target codex --codex-home "$HOME/.codex"` with
`--target claude --claude-skills "$HOME/.claude/skills"`.

## Interpretation

Status meanings:

- `current`: installed content and receipt match the catalog.
- `missing` or `behind`: stage with `pack --output`, then apply the artifact.
- `unknown`: existing target lacks a usable Suitcase receipt. Use `track` for
  exact matches or selected `reconcile` for catalog-owned drift.
- `dirty`: target differs from the last recorded Suitcase install. Stop and
  report the exact target path and skill.
- `blocked`: catalog compatibility intentionally refuses that target.

Goal state for an intended target is zero `behind`, `dirty`, `missing`,
`unknown`, and `blocked`.

## Report

After every operation, report:

- source catalog path and Git branch/SHA
- target id and resolved install root
- actions run, grouped as read-only or live mutation
- final summary counts
- rollback receipt path or backup path when live mutation ran
- skipped provider-managed skills

If any target cannot be made current, give the exact command output summary and
the next safest action.
