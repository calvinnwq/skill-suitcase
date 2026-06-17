import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { RECEIPT_FILE, type Receipt, type ReceiptInstallRecord } from "../src/receipt.js";
import { reconcile } from "../src/reconcile.js";
import { rollback } from "../src/rollback.js";
import { status } from "../src/status.js";
import { track } from "../src/track.js";

const execFileAsync = promisify(execFile);

async function createReconcileFixture(t: { after(fn: () => Promise<void> | void): void }): Promise<{
  sourceRoot: string;
  targetRoot: string;
  sourceSkill: string;
  targetSkill: string;
}> {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-reconcile-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-reconcile-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "skill-cleaner");
  const targetSkill = path.join(targetRoot, "skill-cleaner");
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: skill-cleaner\nversion: 2026.06.17\n---\n# Skill Cleaner\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"catalog\");\n");
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nname: skill-cleaner\nversion: 2026.06.01\n---\n# Skill Cleaner\n");
  await writeFile(path.join(targetSkill, "legacy.js"), "console.log(\"target-only\");\n");
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

  return { sourceRoot, targetRoot, sourceSkill, targetSkill };
}

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

async function makeFifo(filePath: string): Promise<boolean> {
  try {
    await execFileAsync("mkfifo", [filePath]);
    return true;
  } catch {
    return false;
  }
}

