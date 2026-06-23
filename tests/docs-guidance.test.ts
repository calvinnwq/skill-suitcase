import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

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
  "new-machine setup",
  "ordinary repository diffs",
  "do not auto-commit",
  "live agent homes"
];

function assertDocumentsUpstreamSourceRefresh(label: string, normalized: string): void {
  for (const phrase of UPSTREAM_SOURCE_REFRESH_PHRASES) {
    assert.ok(
      normalized.includes(phrase),
      `${label} should document the upstream source-refresh phrase: ${phrase}`
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

test("README points new-machine setup at Suitcase-managed catalog installs", async () => {
  const normalized = await loadNormalized("README.md");
  assert.ok(normalized.includes("catalog-only upstream lane"), "README should mention the catalog-only upstream lane");
  assert.ok(
    normalized.includes("new-machine setup installs from the skills repo through suitcase"),
    "README should keep new-machine setup on the skills repo plus Suitcase path"
  );
});
