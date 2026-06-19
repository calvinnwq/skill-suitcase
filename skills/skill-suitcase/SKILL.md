---
name: skill-suitcase
description: Use when asked to install, audit, sync, track, reconcile, apply, rollback, or explain Skill Suitcase-managed agent skills, including dirty repair, across OpenClaw, Codex, OpenClaw-Codex, Claude, or another machine using a skills catalog.
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
- Prefer provider/source matrix rows and `targets --json` discovery over
  hardcoding every current and future runtime variant.
- Use `track` only for exact existing matches.
- Use `reconcile --dry-run` before `reconcile --apply`, and only for selected
  catalog-owned skills.
- Use `pack --output` then `apply --artifact` for missing or behind skills.
- Treat `dirty` as stop and inspect first. For a selected receipt-owned `dirty`
  skill, review `repair --dry-run`, then run `repair --apply` for that named
  skill only after explicit approval; use `rollback` to restore the pre-repair
  content. Refuse broad/all-target dirty repair.
- Stop and report on broad `unknown`, unexpected target paths, or provider-owned
  skills.
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

## Source And Target Matrix

Use this matrix to choose the command shape. Add new providers as rows in the
same model; do not rewrite the workflow around provider-specific prose.

| Surface | Target id | Discover with | Local override | Mutation stance |
| --- | --- | --- | --- | --- |
| OpenClaw workspace | `openclaw` | `targets --json` | usually none | live only after approval |
| Global Codex | `codex` | `targets --json` | `--codex-home` or `--codex-skills` | live only after approval |
| OpenClaw Codex home | `openclaw-codex` | `targets --json` | target-specific Codex home if needed | live only after approval |
| Claude skills root | `claude` | `targets --json` | `--claude-skills` | live only after approval |
| Provider-managed skills | provider-specific | provider/plugin docs | none in Suitcase | read-only or skip |
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

"$CLI" status --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --json
"$CLI" diff --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --json
```

For nested or provider-specific homes, inspect `targets` first and use only
install roots that exist on the machine and are intended to be Suitcase-owned.

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

For another target, keep the same pattern and replace only the target id and
override flags from the matrix.

## Interpretation

Status meanings:

- `current`: installed content and receipt match the catalog.
- `missing` or `behind`: stage with `pack --output`, then apply the artifact.
- `unknown`: existing target lacks a usable Suitcase receipt. Use `track` for
  exact matches or selected `reconcile` for catalog-owned receiptless drift.
- `dirty`: target differs from the last recorded Suitcase install. Stop and
  report the exact target path and skill; for a receipt-owned skill, repair it
  with `repair --dry-run` then `repair --apply` after approval.
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
