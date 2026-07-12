# Portable Sample Catalog

This public-safe catalog is deliberately small. Its manifest uses a visible
placeholder target, so commands cannot accidentally select a contributor's
agent home. Override that placeholder with a disposable directory whenever a
command needs a target.

From a Skill Suitcase repository checkout, first complete the dependency setup
in [`DEVELOPING.md`](../../DEVELOPING.md#set-up-the-repository), then build the
CLI before running the walkthrough:

```bash
pnpm run build

SRC="$PWD/examples/sample-catalog"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/skill-suitcase-demo.XXXXXX")"
TARGET="$SANDBOX/agent-skills"
PACK="$SANDBOX/pack"
mkdir -p "$TARGET"

node dist/src/cli.js validate --source "$SRC" --json
node dist/src/cli.js upstream check --source "$SRC" --json
node dist/src/cli.js plan --source "$SRC" --target agents --json
node dist/src/cli.js status --source "$SRC" --target agents --agents-skills "$TARGET" --json
node dist/src/cli.js diff --source "$SRC" --target agents --agents-skills "$TARGET" --json
node dist/src/cli.js pack --source "$SRC" --target agents --agents-skills "$TARGET" --output "$PACK" --json
ARTIFACT="$(find "$PACK/.skill-suitcase/artifacts" -mindepth 1 -maxdepth 1 -type d -print -quit)"
```

The commands above only read the catalog and target or write the explicit pack
directory. To test mutation, apply the staged artifact only to the disposable
target:

```bash
node dist/src/cli.js apply --source "$SRC" --target agents --agents-skills "$TARGET" --artifact "$ARTIFACT" --json
printf '\nLocal demo edit.\n' >> "$TARGET/hello-suitcase/references/greeting.md"
node dist/src/cli.js repair --source "$SRC" --target agents --agents-skills "$TARGET" --skill hello-suitcase --apply --json
node dist/src/cli.js rollback --receipt "$TARGET/.skill-suitcase-receipt.json" --json
rm -rf "$SANDBOX"
```

`upstream check` validates the empty upstream policy document and reports zero
declarations without fetching or writing.
The sample skill has no executable third-party lineage, so `upstream fetch` and
`upstream import` are intentionally outside this offline demo.
