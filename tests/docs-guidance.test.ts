import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { test } from "node:test";

test("README stays product-forward, portable, and free of roadmap drift", async () => {
  const readme = await readFile("README.md", "utf8");
  const installHeading = readme.indexOf("## Install");
  assert.notEqual(installHeading, -1, "README should include an install section");
  const firstScreen = readme.slice(0, installHeading);

  assert.ok(firstScreen.includes("agent-first skill package manager"));
  assert.ok(firstScreen.includes("CLI is the product backbone"));
  assert.ok(firstScreen.includes("Git-backed catalog source"));
  assert.ok(firstScreen.includes("Read-only commands"));

  assert.ok(
    readme.split("\n").length < 500,
    "README should stay a concise product overview; long-form command detail belongs in docs"
  );
  assert.ok(
    readme.includes("](docs/command-reference.md)"),
    "README should route long-form command detail to the command reference"
  );
  assert.doesNotMatch(readme, /\/Users\//, "README examples must not contain maintainer-local paths");
  assert.doesNotMatch(
    readme,
    /\b(?:roadmap|first milestone|future explicit flow|current target shape)\b/i,
    "README should describe shipped behavior instead of planning milestones"
  );
});

test("release readiness records verified shipped state and uses portable paths", async () => {
  const releaseReadiness = await readFile("docs/release-readiness.md", "utf8");

  // Release Please bumps package.json before publication. Keep the published
  // version authoritative in npm/GitHub rather than duplicating a literal that
  // will become stale or blocking the release PR on a not-yet-shipped version.
  assert.ok(releaseReadiness.includes("npm view skill-suitcase version dist-tags --json"));
  assert.ok(releaseReadiness.includes("gh release list"));
  assert.ok(releaseReadiness.includes("--repo calvinnwq/skill-suitcase"));
  assert.ok(releaseReadiness.includes("--exclude-drafts"));
  assert.ok(releaseReadiness.includes("--exclude-pre-releases"));
  assert.ok(releaseReadiness.includes("does not duplicate that version as a literal"));
  assert.ok(releaseReadiness.includes("npm's `latest` tag"));
  assert.ok(releaseReadiness.includes("repository is public"));
  assert.ok(releaseReadiness.includes("npm Trusted Publishing"));
  assert.doesNotMatch(releaseReadiness, /skill-suitcase@\d+\.\d+\.\d+/);
  assert.doesNotMatch(
    releaseReadiness,
    /\/Users\//,
    "release-readiness examples must not contain maintainer-local paths"
  );
});

test("command reference matches shipped planning, diff, pack, and rollback boundaries", async () => {
  const reference = await loadNormalized("docs/command-reference.md");

  assert.ok(reference.includes("does not resolve target install paths"));
  assert.ok(reference.includes("choose install modes"));
  assert.ok(reference.includes("`create`, `update`, `unchanged`, `extra`, `missing`, or `blocked`"));
  assert.ok(reference.includes("`diff` does not run the git source-hygiene check"));
  assert.ok(reference.includes("beneath an absolute manifest-declared install root"));
  assert.ok(reference.includes("does not expand home-relative strings"));
  assert.ok(reference.includes("stored receipt version/hash is not revalidated"));
  assert.ok(reference.includes("untracked, non-ignored source files"));
  assert.ok(reference.includes("git-ignored regular files may still be materialized"));
  assert.ok(reference.includes("`unknown`: status could not be proven"));
  assert.ok(reference.includes("only the receiptless mismatched-directory case routes to `reconcile`"));
  assert.ok(reference.includes("skills.sh declarations pin the installer package version but not the referenced repository content revision"));
  assert.ok(reference.includes("current rollback command does not restore promotions"));
  assert.ok(reference.includes("`source_untracked_files`"));
  assert.ok(reference.includes("reported by pack and apply rather than `diff`"));
  assert.ok(reference.includes("plan-lock creation enforces the same gate through a thrown error"));
  assert.ok(reference.includes("`plan_lock_<reason>`"));
  assert.ok(reference.includes("including structured `ok: false` results"));
  assert.ok(reference.includes("parser/usage failures"));
  assert.ok(reference.includes("`version`: the installed receipt version differs"));
  assert.ok(reference.includes("those seven values are the complete status enum"));
  assert.ok(reference.includes("`statuscount: 0` and no status entries"));
  assert.ok(reference.includes("fallback inventory without a catalog assignment"));
  assert.ok(reference.includes("custom provider path tied to a catalog assignment may produce ordinary status entries"));
  assert.ok(reference.includes("per-path existence, and safety classification"));
  assert.ok(reference.includes("### plan-lock creation (library api)"));
  assert.ok(reference.includes("there is no cli command that creates a plan lock"));
  assert.ok(reference.includes("buildplanlock"));
  assert.ok(reference.includes("approval inputs do not currently provide identical guarantees"));
  assert.ok(reference.includes("artifact `filehashes` are enforced only for the dirty-behind"));
  assert.ok(reference.includes("ordinary missing/behind writes are rebuilt from current catalog source"));
  assert.ok(reference.includes("do not use an older artifact as byte-for-byte authorization"));

  assert.ok(!reference.includes("`source_untracked_path`"));
  assert.ok(!reference.includes("`stale_plan_lock`"));
  assert.ok(!reference.includes("source of each resolved path"));
});

/**
 * Operator guidance for the dirty-repair flow (NGX-487) must live in the docs an
 * operator actually reads: the README reference, the agent INSTALL runbook, and
 * the packaged operator skill. These tests assert the shared rule -- `dirty`
 * means stop and inspect, then run `repair --dry-run`/`--apply` for a
 * receipt-owned skill only after explicit approval -- is documented in all three.
 */

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").toLowerCase();
}

