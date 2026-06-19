import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RECEIPT_FILE, type Receipt, type ReceiptInstallRecord } from "../src/receipt.js";
import { repair } from "../src/repair.js";
import { rollback } from "../src/rollback.js";
import { status } from "../src/status.js";
import { track } from "../src/track.js";

function singleRecord(receipt: Receipt, skill: string): ReceiptInstallRecord {
  const value = receipt.installs?.[skill];
  if (value === undefined) {
    throw new Error(`Missing receipt for ${skill}.`);
  }
  if (Array.isArray(value)) {
    assert.equal(value.length, 1);
    const [first] = value;
    assert.ok(first !== undefined);
    return first;
  }
  return value;
}

const CATALOG_RUNTIME = "console.log(\"catalog\");\n";
const SKILL_MD = "---\nname: skill-cleaner\nversion: 2026.06.17\n---\n# Skill Cleaner\n";

type RepairFixture = {
  sourceRoot: string;
  targetRoot: string;
  sourceSkill: string;
  targetSkill: string;
};

async function writeManifest(sourceRoot: string, targetRoot: string): Promise<void> {
  await writeFile(path.join(sourceRoot, "skill-suitcase.yaml"), `suitcases:
  core:
    skills:
      - skill-cleaner

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${targetRoot}

compatibility:
  skill-cleaner:
    agents:
      - openclaw
    variant: canonical
`);
}

async function createCatalog(t: { after(fn: () => Promise<void> | void): void }): Promise<RepairFixture> {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-repair-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-repair-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "skill-cleaner");
  const targetSkill = path.join(targetRoot, "skill-cleaner");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), SKILL_MD);
  await writeFile(path.join(sourceSkill, "runtime.js"), CATALOG_RUNTIME);
  await writeManifest(sourceRoot, targetRoot);

  return { sourceRoot, targetRoot, sourceSkill, targetSkill };
}

/**
 * Builds a receipt-owned, copy-installed skill by adopting a target that
 * matches the catalog with `track`. The returned fixture is `current`; tests
 * mutate the live target to reach the state they exercise.
 */
async function createTrackedFixture(t: { after(fn: () => Promise<void> | void): void }): Promise<RepairFixture> {
  const fixture = await createCatalog(t);
  await mkdir(fixture.targetSkill, { recursive: true });
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), SKILL_MD);
  await writeFile(path.join(fixture.targetSkill, "runtime.js"), CATALOG_RUNTIME);

  const tracked = await track({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"]
  });
  assert.equal(tracked.ok, true, "fixture setup: track should adopt the matching target");

  return fixture;
}

async function dirtyTheTarget(fixture: RepairFixture): Promise<void> {
  await writeFile(path.join(fixture.targetSkill, "runtime.js"), "console.log(\"locally edited\");\n");
  await writeFile(path.join(fixture.targetSkill, "extra.js"), "console.log(\"local extra\");\n");
}

test("repair dry-run plans a dirty receipt-owned skill without mutating files", async (t) => {
  const fixture = await createTrackedFixture(t);
  await dirtyTheTarget(fixture);

  const before = await status({ source: fixture.sourceRoot, target: "openclaw" });
  assert.equal(before.summary.dirty, 1, "precondition: target should be dirty");

  const result = await repair({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.selected.skills, ["skill-cleaner"]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.skill), ["skill-cleaner"]);

  const candidate = result.candidates[0];
  assert.ok(candidate !== undefined);
  assert.equal(candidate.status, "dirty");
  assert.equal(candidate.targetPath, fixture.targetSkill);
  assert.equal(candidate.finalAction, "replace-target-from-catalog");
  assert.equal(typeof candidate.receiptHash, "string");
  assert.equal(typeof candidate.catalogHash, "string");
  assert.equal(candidate.changes.update, 1);
  assert.equal(candidate.changes.extra, 1);
  assert.equal(
    candidate.backup.backupPathTemplate,
    path.join(fixture.targetRoot, ".skill-cleaner.suitcase-pre-repair-<timestamp>")
  );

  // Read-only: live files, receipt, and backups are untouched.
  assert.equal(await readFile(path.join(fixture.targetSkill, "runtime.js"), "utf8"), "console.log(\"locally edited\");\n");
  assert.equal(await readFile(path.join(fixture.targetSkill, "extra.js"), "utf8"), "console.log(\"local extra\");\n");
  assert.equal(result.repaired.skills.length, 0);
  assert.equal(result.repaired.backups.length, 0);
  assert.equal(result.receiptPath, null);
});