test("reconcile dry-run plans selected unknown target skills without mutating files", async (t) => {
  const { sourceRoot, targetRoot, targetSkill } = await createReconcileFixture(t);
  const beforeSkill = await readFile(path.join(targetSkill, "SKILL.md"), "utf8");

  const result = await reconcile({
    source: sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.selected.skills, ["skill-cleaner"]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.skill), ["skill-cleaner"]);
  assert.equal(result.candidates[0]?.changes.update, 1);
  assert.equal(result.candidates[0]?.changes.create, 1);
  assert.equal(result.candidates[0]?.changes.extra, 1);
  assert.equal(result.candidates[0]?.backup.backupPathTemplate, path.join(targetRoot, ".skill-cleaner.suitcase-pre-reconcile-<timestamp>"));
  assert.equal(await readFile(path.join(targetSkill, "SKILL.md"), "utf8"), beforeSkill);
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("track still refuses mismatched unknown targets instead of adopting them", async (t) => {
  const { sourceRoot } = await createReconcileFixture(t);

  const result = await track({
    source: sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"]
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_mismatch" && error.skill === "skill-cleaner"), true);
});

test("approved reconcile replaces target from catalog, records backup rollback metadata, and leaves status current", async (t) => {
  const { sourceRoot, targetRoot, sourceSkill, targetSkill } = await createReconcileFixture(t);

  const result = await reconcile({
    source: sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    apply: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.reconciled.skills, ["skill-cleaner"]);
  assert.equal(result.reconciled.files, 2);
  assert.equal(await readFile(path.join(targetSkill, "runtime.js"), "utf8"), "console.log(\"catalog\");\n");
  await assert.rejects(readFile(path.join(targetSkill, "legacy.js"), "utf8"), /ENOENT/);

  const receipt = JSON.parse(await readFile(path.join(targetRoot, RECEIPT_FILE), "utf8")) as Receipt;
  const record = singleRecord(receipt, "skill-cleaner");
  assert.equal(record.mode, "reconcile");
  assert.equal(record.sourcePath, sourceSkill);
  assert.equal(record.targetPath, targetSkill);
  assert.equal(record.version, "2026.06.17");
  assert.equal(typeof record.sourceHash, "string");
  assert.equal(Array.isArray(record.installedFiles), true);
  assert.equal((record.installedFiles as unknown[]).length, 2);
  assert.deepEqual(record.priorState?.status, "unknown");
  assert.equal(record.rollback?.schema, "calvinnwq.skills.rollback.v0");
  assert.equal(record.rollback?.status, "available");
  assert.equal(record.rollback?.targetPath, targetSkill);
  assert.equal(typeof record.rollback?.backupPath, "string");
  assert.equal(Array.isArray(record.rollback?.files), true);
  assert.equal(Array.isArray(record.rollback?.appliedFiles), true);
  const backupPath = record.rollback?.backupPath as string;
  assert.equal(await readFile(path.join(backupPath, "legacy.js"), "utf8"), "console.log(\"target-only\");\n");

  const postStatus = await status({ source: sourceRoot, target: "openclaw" });
  assert.equal(postStatus.ok, true);
  assert.equal(postStatus.summary.current, 1);

  const rollbackResult = await rollback({ receipt: path.join(targetRoot, RECEIPT_FILE) });
  assert.equal(rollbackResult.ok, true);
  assert.equal(await readFile(path.join(targetSkill, "legacy.js"), "utf8"), "console.log(\"target-only\");\n");
  await assert.rejects(readFile(path.join(targetSkill, "runtime.js"), "utf8"), /ENOENT/);
  await assert.rejects(() => stat(backupPath), /ENOENT/);
  const receiptAfterRollback = JSON.parse(await readFile(path.join(targetRoot, RECEIPT_FILE), "utf8")) as Receipt;
  assert.equal(receiptAfterRollback.installs?.["skill-cleaner"], undefined);
  const statusAfterRollback = await status({ source: sourceRoot, target: "openclaw" });
  assert.equal(statusAfterRollback.summary.unknown, 1);
});

test("reconcile rollback removes directories created from catalog source", async (t) => {
  const { sourceRoot, targetRoot, sourceSkill, targetSkill } = await createReconcileFixture(t);
  await mkdir(path.join(sourceSkill, "scripts"), { recursive: true });
  await mkdir(path.join(sourceSkill, "empty-source-dir"), { recursive: true });
  await writeFile(path.join(sourceSkill, "scripts", "runtime.js"), "console.log(\"nested catalog\");\n");

  const result = await reconcile({
    source: sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    apply: true
  });

  assert.equal(result.ok, true);
  assert.equal(await readFile(path.join(targetSkill, "scripts", "runtime.js"), "utf8"), "console.log(\"nested catalog\");\n");
  assert.equal((await stat(path.join(targetSkill, "empty-source-dir"))).isDirectory(), true);

  const rollbackResult = await rollback({ receipt: path.join(targetRoot, RECEIPT_FILE) });

  assert.equal(rollbackResult.ok, true);
  assert.equal(await readFile(path.join(targetSkill, "legacy.js"), "utf8"), "console.log(\"target-only\");\n");
  await assert.rejects(() => stat(path.join(targetSkill, "scripts")), /ENOENT/);
  await assert.rejects(() => stat(path.join(targetSkill, "empty-source-dir")), /ENOENT/);
});

test("reconcile rollback restores a file replaced by a catalog directory", async (t) => {
  const { sourceRoot, targetRoot, sourceSkill, targetSkill } = await createReconcileFixture(t);
  await mkdir(path.join(sourceSkill, "legacy.js"), { recursive: true });

  const result = await reconcile({
    source: sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    apply: true
  });

  assert.equal(result.ok, true);
  assert.equal((await stat(path.join(targetSkill, "legacy.js"))).isDirectory(), true);

  const rollbackResult = await rollback({ receipt: path.join(targetRoot, RECEIPT_FILE) });

  assert.equal(rollbackResult.ok, true);
  assert.equal(await readFile(path.join(targetSkill, "legacy.js"), "utf8"), "console.log(\"target-only\");\n");
  assert.equal(await readFile(path.join(targetSkill, "SKILL.md"), "utf8"), "---\nname: skill-cleaner\nversion: 2026.06.01\n---\n# Skill Cleaner\n");
});

test("reconcile refuses unsupported special entries in source and target trees", async (t) => {
  const sourceFixture = await createReconcileFixture(t);
  const sourceFifo = path.join(sourceFixture.sourceSkill, "source.fifo");
  if (!(await makeFifo(sourceFifo))) {
    t.skip("mkfifo unavailable");
    return;
  }

  const sourceResult = await reconcile({
    source: sourceFixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(sourceResult.ok, false);
  assert.equal(sourceResult.errors.some((error) =>
    error.code === "unsupported_source_tree" &&
    error.skill === "skill-cleaner" &&
    error.path === sourceFifo
  ), true);

  const targetFixture = await createReconcileFixture(t);
  const targetFifo = path.join(targetFixture.targetSkill, "target.fifo");
  if (!(await makeFifo(targetFifo))) {
    t.skip("mkfifo unavailable");
    return;
  }

  const targetResult = await reconcile({
    source: targetFixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(targetResult.ok, false);
  assert.equal(targetResult.errors.some((error) =>
    error.code === "unsafe_target_tree" &&
    error.skill === "skill-cleaner" &&
    error.path === targetFifo
  ), true);
});

test("reconcile refuses unsafe target trees and read-only provider targets", async (t) => {
  const { sourceRoot, targetSkill } = await createReconcileFixture(t);
  await symlink(path.join(targetSkill, "SKILL.md"), path.join(targetSkill, "linked.md"));

  const unsafe = await reconcile({
    source: sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.errors.some((error) => error.code === "unsafe_target_tree" && error.skill === "skill-cleaner"), true);

  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-reconcile-provider-home-"));
  t.after(() => rm(fakeHome, { recursive: true, force: true }));
  const readOnly = await reconcile({
    source: sourceRoot,
    target: "opencode",
    skills: ["skill-cleaner"],
    targetOverrides: { home: fakeHome },
    dryRun: true
  });

  assert.equal(readOnly.ok, false);
  assert.equal(readOnly.errors.some((error) => error.code === "read_only_target"), true);
  await assert.rejects(() => stat(path.join(fakeHome, ".config", "opencode", "skills")), /ENOENT/);
});

test("reconcile refuses manifest skill names that resolve outside the install root", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-reconcile-path-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-reconcile-path-target-"));
  const outsideTarget = path.join(path.dirname(targetRoot), "outside-skill");
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  t.after(() => rm(outsideTarget, { recursive: true, force: true }));

  const escapedSource = path.join(sourceRoot, "outside-skill");
  await mkdir(escapedSource, { recursive: true });
  await mkdir(outsideTarget, { recursive: true });
  await writeFile(path.join(escapedSource, "SKILL.md"), "---\nname: outside-skill\nversion: 2026.06.17\n---\n# Outside\n");
  await writeFile(path.join(escapedSource, "runtime.js"), "console.log(\"catalog outside\");\n");
  await writeFile(path.join(outsideTarget, "SKILL.md"), "---\nname: outside-skill\nversion: 2026.06.01\n---\n# Outside\n");
  await writeFile(path.join(outsideTarget, "legacy.js"), "console.log(\"outside target\");\n");
  await writeFile(path.join(sourceRoot, "skill-suitcase.yaml"), `suitcases:
  core:
    skills:
      - ../outside-skill

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
  ../outside-skill:
    agents:
      - openclaw
    variant: canonical
`);

  const result = await reconcile({
    source: sourceRoot,
    target: "openclaw",
    skills: ["../outside-skill"],
    apply: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsafe_path" && error.skill === "../outside-skill"), true);
  assert.equal(await readFile(path.join(outsideTarget, "legacy.js"), "utf8"), "console.log(\"outside target\");\n");
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("reconcile refuses target trees with empty directories that rollback cannot restore", async (t) => {
  const { sourceRoot, targetSkill } = await createReconcileFixture(t);
  await mkdir(path.join(targetSkill, "empty-dir"), { recursive: true });

  const result = await reconcile({
    source: sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_tree" && error.path === path.join(targetSkill, "empty-dir")), true);
});

test("reconcile refuses non-planned, blocked, and exact-match target states", async (t) => {
  const { sourceRoot, targetSkill } = await createReconcileFixture(t);
  const nonPlanned = await reconcile({
    source: sourceRoot,
    target: "openclaw",
    skills: ["session-routing-classifier"],
    dryRun: true
  });
  assert.equal(nonPlanned.ok, false);
  assert.equal(nonPlanned.errors.some((error) => error.code === "skill_not_planned"), true);

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
    path: ${path.dirname(targetSkill)}

compatibility:
  skill-cleaner:
    agents:
      - codex
    blockedAgents:
      openclaw: Reconcile must honor catalog compatibility blocks.
`);
  const blocked = await reconcile({
    source: sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errors.some((error) => error.code === "blocked_skill" && error.skill === "skill-cleaner"), true);

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
    path: ${path.dirname(targetSkill)}

compatibility:
  skill-cleaner:
    agents:
      - openclaw
    variant: canonical
`);
  await rm(targetSkill, { recursive: true, force: true });
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nname: skill-cleaner\nversion: 2026.06.17\n---\n# Skill Cleaner\n");
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"catalog\");\n");
  const exactMatch = await reconcile({
    source: sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });
  assert.equal(exactMatch.ok, false);
  assert.equal(exactMatch.errors.some((error) => error.code === "target_matches_catalog_use_track"), true);
});

test("reconcile refuses live mode unless it follows a valid planned candidate", async (t) => {
  const { sourceRoot, targetRoot } = await createReconcileFixture(t);
  await rm(path.join(targetRoot, "skill-cleaner"), { recursive: true, force: true });

  const missing = await reconcile({
    source: sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    apply: true
  });

  assert.equal(missing.ok, false);
  assert.equal(missing.errors.some((error) => error.code === "unsupported_target_state" && error.skill === "skill-cleaner"), true);
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("reconcile failure after a completed skill reports no reconciled skills after rollback", async (t) => {
  const { sourceRoot, targetRoot, targetSkill } = await createReconcileFixture(t);
  const failingSourceSkill = path.join(sourceRoot, "skills", "z-failing-skill");
  const failingTargetSkill = path.join(targetRoot, "z-failing-skill");
  await mkdir(failingSourceSkill, { recursive: true });
  await mkdir(failingTargetSkill, { recursive: true });
  await writeFile(path.join(failingSourceSkill, "SKILL.md"), "---\nname: z-failing-skill\nversion: 2026.06.17\n---\n# Failing\n");
  await writeFile(path.join(failingSourceSkill, "runtime.js"), "console.log(\"catalog failing\");\n");
  await writeFile(path.join(failingTargetSkill, "SKILL.md"), "---\nname: z-failing-skill\nversion: 2026.06.01\n---\n# Failing\n");
  await writeFile(path.join(failingTargetSkill, "legacy.js"), "console.log(\"target failing\");\n");
  await writeFile(path.join(sourceRoot, "skill-suitcase.yaml"), `suitcases:
  core:
    skills:
      - skill-cleaner
      - z-failing-skill

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
  z-failing-skill:
    agents:
      - openclaw
    variant: canonical
`);

  const result = await reconcile({
    source: sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner", "z-failing-skill"],
    apply: true,
    __test: {
      failAfterBackupForSkill: "z-failing-skill"
    }
  } as Parameters<typeof reconcile>[0] & { __test: { failAfterBackupForSkill: string } });

  assert.equal(result.ok, false);
  assert.deepEqual(result.reconciled.skills, []);
  assert.equal(result.reconciled.files, 0);
  assert.deepEqual(result.reconciled.backups, []);
  assert.equal(await readFile(path.join(targetSkill, "legacy.js"), "utf8"), "console.log(\"target-only\");\n");
  await assert.rejects(readFile(path.join(targetSkill, "runtime.js"), "utf8"), /ENOENT/);
  assert.equal(await readFile(path.join(failingTargetSkill, "legacy.js"), "utf8"), "console.log(\"target failing\");\n");
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});
