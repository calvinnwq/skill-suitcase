# Portable Sample Catalog

This public-safe catalog is deliberately small. Its manifest uses a visible
placeholder target, so commands cannot accidentally select a contributor's
agent home. Override that placeholder with a disposable directory whenever a
command needs a target.

From a Skill Suitcase repository checkout, first complete the dependency setup
in [`DEVELOPING.md`](../../DEVELOPING.md#set-up-the-repository), then build the
CLI:

```bash
pnpm run build
CLI="$PWD/dist/src/cli.js"
SRC="$PWD/examples/sample-catalog"
```

From a global npm installation, use the packaged CLI and sample instead:

```bash
CLI="$(command -v skill-suitcase)"
SRC="$(npm root --global)/skill-suitcase/examples/sample-catalog"
```

After either setup, run the walkthrough:

```bash
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/skill-suitcase-demo.XXXXXX")" || exit 1
test -n "$SANDBOX" || exit 1
TARGET="$SANDBOX/agent-skills"
PACK="$SANDBOX/pack"
mkdir -p "$TARGET"

"$CLI" import --source "$SRC" --json
"$CLI" validate --source "$SRC" --strict --json
"$CLI" upstream check --source "$SRC" --json
"$CLI" targets --source "$SRC" --agents-skills "$TARGET" --json
"$CLI" plan --source "$SRC" --target agents --json
"$CLI" status --source "$SRC" --target agents --agents-skills "$TARGET" --json
"$CLI" diff --source "$SRC" --target agents --agents-skills "$TARGET" --json
"$CLI" pack --source "$SRC" --target agents --agents-skills "$TARGET" --output "$PACK" --json
ARTIFACT="$(find "$PACK/.skill-suitcase/artifacts" -mindepth 1 -maxdepth 1 -type d -print -quit)"
```

The commands above only read the catalog and target or write the explicit pack
directory. To test mutation, apply the staged artifact only to the disposable
target:

```bash
"$CLI" apply --source "$SRC" --target agents --agents-skills "$TARGET" --artifact "$ARTIFACT" --json
printf '\nLocal demo edit.\n' >> "$TARGET/hello-suitcase/references/greeting.md"
"$CLI" repair --source "$SRC" --target agents --agents-skills "$TARGET" --skill hello-suitcase --apply --json
"$CLI" rollback --receipt "$TARGET/.skill-suitcase-receipt.json" --json
rm -rf "$SANDBOX"
```

`upstream check` validates the empty upstream policy document and reports zero
declarations without fetching or writing.
The sample skill has no executable third-party lineage, so `upstream fetch` and
`upstream import` are intentionally outside this offline demo.
