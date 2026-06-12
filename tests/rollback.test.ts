import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildPlanLock } from "../src/plan-lock.js";
import { apply } from "../src/apply.js";
import { rollback } from "../src/rollback.js";
import { RECEIPT_FILE, upsertAndWriteReceipt } from "../src/receipt.js";

async function writeCatalog(sourceRoot: string, targetRoot: string): Promise<void> {
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:\n  core:\n    skills:\n      - office-hours\n\nassignments:\n  openclaw:\n    suitcases:\n      - core\n\nassignmentPaths:\n  openclaw:\n    kind: openclaw-skills-root\n    assignment: openclaw\n    path: ${targetRoot}\n`
  );
}

async function hashDirectory(root: string): Promise<string> {
  const files = ["SKILL.md", "runtime.js"];
  const digest = createHash("sha256");
  for (const relativePath of files) {
    const bytes = await readFile(path.join(root, relativePath));
    digest.update(relativePath);
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function createAppliedUpdate(t: { after(fn: () => Promise<void> | void): void }): Promise<{
  sourceRoot: string;
  targetRoot: string;
  targetSkill: string;
  receiptPath: string;
}> {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"old\");\n");
  await cp(sourceSkill, targetSkill, { recursive: true });

  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: { path: sourceSkill },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: await hashDirectory(sourceSkill)
    }
  });

  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"new\");\n");
  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({ source: sourceRoot, target: "openclaw", lock: lockPath });
  assert.equal(result.ok, true);
  return {
    sourceRoot,
    targetRoot,
    targetSkill,
    receiptPath: path.join(targetRoot, RECEIPT_FILE)
  };
}

test("apply captures rollback state and rollback restores previous file bytes", async (t) => {
  const { receiptPath, targetSkill } = await createAppliedUpdate(t);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: { "office-hours": { rollback?: { files?: Array<{ path: string; previous: { kind: string; text?: string } }> } } };
  };
  const rollbackRecord = receipt.installs["office-hours"].rollback;
  assert.equal(typeof rollbackRecord, "object");
  assert.equal(rollbackRecord?.files?.some((file) => file.path === "runtime.js" && file.previous.kind === "file"), true);

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, true);
  assert.equal(result.summary.restored, 1);
  assert.equal(await readFile(path.join(targetSkill, "runtime.js"), "utf8"), "console.log(\"old\");\n");
});

test("rollback refuses target drift before restoring", async (t) => {
  const { receiptPath, targetSkill } = await createAppliedUpdate(t);
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"user edit\");\n");

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "target_drift");
  assert.equal(await readFile(path.join(targetSkill, "runtime.js"), "utf8"), "console.log(\"user edit\");\n");
});

test("rollback refuses a symlinked target root before restoring", async (t) => {
  const { receiptPath, targetSkill } = await createAppliedUpdate(t);
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-symlink-outside-"));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  const outsideSkill = path.join(outsideRoot, "office-hours");
  await cp(targetSkill, outsideSkill, { recursive: true });
  await rm(targetSkill, { recursive: true, force: true });
  await symlink(outsideSkill, targetSkill, "dir");

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "target_drift");
  assert.equal(result.summary.refused, 1);
  assert.equal(await readFile(path.join(outsideSkill, "runtime.js"), "utf8"), "console.log(\"new\");\n");
});

test("rollback removes files that were missing before apply", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-missing-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-missing-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"created\");\n");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-missing-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const applyResult = await apply({ source: sourceRoot, target: "openclaw", lock: lockPath });
  assert.equal(applyResult.ok, true);

  const receiptPath = path.join(targetRoot, RECEIPT_FILE);
  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, true);
  assert.equal(result.summary.removed, 2);
  await assert.rejects(readFile(path.join(targetSkill, "runtime.js"), "utf8"), /ENOENT/);
});

test("rollback is a deterministic no-op after a successful rollback", async (t) => {
  const { receiptPath } = await createAppliedUpdate(t);
  const first = await rollback({ receipt: receiptPath });
  const second = await rollback({ receipt: receiptPath });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.summary.noop, 1);
  assert.deepEqual(second.errors, []);
});

test("rollback reports remove failures instead of falsely reporting success", async (t) => {
  const { receiptPath, targetSkill } = await createAppliedUpdate(t);
  const blocker = path.join(targetSkill, "not-a-directory");
  await writeFile(blocker, "blocker\n");

  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: { "office-hours": { rollback: { files: unknown[]; appliedFiles: unknown[] } } };
  };
  receipt.installs["office-hours"].rollback.appliedFiles.push({
    path: "not-a-directory",
    hash: createHash("sha256").update("blocker\n").digest("hex")
  });
  receipt.installs["office-hours"].rollback.files.push({
    path: "not-a-directory/ghost.txt",
    targetPath: path.join(blocker, "ghost.txt"),
    previous: { kind: "missing" }
  });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.removed, 0);
  assert.equal(result.errors.some((error) => error.code === "rollback_remove_failed"), true);
});

test("rollback reports restore write failures as failed entries without throwing", async (t) => {
  const { receiptPath, targetSkill } = await createAppliedUpdate(t);
  const blocker = path.join(targetSkill, "not-a-directory");
  await writeFile(blocker, "blocker\n");

  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: { "office-hours": { rollback: { files: unknown[]; appliedFiles: unknown[] } } };
  };
  receipt.installs["office-hours"].rollback.appliedFiles.push({
    path: "not-a-directory",
    hash: createHash("sha256").update("blocker\n").digest("hex")
  });
  receipt.installs["office-hours"].rollback.files.push({
    path: "not-a-directory/ghost.txt",
    targetPath: path.join(blocker, "ghost.txt"),
    previous: { kind: "file", bytes: Buffer.from("ghost\n").toString("base64") }
  });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.errors.some((error) => error.code === "restore_write_failed"), true);
});

test("rollback reports restore-impossible entries as partial failures", async (t) => {
  const { receiptPath } = await createAppliedUpdate(t);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: { "office-hours": { rollback: { files: unknown[] } } };
  };
  receipt.installs["office-hours"].rollback.files.push({
    path: "blocked.bin",
    targetPath: path.join(path.dirname(receiptPath), "office-hours", "blocked.bin"),
    applied: { kind: "missing" },
    previous: { kind: "restore-impossible", reason: "target was not a regular file" }
  });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.errors.some((error) => error.code === "restore_impossible"), true);
});

test("rollback refuses file targets outside the rollback target", async (t) => {
  const { receiptPath, targetSkill } = await createAppliedUpdate(t);
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-outside-"));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  const outsideFile = path.join(outsideRoot, "runtime.js");
  await writeFile(outsideFile, "outside\n");

  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: { "office-hours": { rollback: { files: Array<Record<string, unknown>> } } };
  };
  receipt.installs["office-hours"].rollback.files[0] = {
    ...receipt.installs["office-hours"].rollback.files[0],
    targetPath: outsideFile
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "invalid_receipt");
  assert.equal(await readFile(outsideFile, "utf8"), "outside\n");
  assert.equal(await readFile(path.join(targetSkill, "runtime.js"), "utf8"), "console.log(\"new\");\n");
});

test("rollback refuses malformed rollback file state", async (t) => {
  const { receiptPath, targetSkill } = await createAppliedUpdate(t);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: { "office-hours": { rollback: { files: unknown } } };
  };
  receipt.installs["office-hours"].rollback.files = [{ path: "runtime.js" }];
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "invalid_receipt");
  assert.equal(result.summary.refused, 1);
  assert.equal(await readFile(path.join(targetSkill, "runtime.js"), "utf8"), "console.log(\"new\");\n");
});

test("rollback refuses missing applied rollback state", async (t) => {
  const { receiptPath, targetSkill } = await createAppliedUpdate(t);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: { "office-hours": { rollback: { appliedFiles?: unknown } } };
  };
  delete receipt.installs["office-hours"].rollback.appliedFiles;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "invalid_receipt");
  assert.equal(result.summary.refused, 1);
  assert.equal(await readFile(path.join(targetSkill, "runtime.js"), "utf8"), "console.log(\"new\");\n");
});
