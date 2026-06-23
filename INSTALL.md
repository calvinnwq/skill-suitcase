# Skill Suitcase Agent Setup

These instructions are for any coding agent setting up Skill Suitcase on a
machine. If you are human, paste this line into your agent:

> Follow `https://github.com/calvinnwq/skill-suitcase/blob/main/INSTALL.md` to
> install the Skill Suitcase CLI and operator skill, then audit my local skill
> targets without mutating them until I approve.

Never paste secrets, tokens, API keys, private prompts, or credential dumps into
chat, issues, PRs, logs, or release notes.

## 1. Install Or Locate The CLI

Check first:

```bash
command -v skill-suitcase || true
if command -v skill-suitcase >/dev/null 2>&1 && test -d "$HOME/repos/skills"; then
  skill-suitcase targets --source "$HOME/repos/skills" --json
fi
```

If missing, install the published CLI:

```bash
npm install --global skill-suitcase
test -d "$HOME/repos/skills" && skill-suitcase targets --source "$HOME/repos/skills" --json
```

For source installs:

```bash
mkdir -p "$HOME/repos"
git clone git@github.com:calvinnwq/skill-suitcase.git "$HOME/repos/skill-suitcase" 2>/dev/null || true
cd "$HOME/repos/skill-suitcase"
git pull --ff-only
corepack enable
pnpm install
pnpm build
```

Use the source CLI as:

```bash
export CLI="$HOME/repos/skill-suitcase/dist/src/cli.js"
node "$CLI" targets --source "$HOME/repos/skills" --json
```

## 2. Install The Operator Skill

Copy the whole `skills/skill-suitcase` directory, not just `SKILL.md`.

From a global npm install:

```bash
SKILL_SRC="$(npm root -g)/skill-suitcase/skills/skill-suitcase"
```

From a source checkout:

```bash
SKILL_SRC="$HOME/repos/skill-suitcase/skills/skill-suitcase"
```

Choose the skill root for the agent runtime you are configuring. Examples:

```bash
# Codex
AGENT_SKILLS_DIR="$HOME/.codex/skills"

# Claude
AGENT_SKILLS_DIR="$HOME/.claude/skills"
```

Install into the selected root:

```bash
mkdir -p "$AGENT_SKILLS_DIR"
rm -rf "$AGENT_SKILLS_DIR/skill-suitcase"
cp -R "$SKILL_SRC" "$AGENT_SKILLS_DIR/"
```

Restart the agent runtime after installing or replacing a skill.

## 3. Install Or Refresh The Skills Catalog

```bash
mkdir -p "$HOME/repos"
git clone git@github.com:calvinnwq/skills.git "$HOME/repos/skills" 2>/dev/null || true
git -C "$HOME/repos/skills" pull --ff-only
```

Use the catalog as the source of truth:

```bash
export SRC="$HOME/repos/skills"
```

New-machine setup installs from this catalog through Skill Suitcase, not directly from `skills.sh` or `npx skills`.
If a selected upstream-managed skill needs source refresh, fetch it only through the catalog-only refresh lane, review the repository diff, and then resume the normal Suitcase audit and sync flow.

## 4. Read-Only Audit First

With a global CLI:

```bash
skill-suitcase import --source "$SRC" --json
skill-suitcase validate --source "$SRC" --strict --json
skill-suitcase targets --source "$SRC" --json
skill-suitcase status --source "$SRC" --json
```

With a source CLI:

```bash
node "$CLI" import --source "$SRC" --json
node "$CLI" validate --source "$SRC" --strict --json
node "$CLI" targets --source "$SRC" --json
node "$CLI" status --source "$SRC" --json
```

Optional upstream source refresh audit:

```bash
skill-suitcase upstream check --source "$SRC" --json
```

If the catalog declares an upstream-managed skill and you are explicitly
refreshing source, fetch one named skill into an isolated temp workspace/home and
review the repo diff shape:

```bash
skill-suitcase upstream fetch --source "$SRC" --skill <skill-name> --dry-run --json
# after approval for catalog-only source import:
skill-suitcase upstream import --source "$SRC" --skill <skill-name> --apply --json
```

`upstream import` writes only the selected catalog skill directory and
`.skill-suitcase/upstream-lock.json`. It does not auto-commit and does not write
to live Codex, Claude, OpenClaw, or other agent homes.

Inspect local Codex and Claude targets with overrides:

```bash
skill-suitcase status --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
skill-suitcase diff --source "$SRC" --target codex --codex-home "$HOME/.codex" --json

skill-suitcase status --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --json
skill-suitcase diff --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --json
```

Use `node "$CLI"` instead of `skill-suitcase` in those commands when operating
from a source checkout.

## 5. Mutate Only After Approval

Use `track` for exact matches only:

```bash
skill-suitcase track --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill office-hours --skill improve --skill gnhf-postflight --json
```

Use `reconcile` only for selected catalog-owned receiptless drift:

```bash
skill-suitcase reconcile --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill <skill-name> --dry-run --json
# after approval:
skill-suitcase reconcile --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill <skill-name> --apply --json
```

Use `repair` only for selected receipt-owned skills that went `dirty` after
external edits. Dirty means stop and inspect first: review `repair --dry-run`,
then replace from catalog with `repair --apply` only after explicit approval. Use
`rollback` to restore the pre-repair dirty content if the replacement is not
wanted:

```bash
skill-suitcase repair --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill <skill-name> --dry-run --json
# after approval:
skill-suitcase repair --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill <skill-name> --apply --json
```

Use `import-target` for the opposite of `repair`: a selected receipt-owned,
catalog-owned skill that went `dirty` because you edited it **intentionally** in
a writable target and want that local version to become the repo version through
review (it moves target → catalog, the inverse of `repair`). The five-way
decision tree for a single skill is: `track` for an exact match that only needs a
receipt, `reconcile` for catalog-owned receiptless drift, `promote` for a
brand-new target-created skill, `repair` to discard an accidental dirty edit, and
`import-target` to keep an intentional one. Dry-run first, then apply only after
explicit approval:

```bash
skill-suitcase import-target --source "$SRC" --target openclaw --skill <skill-name> --dry-run --json
# after approval:
skill-suitcase import-target --source "$SRC" --target openclaw --skill <skill-name> --apply --json
```

Drift audit / heartbeat: re-run `status` and `diff` periodically to report when a
catalog-owned skill has drifted `dirty` in a writable target. Reporting drift is
automatic; importing it is not. Stop and inspect the `import-target --dry-run`
plan, and run `import-target --apply` only after **explicit approval** that the
drift is intentional and should become the repo version. A drift report must
never trigger an implicit import.

Use staged artifacts for missing or behind skills:

```bash
TMP="$(mktemp -d /tmp/skill-suitcase-codex.XXXXXX)"
skill-suitcase pack --source "$SRC" --target codex --codex-home "$HOME/.codex" --output "$TMP" --json
find "$TMP" -maxdepth 4 -type f | sort
ARTIFACT="$(find "$TMP" -name skill-suitcase-bundle.json -print -quit)"
# after approval:
skill-suitcase apply --source "$SRC" --target codex --codex-home "$HOME/.codex" --artifact "$ARTIFACT" --json
```

For Git-backed catalogs, staged artifacts and plan locks refuse selected source
skills with untracked, non-ignored files. Track or remove scratch files inside a
selected skill before packing or applying it.

For Claude, use:

```bash
skill-suitcase pack --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --output "$TMP" --json
skill-suitcase apply --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --artifact "$ARTIFACT" --json
```

## 6. Verify And Report

Finish with:

```bash
skill-suitcase status --source "$SRC" --json
```

Report the catalog branch/SHA, target ids inspected, live mutations run, final
summary counts, receipt or backup paths, and anything skipped. Codex `linear` is
provider-managed by Codex/plugin/MCP and should not be forced into Suitcase
ownership.