test("repair refuses a current receipt-owned skill as a no-op without mutating", async (t) => {
  const fixture = await createTrackedFixture(t);

  const result = await repair({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.errors.some((error) => error.code === "already_current" && error.skill === "skill-cleaner"), true);
  assert.equal(await readFile(path.join(fixture.targetSkill, "runtime.js"), "utf8"), CATALOG_RUNTIME);
});

test("repair refuses an unknown target and routes it to track or reconcile", async (t) => {
  const fixture = await createCatalog(t);
  await mkdir(fixture.targetSkill, { recursive: true });
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), SKILL_MD);
  await writeFile(path.join(fixture.targetSkill, "runtime.js"), "console.log(\"no receipt\");\n");

  const result = await repair({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 0);
  assert.equal(
    result.errors.some((error) => error.code === "route_to_track_or_reconcile" && error.skill === "skill-cleaner"),
    true
  );
  await assert.rejects(readFile(path.join(fixture.targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("repair refuses a missing target and routes it to pack and apply", async (t) => {
  const fixture = await createCatalog(t);

  const result = await repair({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 0);
  assert.equal(
    result.errors.some((error) => error.code === "route_to_pack_apply" && error.skill === "skill-cleaner"),
    true
  );
});

test("repair refuses a behind target and routes it to pack and apply", async (t) => {
  const fixture = await createTrackedFixture(t);
  // Move the catalog ahead so the tracked target is behind (content hash drift),
  // while the live target still matches its receipt.
  await writeFile(path.join(fixture.sourceSkill, "runtime.js"), "console.log(\"catalog moved ahead\");\n");

  const before = await status({ source: fixture.sourceRoot, target: "openclaw" });
  assert.equal(before.summary.behind, 1, "precondition: target should be behind");

  const result = await repair({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 0);
  assert.equal(
    result.errors.some((error) => error.code === "route_to_pack_apply" && error.skill === "skill-cleaner"),
    true
  );
});

test("repair refuses read-only provider targets without touching the filesystem", async (t) => {
  const fixture = await createCatalog(t);
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-repair-provider-home-"));
  t.after(() => rm(fakeHome, { recursive: true, force: true }));

  const result = await repair({
    source: fixture.sourceRoot,
    target: "opencode",
    skills: ["skill-cleaner"],
    targetOverrides: { home: fakeHome },
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "read_only_target"), true);
  await assert.rejects(() => stat(path.join(fakeHome, ".config", "opencode", "skills")), /ENOENT/);
});

test("repair requires at least one explicitly selected skill", async (t) => {
  const fixture = await createTrackedFixture(t);

  const result = await repair({
    source: fixture.sourceRoot,
    target: "openclaw",
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "invalid_skill_filter"), true);
});

test("repair requires exactly one of dry-run or apply", async (t) => {
  const fixture = await createTrackedFixture(t);
  await dirtyTheTarget(fixture);

  const neither = await repair({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"]
  });
  assert.equal(neither.ok, false);
  assert.equal(neither.errors.some((error) => error.code === "invalid_repair_mode"), true);

  const both = await repair({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true,
    apply: true
  });
  assert.equal(both.ok, false);
  assert.equal(both.errors.some((error) => error.code === "invalid_repair_mode"), true);

  // Neither invalid mode mutated the dirty target.
  assert.equal(await readFile(path.join(fixture.targetSkill, "runtime.js"), "utf8"), "console.log(\"locally edited\");\n");
});

test("repair apply replaces a dirty target from catalog, records rollback metadata, and verifies status current", async (t) => {
  const fixture = await createTrackedFixture(t);
  await dirtyTheTarget(fixture);

  const result = await repair({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    apply: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.readOnly, false);
  assert.deepEqual(result.repaired.skills, ["skill-cleaner"]);
  assert.equal(result.repaired.files, 2);

  // Live target now matches the catalog: edited file reset, extra file removed.
  assert.equal(await readFile(path.join(fixture.targetSkill, "runtime.js"), "utf8"), CATALOG_RUNTIME);
  await assert.rejects(readFile(path.join(fixture.targetSkill, "extra.js"), "utf8"), /ENOENT/);

  const receipt = JSON.parse(await readFile(path.join(fixture.targetRoot, RECEIPT_FILE), "utf8")) as Receipt;
  const record = singleRecord(receipt, "skill-cleaner");
  assert.equal(record.mode, "repair");
  assert.equal(record.sourcePath, fixture.sourceSkill);
  assert.equal(record.targetPath, fixture.targetSkill);
  assert.equal(typeof record.sourceHash, "string");
  assert.equal(record.priorState?.status, "dirty");
  assert.equal(record.rollback?.schema, "calvinnwq.skills.rollback.v0");
  assert.equal(record.rollback?.status, "available");
  assert.equal(record.rollback?.targetPath, fixture.targetSkill);
  assert.equal(typeof record.rollback?.backupPath, "string");
  assert.equal(Array.isArray(record.rollback?.files), true);
  assert.equal(Array.isArray(record.rollback?.appliedFiles), true);

  // The pre-repair dirty content is preserved in the backup directory.
  const backupPath = record.rollback?.backupPath as string;
  assert.equal(result.repaired.backups.length, 1);
  assert.equal(result.repaired.backups[0]?.backupPath, backupPath);
  assert.equal(await readFile(path.join(backupPath, "runtime.js"), "utf8"), "console.log(\"locally edited\");\n");
  assert.equal(await readFile(path.join(backupPath, "extra.js"), "utf8"), "console.log(\"local extra\");\n");

  const postStatus = await status({ source: fixture.sourceRoot, target: "openclaw" });
  assert.equal(postStatus.summary.current, 1);
  assert.equal(postStatus.summary.dirty, 0);
});

test("repair apply rollback restores the pre-repair dirty target via receipt metadata", async (t) => {
  const fixture = await createTrackedFixture(t);
  await dirtyTheTarget(fixture);

  const applied = await repair({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    apply: true
  });
  assert.equal(applied.ok, true);

  const rollbackResult = await rollback({ receipt: path.join(fixture.targetRoot, RECEIPT_FILE) });
  assert.equal(rollbackResult.ok, true);

  // The dirty edits are restored exactly.
  assert.equal(await readFile(path.join(fixture.targetSkill, "runtime.js"), "utf8"), "console.log(\"locally edited\");\n");
  assert.equal(await readFile(path.join(fixture.targetSkill, "extra.js"), "utf8"), "console.log(\"local extra\");\n");

  // The skill remains receipt-owned (repair does not orphan the install) and is marked rolled-back.
  const receiptAfter = JSON.parse(await readFile(path.join(fixture.targetRoot, RECEIPT_FILE), "utf8")) as Receipt;
  const recordAfter = singleRecord(receiptAfter, "skill-cleaner");
  assert.equal(recordAfter.rollback?.status, "rolled-back");
});

test("repair apply restores the dirty target and writes no receipt when a write fails after backup", async (t) => {
  const fixture = await createTrackedFixture(t);
  await dirtyTheTarget(fixture);
  const receiptBefore = await readFile(path.join(fixture.targetRoot, RECEIPT_FILE), "utf8");

  const result = await repair({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    apply: true,
    __test: { failAfterBackup: true }
  } as Parameters<typeof repair>[0] & { __test: { failAfterBackup: boolean } });

  assert.equal(result.ok, false);
  assert.deepEqual(result.repaired.skills, []);
  assert.equal(result.repaired.files, 0);
  assert.deepEqual(result.repaired.backups, []);
  assert.equal(result.errors.some((error) => error.code === "repair_write_failed" && error.skill === "skill-cleaner"), true);

  // The dirty target is left exactly as it was; the receipt is untouched.
  assert.equal(await readFile(path.join(fixture.targetSkill, "runtime.js"), "utf8"), "console.log(\"locally edited\");\n");
  assert.equal(await readFile(path.join(fixture.targetSkill, "extra.js"), "utf8"), "console.log(\"local extra\");\n");
  assert.equal(await readFile(path.join(fixture.targetRoot, RECEIPT_FILE), "utf8"), receiptBefore);
  const record = singleRecord(JSON.parse(receiptBefore) as Receipt, "skill-cleaner");
  assert.notEqual(record.mode, "repair");
});
