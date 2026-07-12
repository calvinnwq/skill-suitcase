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

Source installs require Node.js 20 or newer and pnpm 10.34.4, as pinned by
`packageManager` in `package.json`. Install from source with npm's ephemeral
executor so the pinned pnpm version runs without changing Corepack or global
package-manager shims:

```bash
mkdir -p "$HOME/repos"
git clone git@github.com:calvinnwq/skill-suitcase.git "$HOME/repos/skill-suitcase" 2>/dev/null || true
cd "$HOME/repos/skill-suitcase"
git pull --ff-only
pnpm() {
  npm exec --yes --package=pnpm@10.34.4 -- pnpm "$@"
}
test "$(pnpm --version)" = "10.34.4"
pnpm install --frozen-lockfile
pnpm run build
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

# Shared agents root
AGENT_SKILLS_DIR="$HOME/.agents/skills"

# Grok Build
AGENT_SKILLS_DIR="$HOME/.grok/skills"
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
Keep upstream-to-catalog drift separate from catalog-to-target drift.

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

`upstream check --json` reports lineage metadata for upstream-managed skills,
including the upstream package/version, upstream repo/skill, imported hash, and
current catalog hash.
`status --json` carries the same lineage and adds target status, receipt hash,
and receipt commit when the target skill is upstream-managed.
Target-scoped status reports should compute lineage only for reported skills and must not hash unrelated upstream-managed catalog skills.
`validate --strict` also validates `.skill-suitcase/upstream-lock.json` when the
catalog has one.
`validate --strict` also validates manifest `validationPolicy.skillify.skip` entries when the catalog declares them.
Valid `external-managed` entries skip Skillify-10 scoring only after `source`, `owner`, and `reason` provenance validates; missing `reviewAfter` is a warning.
Valid `legacy-local` entries require `source`, `owner`, `reason`, and a `reviewAfter` date, skip scoring, and emit `legacy_skillify_skip` so migration debt remains visible.
Malformed skip policy is release-blocking and does not suppress Skillify-10 scoring.
`import --json` and `validate --json` also report manifest logical groups as catalog metadata.
Broken group references are catalog metadata problems, not implicit install targets.

If the catalog declares an upstream-managed skill and you are explicitly
refreshing source, fetch one named skill into an isolated temp workspace/home and
review the repo diff shape:

```bash
skill-suitcase upstream fetch --source "$SRC" --skill <skill-name> --dry-run --json
# after approval for catalog-only source import:
skill-suitcase upstream import --source "$SRC" --skill <skill-name> --apply --json
```

`upstream import` writes only the selected catalog skill directory and `.skill-suitcase/upstream-lock.json`.
It refuses malformed upstream lock metadata before fetching.
It does not auto-commit and does not write to live Codex, Claude, OpenClaw, or other agent homes.

Lifecycle policy:

- Upstream unchanged: `upstream check` reports declaration and lineage metadata only, with no target action implied.
- Upstream changed: review `upstream fetch --dry-run`, import only the selected
  skill after approval, commit the catalog diff, then use normal target sync.
- Local catalog edit: treat it as catalog-hash drift from the last imported
  upstream hash.
  Commit or revert deliberately, or fork/adopt the skill out of upstream-managed
  mode in a future explicit flow.
- Upstream removed or renamed: report the missing upstream source and preserve
  the catalog source plus upstream lock until an operator chooses keep,
  fork/adopt, rename, or delete.
- Target drift: use ordinary `status` semantics and receipts.
  `track` exact matches, `pack`/`apply` missing or behind skills, and stop on
  dirty targets for `repair` or `import-target`.
  Do not call `npx skills` against live homes as a shortcut.

For skills.sh declarations, the exact package version is pinned but the referenced repository content is not pinned to a source revision or content hash.
Review every fetched diff; Git declarations instead pin a tag or commit.
Do not trust upstream tooling to choose target roots, write receipts, prove
rollback, or mutate live agent homes.

Inspect local Codex, Claude, Agents, and Grok targets with overrides:

```bash
skill-suitcase status --source "$SRC" --target codex --codex-home "$HOME/.codex" --json
skill-suitcase diff --source "$SRC" --target codex --codex-home "$HOME/.codex" --json

skill-suitcase status --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --json
skill-suitcase diff --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --json

skill-suitcase status --source "$SRC" --target agents --agents-skills "$HOME/.agents/skills" --json
skill-suitcase diff --source "$SRC" --target agents --agents-skills "$HOME/.agents/skills" --json