async function loadNormalized(file: string): Promise<string> {
  return normalize(await readFile(file, "utf8"));
}

const PRODUCT_VISION_PHRASES = [
  "agent-first skill package manager",
  "`skill-suitcase` cli is the product backbone",
  "source-of-truth warehouse",
  "claude, codex, openclaw, hermes",
  "`npx skills`",
  "upstream source refresh",
  "openclaw is a first-class integration",
  "not the whole product boundary"
];

test("VISION documents the Skill Suitcase product north star", async () => {
  const normalized = await loadNormalized("VISION.md");
  for (const phrase of PRODUCT_VISION_PHRASES) {
    assert.ok(normalized.includes(phrase), `VISION.md should document the product vision phrase: ${phrase}`);
  }
});

test("README and architecture point to VISION for product direction", async () => {
  const readme = await readFile("README.md", "utf8");
  const architecture = await readFile("ARCHITECTURE.md", "utf8");
  assert.ok(readme.includes("](VISION.md)"), "README should link to VISION.md");
  assert.ok(architecture.includes("](VISION.md)"), "ARCHITECTURE.md should link to VISION.md");
});

test("SPEC defines the shipped contract without taking over adjacent documentation roles", async () => {
  const spec = await readFile("SPEC.md", "utf8");
  const normalized = normalize(spec);

  for (const heading of [
    "## catalog",
    "## target adapters and resolution",
    "## read-only commands",
    "## staging and approval inputs",
    "## live mutation",
    "## receipts",
    "## rollback and recovery",
    "## upstream refresh",
    "## output contract",
    "## non-goals"
  ]) {
    assert.ok(normalized.includes(heading), `SPEC.md should include ${heading}`);
  }

  assert.ok(spec.includes("](VISION.md)"), "SPEC.md should route product direction to VISION.md");
  assert.ok(
    spec.includes("](https://github.com/calvinnwq/skill-suitcase/blob/main/ARCHITECTURE.md)"),
    "SPEC.md should route implementation structure to ARCHITECTURE.md"
  );
  assert.ok(spec.includes("](docs/command-reference.md)"), "SPEC.md should route detailed usage to the command reference");
  assert.ok(
    spec.includes("](https://github.com/calvinnwq/skill-suitcase/blob/main/tests/apply.test.ts)"),
    "SPEC.md should link contract claims to tests"
  );
  assert.ok(spec.includes("planning and target materialization also accept a non-Git catalog directory"));
  assert.ok(normalized.includes("copy-mode materialization"));
  assert.ok(normalized.includes("symlink_source_policy_exclude"));
  assert.ok(normalized.includes("patterns have no current matches"));
  assert.ok(normalized.includes("target-aware materialization and mutation flows"));
  assert.ok(normalized.includes("path-driven `promote` and receipt-driven `rollback` do not resolve target adapters"));
  assert.ok(!normalized.includes("materializing or mutating commands return `read_only_target`"));
  assert.ok(spec.includes("Neither approval input binds the resolved live install root"));
  assert.ok(spec.includes("copy-versus-symlink mode"));
  assert.ok(spec.includes("the CLI does not bind that review to the later mutation"));
  assert.ok(spec.includes("](docs/command-reference.md#explicit-mutation-commands)"));
  assert.ok(!spec.includes("](docs/command-reference.md#mutating-commands)"));
  assert.doesNotMatch(spec, /\/Users\//, "SPEC.md examples must not contain maintainer-local paths");
  assert.doesNotMatch(spec, /\b(?:roadmap|planned milestone|future command)\b/i, "SPEC.md should describe shipped behavior only");

  const vision = await readFile("VISION.md", "utf8");
  const readme = await readFile("README.md", "utf8");
  assert.ok(vision.includes("`SPEC.md` defines the normative current-state product contract"));
  assert.ok(readme.includes("](SPEC.md)"), "README.md should link to the current contract");
});

test("SPEC relative links resolve within the public package", async () => {
  const spec = await readFile("SPEC.md", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { files: string[] };
  const relativeTargets = [...spec.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .flatMap((match) => match[1] === undefined ? [] : [match[1].split("#", 1)[0] ?? ""])
    .filter((target) => target !== "" && !target.startsWith("#") && !/^[a-z][a-z\d+.-]*:/i.test(target))
    .map((target) => posix.normalize(target));

  for (const target of relativeTargets) {
    assert.ok(packageJson.files.includes(target), `Packaged SPEC.md contains a relative link to omitted file: ${target}`);
  }
});

/**
 * The shared dirty-repair guidance every operator-facing doc must carry. Each
 * entry is matched against whitespace-normalized, lowercased file content so
 * line wrapping in prose does not make the assertions brittle.
 */
const DIRTY_REPAIR_PHRASES = [
  "dirty",
  "receipt-owned",
  "`repair --dry-run`",
  "`repair --apply`",
  "approval"
];

function assertDocumentsDirtyRepair(label: string, normalized: string): void {
  for (const phrase of DIRTY_REPAIR_PHRASES) {
    assert.ok(
      normalized.includes(phrase),
      `${label} should document the dirty-repair flow phrase: ${phrase}`
    );
  }
}

test("README documents the dirty repair flow and a repair command section", async () => {
  const readme = await readFile("README.md", "utf8");
  assertDocumentsDirtyRepair("README.md", normalize(readme));

  // A dedicated repair reference section, modeled on the other command sections.
  assert.match(readme, /## `repair` Output/);

  // The dry-run report contents called out by the acceptance criteria.
  const normalized = normalize(readme);
  assert.ok(normalized.includes("receipt hash"), "README repair section should describe the receipt hash");
  assert.ok(normalized.includes("catalog hash"), "README repair section should describe the catalog hash");
});

test("INSTALL runbook documents the dirty repair flow after approval", async () => {
  assertDocumentsDirtyRepair("INSTALL.md", await loadNormalized("INSTALL.md"));
});

test("operator skill routes receipt-owned dirty skills to repair after approval", async () => {
  const normalized = await loadNormalized("skills/skill-suitcase/SKILL.md");
  assertDocumentsDirtyRepair("operator skill", normalized);

  // Dirty still triggers the stop-and-report reflex before any repair.
  assert.ok(normalized.includes("stop"), "operator skill should keep the stop-and-report reflex for dirty targets");
});

/**
 * Operator guidance for the import-target flow (NGX-493) must live in the same
 * operator-facing docs as the repair guidance: the README reference, the agent
 * INSTALL runbook, and the packaged operator skill. import-target is the
 * source-of-truth inverse of repair -- it pulls *intentional* local edits to an
 * existing *catalog-owned* skill back into the catalog through review instead of
 * discarding them. These tests assert that the five-way decision tree
 * (`track` / `reconcile` / `repair` / `promote` / `import-target`) and the
 * drift-audit / heartbeat rule -- report drift, but import a receipt-owned skill
 * into the catalog only after explicit approval -- are documented everywhere an
 * operator reads.
 */

/**
 * The shared import-target guidance every operator-facing doc must carry, matched
 * against whitespace-normalized, lowercased content like the dirty-repair phrases.
 */
const IMPORT_TARGET_PHRASES = [
  "import-target",
  "catalog-owned",
  "intentional",
  "`import-target --dry-run`",
  "`import-target --apply`",
  "approval"
];

function assertDocumentsImportTarget(label: string, normalized: string): void {
  for (const phrase of IMPORT_TARGET_PHRASES) {
    assert.ok(
      normalized.includes(phrase),
      `${label} should document the import-target flow phrase: ${phrase}`
    );
  }
}

/**
 * The five-way decision tree the NGX-493 acceptance criteria require operators to
 * be able to read. Each command is matched in backticked form so a doc has to
 * actually contrast the commands, not merely mention the words in prose.
 */
const DECISION_TREE_COMMANDS = ["`track`", "`reconcile`", "`repair`", "`promote`", "`import-target`"];

function assertDocumentsDecisionTree(label: string, normalized: string): void {
  for (const command of DECISION_TREE_COMMANDS) {
    assert.ok(
      normalized.includes(command),
      `${label} should contrast the ${command} command in the decision tree`
    );
  }
}

/**
 * The lightweight drift audit/heartbeat guidance: report target drift, but
 * require explicit approval before importing local edits into the catalog.
 */
const DRIFT_AUDIT_PHRASES = ["drift", "heartbeat", "explicit approval"];

function assertDocumentsDriftAudit(label: string, normalized: string): void {
  for (const phrase of DRIFT_AUDIT_PHRASES) {
    assert.ok(
      normalized.includes(phrase),
      `${label} should document the drift audit/heartbeat guidance phrase: ${phrase}`
    );
  }
}

test("README documents the import-target flow and an import-target command section", async () => {
  const readme = await readFile("README.md", "utf8");
  const normalized = normalize(readme);
  assertDocumentsImportTarget("README.md", normalized);
  assertDocumentsDecisionTree("README.md", normalized);
  assertDocumentsDriftAudit("README.md", normalized);

  // A dedicated import-target reference section, modeled on the other command sections.
  assert.match(readme, /## `import-target` Output/);

  // The dry-run report contents called out by the acceptance criteria.
  assert.ok(normalized.includes("receipt hash"), "README import-target section should describe the receipt hash");
  assert.ok(normalized.includes("catalog hash"), "README import-target section should describe the catalog hash");
  assert.ok(normalized.includes("target hash"), "README import-target section should describe the live target hash");
  assert.ok(
    normalized.includes("planned repo writes"),
    "README import-target section should describe the planned repo writes"
  );
});

test("INSTALL runbook documents the import-target decision tree and drift audit after approval", async () => {
  const normalized = await loadNormalized("INSTALL.md");
  assertDocumentsImportTarget("INSTALL.md", normalized);
  assertDocumentsDecisionTree("INSTALL.md", normalized);
  assertDocumentsDriftAudit("INSTALL.md", normalized);
});

test("operator skill routes catalog-owned local edits to import-target after approval", async () => {
  const normalized = await loadNormalized("skills/skill-suitcase/SKILL.md");
  assertDocumentsImportTarget("operator skill", normalized);
  assertDocumentsDecisionTree("operator skill", normalized);
  assertDocumentsDriftAudit("operator skill", normalized);

  // Drift still triggers the stop-and-report reflex before any import.
  assert.ok(
    normalized.includes("stop"),
    "operator skill should keep the stop-and-report reflex for drifted targets"
  );
});

/**
 * NGX-513 splits `skills.sh` into two separate concepts: a source-only upstream
 * refresh lane that may update the catalog after review, and deferred live
 * installer delegation that must not write directly into agent homes in v1.
 */
const UPSTREAM_SOURCE_REFRESH_PHRASES = [
  "source refresh",
  "catalog source",
  "isolated temp",
  ".skill-suitcase/upstream-lock.json",
  "upstream check",
  "upstream fetch",
  "upstream import",
  "new-machine setup",
  "ordinary repository diffs",
  "do not auto-commit",
  "live agent homes"
];

const UPSTREAM_LIFECYCLE_PHRASES = [
  "upstream unchanged",
  "upstream changed",
  "local catalog edit",
  "upstream removed or renamed",
  "target drift",
  "catalog-hash drift",
  "fork/adopt",
  "trust boundary",
  "exact pinned",
  "write receipts",
  "prove rollback"
];

const UPSTREAM_LINEAGE_PHRASES = [
  "lineage",
  "upstream package/version",
  "upstream repo/skill",
  "imported hash",
  "current catalog hash",
  "target status",
  "receipt hash",
  "receipt commit"
];

function assertDocumentsUpstreamSourceRefresh(label: string, normalized: string): void {
  for (const phrase of UPSTREAM_SOURCE_REFRESH_PHRASES) {
    assert.ok(
      normalized.includes(phrase),
      `${label} should document the upstream source-refresh phrase: ${phrase}`
    );
  }
}

function assertDocumentsUpstreamLifecycle(label: string, normalized: string): void {
  for (const phrase of UPSTREAM_LIFECYCLE_PHRASES) {
    assert.ok(
      normalized.includes(phrase),
      `${label} should document the upstream lifecycle phrase: ${phrase}`
    );
  }
}

function assertDocumentsUpstreamLineage(label: string, normalized: string): void {
  for (const phrase of UPSTREAM_LINEAGE_PHRASES) {
    assert.ok(
      normalized.includes(phrase),
      `${label} should document the upstream lineage phrase: ${phrase}`
    );
  }
}

test("architecture documents source-only upstream refresh as separate from live installer delegation", async () => {
  const normalized = await loadNormalized("ARCHITECTURE.md");
  assertDocumentsUpstreamSourceRefresh("ARCHITECTURE.md", normalized);
  assert.ok(
    normalized.includes("must not write directly into codex, claude, openclaw"),
    "ARCHITECTURE.md should forbid direct live target writes in the source-refresh model"
  );
});

test("skills.sh delegation spike documents catalog-only source refresh lane", async () => {
  const normalized = await loadNormalized("docs/skills-sh-delegation.md");
  assertDocumentsUpstreamSourceRefresh("docs/skills-sh-delegation.md", normalized);
  assert.ok(
    normalized.includes("upstream check -> sandboxed fetch/diff -> catalog import -> git review -> pack/apply"),
    "skills.sh delegation spike should document the intended source-refresh flow"
  );
});

test("operator-facing docs define the upstream-managed lifecycle policy", async () => {
  for (const file of [
    "ARCHITECTURE.md",
    "README.md",
    "docs/skills-sh-delegation.md",
    "skills/skill-suitcase/SKILL.md"
  ]) {
    assertDocumentsUpstreamLifecycle(file, await loadNormalized(file));
  }
});

test("operator-facing docs describe upstream lineage reporting", async () => {
  for (const file of [
    "ARCHITECTURE.md",
    "README.md",
    "skills/skill-suitcase/SKILL.md"
  ]) {
    assertDocumentsUpstreamLineage(file, await loadNormalized(file));
  }
});

test("operator-facing docs describe provider-managed read-only boundaries", async () => {
  const architecture = await loadNormalized("ARCHITECTURE.md");
  assert.ok(architecture.includes("provider-backed adapter kinds"), "ARCHITECTURE.md should name provider-backed adapter kinds");
  assert.ok(architecture.includes("custom `assignmentpaths` entry"), "ARCHITECTURE.md should cover custom assignmentPaths entries");
  assert.ok(architecture.includes("must refuse"), "ARCHITECTURE.md should require mutation refusal");

  const readme = await loadNormalized("README.md");
  assert.ok(readme.includes("read-only even when the catalog declares a custom `assignmentpaths` entry"), "README should document custom provider paths as read-only");
  assert.ok(readme.includes("read_only_target"), "README should document the provider pack refusal code");

  const skill = await loadNormalized("skills/skill-suitcase/SKILL.md");
  assert.ok(skill.includes("provider-managed skills"), "operator skill should keep a provider-managed row");
  assert.ok(skill.includes("custom manifest assignment paths"), "operator skill should call out custom manifest provider paths");
});

test("operator-facing docs describe manifest logical groups as reporting metadata", async () => {
  const architecture = await loadNormalized("ARCHITECTURE.md");
  assert.ok(architecture.includes("manifest-owned logical groups"), "ARCHITECTURE.md should name manifest-owned logical groups");
  assert.ok(architecture.includes("reporting metadata"), "ARCHITECTURE.md should keep groups reporting-only");
  assert.ok(architecture.includes("must not alter planning, packing, installation"), "ARCHITECTURE.md should prevent implicit install semantics");

  const readme = await loadNormalized("README.md");
  assert.ok(readme.includes("## manifest logical groups"), "README should document manifest logical groups");
  assert.ok(readme.includes("groups are catalog metadata only"), "README should keep groups catalog-only");
  assert.ok(readme.includes("do not change planning, packing, installation"), "README should prevent implicit behavior changes");

  const skill = await loadNormalized("skills/skill-suitcase/SKILL.md");
  assert.ok(skill.includes("manifest `groups`"), "operator skill should mention manifest groups");
  assert.ok(skill.includes("do not change install or receipt semantics"), "operator skill should keep groups reporting-only");
});

test("operator-facing docs describe manifest source policy materialization boundaries", async () => {
  for (const file of [
    "ARCHITECTURE.md",
    "README.md",
    "docs/install-smoke.md",
    "docs/portability-matrix.md",
    "skills/skill-suitcase/SKILL.md"
  ]) {
    const normalized = await loadNormalized(file);
    assert.ok(normalized.includes("sourcepolicy"), `${file} should document manifest sourcePolicy`);
    assert.ok(normalized.includes("exclude"), `${file} should document sourcePolicy exclude patterns`);
    assert.ok(normalized.includes("deny"), `${file} should document sourcePolicy deny patterns`);
    assert.ok(normalized.includes("generated") || normalized.includes("cache"), `${file} should mention generated/cache paths`);
    assert.ok(normalized.includes("source_denied_path") || normalized.includes("diff_source_denied_path"), `${file} should document denied-path error codes`);
  }
});

/**
 * NGX-621 public onboarding docs: the getting-started walkthrough and the
 * INSTALL runbook are packaged, public-facing documents. They must cover the
 * full first-run flow (npm install, agent setup, catalog setup, local target
 * overrides, read-only audit, pack/apply staging, and safe rollback) using
 * portable paths and generic repo names only.
 */

test("getting-started guide covers the public onboarding flow with portable examples", async () => {
  const guide = await readFile("docs/getting-started.md", "utf8");
  const normalized = normalize(guide);

  assert.ok(guide.includes("npm install --global skill-suitcase"), "guide should install the published CLI");
  for (const phrase of [
    "operator skill",
    "skill-suitcase.yaml",
    "`--claude-skills`",
    "`--codex-home`",
    "read-only",
    "`pack`",
    "`apply`",
    "`rollback`",
    "receipt",
    "receipts created by `apply`, `reconcile`, or `repair`",
    "does not resolve target install paths, so it needs no override flags",
    "does not restore promotions"
  ]) {
    assert.ok(normalized.includes(phrase.toLowerCase()), `getting-started guide should cover: ${phrase}`);
  }

  for (const heading of [
    "## 1. install the cli",
    "## 2. install the operator skill into your agent",
    "## 3. set up a skills catalog",
    "## 4. point targets at your machine with local overrides",
    "## 5. audit read-only first",
    "## 6. stage with `pack`, install with `apply`",
    "## 7. roll back safely"
  ]) {
    assert.ok(normalized.includes(heading), `getting-started guide should keep the walkthrough section: ${heading}`);
  }

  assert.doesNotMatch(guide, /\/Users\//, "getting-started examples must not contain maintainer-local paths");
  assert.doesNotMatch(guide, /calvinnwq\/skills\b/, "getting-started must not reference a private catalog repository");

  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { files: string[] };
  assert.ok(
    packageJson.files.includes("docs/getting-started.md"),
    "getting-started guide must ship in the npm package"
  );

  const readme = await readFile("README.md", "utf8");
  assert.ok(
    readme.includes("](docs/getting-started.md)"),
    "README should route new users to the getting-started guide"
  );

  const install = await readFile("INSTALL.md", "utf8");
  assert.ok(
    install.includes("](docs/getting-started.md)"),
    "INSTALL should route human first-run setup to the getting-started guide"
  );
});

test("public install runbook uses portable paths and generic repo names", async () => {
  const install = await readFile("INSTALL.md", "utf8");

  assert.doesNotMatch(install, /\/Users\//, "INSTALL examples must not contain maintainer-local paths");
  assert.doesNotMatch(install, /calvinnwq\/skills\b/, "INSTALL must not reference a private catalog repository");
  assert.doesNotMatch(install, /git@github\.com:/, "INSTALL should clone public repositories over https");
  assert.doesNotMatch(
    install,
    /--skill (?:office-hours|improve|gnhf-postflight)\b/,
    "INSTALL examples must use generic skill names"
  );
  assert.ok(
    install.includes("<your-catalog-remote>"),
    "INSTALL catalog setup should use a generic catalog remote placeholder"
  );
});

test("README points new-machine setup at Suitcase-managed catalog installs", async () => {
  const normalized = await loadNormalized("README.md");
  assert.ok(normalized.includes("catalog-only upstream lane"), "README should mention the catalog-only upstream lane");
  assert.ok(
    normalized.includes("new-machine setup installs from the skills repo through suitcase"),
    "README should keep new-machine setup on the skills repo plus Suitcase path"
  );
});
