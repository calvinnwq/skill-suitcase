# Getting Started

This walkthrough takes you from `npm install` to a first managed skill install and a receipt-backed rollback.
Every example uses portable paths, and the managed-install steps target a disposable directory, so you can exercise the audit, staging, apply, and rollback flow without touching a real agent home.
The optional operator-skill step in section 2 is the one step that writes into a real agent runtime directory.

Skill Suitcase is JSON-first.
Structured command invocations require `--json`, and their result objects, including structured `ok: false` errors, go to stdout.
Read the JSON before every mutation.

If a coding agent is doing this setup for you, hand it [`INSTALL.md`](../INSTALL.md) instead.
That runbook covers the same flow with agent-safe defaults and approval boundaries.

## 1. Install The CLI

Skill Suitcase requires Node.js 20 or newer and has no runtime package dependencies.

```bash
npm install --global skill-suitcase
```

Running `skill-suitcase` without arguments prints the full command list on stderr and exits with code 2.
Command results always go to stdout; usage and fatal diagnostics go to stderr.

## 2. Install The Operator Skill Into Your Agent

The npm package ships an operator skill that teaches a coding agent the conservative Suitcase workflow: read-only audit first, mutation only after explicit approval.
This step writes into your agent runtime's skills root; skip it for now if you only want to try the CLI.

```bash
SKILL_SRC="$(npm root -g)/skill-suitcase/skills/skill-suitcase"

# Pick the skills root for your agent runtime, for example:
AGENT_SKILLS_DIR="$HOME/.claude/skills"

mkdir -p "$AGENT_SKILLS_DIR"
rm -rf "$AGENT_SKILLS_DIR/skill-suitcase"
cp -R "$SKILL_SRC" "$AGENT_SKILLS_DIR/"
```

Copy the whole directory and remove any previous install first, so a replacement never leaves stale files behind.

Restart the agent runtime after installing or replacing a skill.
[`INSTALL.md`](../INSTALL.md) lists the common skills roots for other runtimes.

## 3. Set Up A Skills Catalog

A catalog is a directory with a `skill-suitcase.yaml` manifest and one directory per skill under `skills/`.
The catalog, not any live agent home, is the source of truth.

If your team already has a reviewed catalog repository, replace `<your-catalog-remote>` with its remote URL and clone it:

```bash
CATALOG_REMOTE="<your-catalog-remote>"
mkdir -p "$HOME/.skill-suitcase"
git clone "$CATALOG_REMOTE" "$HOME/.skill-suitcase/skills"
SRC="$HOME/.skill-suitcase/skills"
```

Otherwise, create a minimal catalog with one starter skill:

```bash
SRC="$HOME/.skill-suitcase/skills"
mkdir -p "$SRC/skills/hello-world"

cat > "$SRC/skill-suitcase.yaml" <<'YAML'
suitcases:
  starter:
    skills:
      - hello-world

assignments:
  claude:
    suitcases:
      - starter

assignmentPaths:
  claude:
    kind: claude-skills-root
    assignment: claude
    path: /path/to/claude/skills
YAML

cat > "$SRC/skills/hello-world/SKILL.md" <<'MARKDOWN'
---
name: hello-world
version: 2026.01.01
description: Use when trying Skill Suitcase for the first time.
---

# Hello World

A starter skill used to exercise the Skill Suitcase install workflow.
MARKDOWN
```

Git backing is the preferred operating model, and staging refuses selected skills with untracked, non-ignored files in a Git-backed catalog, so commit the initial content:

```bash
git -C "$SRC" init
git -C "$SRC" add .
git -C "$SRC" commit -m "feat: add hello-world starter skill"
```

The manifest declares suitcases (named skill groups), assignments (which suitcases a target receives), and assignment paths (where each target installs).
See [`SPEC.md`](../SPEC.md) for the full catalog contract.

## 4. Point Targets At Your Machine With Local Overrides

Manifest `assignmentPaths` record absolute install roots, so a shared catalog usually declares paths that do not exist on your machine.
The manifest does not expand `~` or environment variables; per-machine paths come from CLI override flags at invocation time:

| Flag | Target id | Overrides |
| --- | --- | --- |
| `--codex-home` | `codex` | Codex home; the skills root defaults to `<dir>/skills` |
| `--codex-skills` | `codex` | Codex skills root directly |
| `--claude-skills` | `claude` | Claude skills root |
| `--agents-skills` | `agents` | Shared agents skills root |
| `--grok-skills` | `grok` | Grok skills root |

For this walkthrough, keep the target disposable:

```bash
TARGET="$(mktemp -d "${TMPDIR:-/tmp}/skill-suitcase-claude.XXXXXX")"
skill-suitcase targets --source "$SRC" --claude-skills "$TARGET" --json
```

`targets` reports every modeled target, its resolved install root, per-path existence, and safety classification without writing anything.
When you are ready to manage a real skills root, complete the read-only audit below and get explicit approval before replacing `"$TARGET"` with a path such as `"$HOME/.claude/skills"`.

## 5. Audit Read-Only First

Run the read-only commands before any mutation:

```bash
skill-suitcase import --source "$SRC" --json
skill-suitcase validate --source "$SRC" --json
skill-suitcase plan --source "$SRC" --target claude --json
skill-suitcase status --source "$SRC" --target claude --claude-skills "$TARGET" --json
skill-suitcase diff --source "$SRC" --target claude --claude-skills "$TARGET" --json
```

- `import` loads the catalog model: skills, suitcases, assignments, and metadata.
- `validate` reports manifest and catalog findings.
- `plan` lists which skills the target should receive; it does not resolve target install paths, so it needs no override flags.
- `status` classifies each modeled install as `current`, `behind`, `version`, `dirty`, `missing`, `unknown`, or `blocked`.
- `diff` reports per-skill file changes between catalog source and the live target.

For the fresh walkthrough target, `status` reports `hello-world` as `missing` and `diff` plans one `create`.
None of these commands create install roots, receipts, or catalog files.

`validate --strict` additionally scores every skill against the Skillify authoring contract used for reviewed catalogs.
A minimal starter skill fails that contract with `skillify_contract_failed` findings until it adds the required sections, scripts, and tests, so treat strict mode as the release gate for a reviewed catalog rather than a first-run requirement.

## 6. Stage With `pack`, Install With `apply`

Mutation requires an explicit approval input.
Stage a review artifact into a temporary directory, inspect it, then apply it:

```bash
OUT="$(mktemp -d "${TMPDIR:-/tmp}/skill-suitcase-pack.XXXXXX")"
skill-suitcase pack \
  --source "$SRC" \
  --target claude \
  --claude-skills "$TARGET" \
  --output "$OUT" \
  --json

ARTIFACT="$(find "$OUT" -name skill-suitcase-bundle.json -print -quit)"
```

`pack` writes only beneath the explicit `--output` directory.
Keep the staging directory outside the catalog and outside every resolved target root.

Review the staged files and the current `diff`, then apply:

```bash
skill-suitcase apply \
  --source "$SRC" \
  --target claude \
  --claude-skills "$TARGET" \
  --artifact "$ARTIFACT" \
  --json

skill-suitcase status --source "$SRC" --target claude --claude-skills "$TARGET" --json
```

`apply` is transactional: it installs the planned skills and writes a `.skill-suitcase-receipt.json` receipt at the target root recording ownership, source provenance, install mode, file hashes, and rollback metadata.
`status` now reports `hello-world` as `current`.

Two safety properties matter here:

- Ordinary missing/behind writes are rebuilt from current catalog source, and artifact file hashes gate only the dirty-behind exception, so re-run `pack` immediately before `apply` instead of treating an older artifact as byte-for-byte authorization.
- The artifact does not bind the resolved target override or install mode, so approval must name the exact source, target path, and copy/symlink mode at invocation time.

## 7. Roll Back Safely

Receipts created by `apply`, `reconcile`, or `repair` can reverse recorded installs when they include rollback metadata:

```bash
skill-suitcase rollback --receipt "$TARGET/.skill-suitcase-receipt.json" --json
skill-suitcase status --source "$SRC" --target claude --claude-skills "$TARGET" --json
```

`rollback` first verifies that the current target bytes still match the applied receipt; drift is a refusal, not something it overwrites.
It reverses recorded `apply`, `reconcile`, and `repair` state, including links created by `apply --mode symlink`.
It does not restore promotions; a promotion receipt is a safe no-op with its own preserved backup.
After the rollback, `status` reports the skill as `missing` again and the walkthrough is complete.

## Where To Go Next

- [`command-reference.md`](command-reference.md) covers flags, approval requirements, state meanings, and refusal codes for every command.
- [`README.md`](../README.md) explains the safety model and the recovery decision tree (`track`, `reconcile`, `repair`, `prune`, `promote`, `import-target`).
- [`INSTALL.md`](../INSTALL.md) is the agent-facing setup runbook, including source installs and per-runtime skills roots.
- [`SPEC.md`](../SPEC.md) defines the normative current-state contract.