skill-suitcase status --source "$SRC" --target grok --grok-skills "$HOME/.grok/skills" --json
skill-suitcase diff --source "$SRC" --target grok --grok-skills "$HOME/.grok/skills" --json
```

Use `node "$CLI"` instead of `skill-suitcase` in those commands when operating
from a source checkout.
Provider-backed targets such as OpenCode and Pi are read-only compatibility
surfaces, even when the catalog declares a custom `assignmentPaths` review root.
Treat `read_only_target` from `pack`, `apply`, `track`, `reconcile`, `repair`,
`prune`, or `import-target` as the expected boundary instead of trying to adopt that
provider-owned home.
Provider fallback inventory without a catalog assignment has no status entries; a custom assigned provider path may have ordinary status entries, but it remains read-only for materialization and mutation.

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

Use `prune` only for an explicit receipt-owned install that is no longer
assigned to the selected target. Review the read-only plan, then apply only
after approval names the target, exact skill list, and returned plan ID:
Prune requires `.skill-suitcase-receipt.json` and refuses legacy
`.skills-sync.json` receipts without migrating them.
Receipt-owned symlinks created by `promote` can be pruned through this workflow
once the skill is no longer assigned to the selected target.

```bash
skill-suitcase prune --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill <obsolete-skill> --dry-run --json
# after approval naming target, skills, and plan id:
skill-suitcase prune --source "$SRC" --target codex --codex-home "$HOME/.codex" --skill <obsolete-skill> --plan-id <reviewed-plan-id> --apply --json
```

Keep the reported quarantine root, transaction journal, and receipt backup for
review. If the plan-scoped quarantine root already exists, apply refuses the
collision and preserves that root. Do not manually delete obsolete paths or use
broad rollback.
Apply refusals retain apply-mode JSON with `dryRun: false` and `readOnly: true`.
Prune refuses a missing install root instead of recreating it.

Use `import-target` for the opposite of `repair`: a selected receipt-owned,
catalog-owned skill that went `dirty` because you edited it **intentionally** in
a writable target and want that local version to become the repo version through
review (it moves target → catalog, the inverse of `repair`). The six-way
decision tree for a single skill is: `track` for an exact match that only needs a
receipt, `reconcile` for catalog-owned receiptless drift, `promote` for a
brand-new target-created skill, `repair` to discard an accidental dirty edit,
`prune` to remove an obsolete receipt-owned target install, and `import-target`
to keep an intentional edit. Dry-run first, then apply only after
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

The current `rollback` command reverses receipt-backed apply, reconcile, and repair state, including links created by `apply --mode symlink`.
It does not restore a promotion; a promotion receipt is a safe no-op and its preserved backup requires a separate manual recovery decision.

Use staged artifacts for missing or behind skills:

```bash
TMP="$(mktemp -d "${TMPDIR:-/tmp}/skill-suitcase-codex.XXXXXX")"
skill-suitcase pack --source "$SRC" --target codex --codex-home "$HOME/.codex" --output "$TMP" --json
find "$TMP" -maxdepth 4 -type f | sort
ARTIFACT="$(find "$TMP" -name skill-suitcase-bundle.json -print -quit)"
# after approval:
skill-suitcase apply --source "$SRC" --target codex --codex-home "$HOME/.codex" --artifact "$ARTIFACT" --json
```

Artifact apply validates the stored bundle, but ordinary missing/behind writes are rebuilt from current catalog source and packed hashes gate only the dirty-behind exception.
Re-run `pack` immediately before `apply`, inspect the current `diff`, and approve the exact target override and install mode instead of treating an older artifact as byte-for-byte authorization.
Pack refuses output beneath absolute install paths declared in the manifest, but that guard does not account for CLI target overrides or expand `~`.
Keep output in a temporary directory outside the catalog and every resolved target root.

For Git-backed catalogs, staged artifacts and plan locks refuse selected source skills with untracked, non-ignored files.
Track or remove scratch files inside a selected skill before packing or applying it.
Plan-lock creation is a library API, not a CLI command; see [`docs/command-reference.md`](docs/command-reference.md#plan-lock-creation-library-api).

For Claude, use:

```bash
CLAUDE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/skill-suitcase-claude.XXXXXX")"
skill-suitcase pack --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --output "$CLAUDE_TMP" --json
CLAUDE_ARTIFACT="$(find "$CLAUDE_TMP" -name skill-suitcase-bundle.json -print -quit)"
skill-suitcase apply --source "$SRC" --target claude --claude-skills "$HOME/.claude/skills" --artifact "$CLAUDE_ARTIFACT" --json
```

For the shared agents root, use:

```bash
AGENTS_TMP="$(mktemp -d "${TMPDIR:-/tmp}/skill-suitcase-agents.XXXXXX")"
skill-suitcase pack --source "$SRC" --target agents --agents-skills "$HOME/.agents/skills" --output "$AGENTS_TMP" --json
AGENTS_ARTIFACT="$(find "$AGENTS_TMP" -name skill-suitcase-bundle.json -print -quit)"
skill-suitcase apply --source "$SRC" --target agents --agents-skills "$HOME/.agents/skills" --artifact "$AGENTS_ARTIFACT" --json
```

For Grok, use:

```bash
GROK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/skill-suitcase-grok.XXXXXX")"
skill-suitcase pack --source "$SRC" --target grok --grok-skills "$HOME/.grok/skills" --output "$GROK_TMP" --json
GROK_ARTIFACT="$(find "$GROK_TMP" -name skill-suitcase-bundle.json -print -quit)"
skill-suitcase apply --source "$SRC" --target grok --grok-skills "$HOME/.grok/skills" --artifact "$GROK_ARTIFACT" --json
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
