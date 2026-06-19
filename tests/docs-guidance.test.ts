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
