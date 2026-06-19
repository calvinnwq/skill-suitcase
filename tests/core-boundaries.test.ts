import assert from "node:assert/strict";
import { test } from "node:test";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test("durable CLI behavior has core entrypoints", async () => {
  const expected = [
    "src/core/planning/index.ts",
    "src/core/planning/plan-lock.ts",
    "src/core/diffing/index.ts",
    "src/core/packing/index.ts",
    "src/core/importing/index.ts",
    "src/core/apply/index.ts",
    "src/core/receipts/index.ts",
    "src/core/status/index.ts",
    "src/core/reconcile/index.ts",
    "src/core/repair/index.ts",
    "src/core/catalog/index.ts",
    "src/core/catalog/targets.ts",
    "src/core/catalog/suitcase-manifest.ts",
    "src/core/validation/index.ts",
    "src/config/defaults.ts",
    "src/adapters/filesystem.ts"
  ];

  for (const file of expected) {
    assert.equal(await pathExists(file), true, `${file} should exist`);
  }
});

test("legacy root domain entrypoints remain import-compatible", async () => {
  const rootPlanner = await import("../src/planner.js");
  const corePlanner = await import("../src/core/planning/index.js");
  const rootReceipt = await import("../src/receipt.js");
  const coreReceipt = await import("../src/core/receipts/index.js");
  const rootReconcile = await import("../src/reconcile.js");
  const coreReconcile = await import("../src/core/reconcile/index.js");
  const rootRepair = await import("../src/repair.js");
  const coreRepair = await import("../src/core/repair/index.js");

  assert.equal(rootPlanner.plan, corePlanner.plan);
  assert.equal(rootReceipt.RECEIPT_FILE, coreReceipt.RECEIPT_FILE);
  assert.equal(rootReconcile.reconcile, coreReconcile.reconcile);
  assert.equal(rootRepair.repair, coreRepair.repair);
});
