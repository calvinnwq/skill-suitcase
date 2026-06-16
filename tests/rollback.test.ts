import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildPlanLock } from "../src/plan-lock.js";
import { apply } from "../src/apply.js";
import { rollback } from "../src/rollback.js";
import { buildInstalledFiles, RECEIPT_FILE, upsertAndWriteReceipt } from "../src/receipt.js";
import { status } from "../src/status.js";
import { track } from "../src/track.js";

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
  sourceSkill: string;
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
      sourceHash: await hashDirectory(sourceSkill),
      installedFiles: await buildInstalledFiles(targetSkill)
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
    sourceSkill,
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

test("apply captures pre-existing symlink files as restore-impossible", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-symlink-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-symlink-target-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-symlink-file-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"old\");\n");
  await cp(sourceSkill, targetSkill, { recursive: true });

  const outsideFile = path.join(outsideRoot, "runtime.js");
  await writeFile(outsideFile, "console.log(\"old\");\n");
  await rm(path.join(targetSkill, "runtime.js"));
  await symlink(outsideFile, path.join(targetSkill, "runtime.js"));

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
      sourceHash: await hashDirectory(sourceSkill),
      installedFiles: await buildInstalledFiles(targetSkill)
    }
  });

  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"new\");\n");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-symlink-lock-")), "plan-lock.json");
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

  const receipt = JSON.parse(await readFile(path.join(targetRoot, RECEIPT_FILE), "utf8")) as {
    installs: { "office-hours": { rollback?: { files?: Array<{ path: string; previous: { kind: string; reason?: string } }> } } };
  };
  const runtimeFile = receipt.installs["office-hours"].rollback?.files?.find((file) => file.path === "runtime.js");
  assert.equal(runtimeFile?.previous.kind, "restore-impossible");
  assert.equal(runtimeFile?.previous.reason, "target was a symbolic link");
  assert.equal(await readFile(outsideFile, "utf8"), "console.log(\"old\");\n");
});

test("rollback updates receipt metadata to the restored target state", async (t) => {
  const { receiptPath, sourceRoot, targetSkill } = await createAppliedUpdate(t);

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, true);

  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: {
      "office-hours": {
        version?: string;
        sourceHash?: string;
        installedFiles?: unknown;
        rollback?: { status?: string };
      };
    };
  };
  const record = receipt.installs["office-hours"];
  assert.equal(record.rollback?.status, "rolled-back");
  assert.equal(record.version, "2026.06.11");
  assert.equal(record.sourceHash, await hashDirectory(targetSkill));
  assert.deepEqual(record.installedFiles, await buildInstalledFiles(targetSkill));

  const statusResult = await status({ source: sourceRoot });
  const officeHours = statusResult.statuses.find((entry) => entry.skill === "office-hours");
  assert.equal(officeHours?.status, "behind");
});

test("rollback restores prior source hash while preserving extra installed files", async (t) => {
  const { receiptPath, sourceRoot, sourceSkill, targetSkill } = await createAppliedUpdate(t);
  await writeFile(path.join(targetSkill, "preserved.txt"), "target-only\n");

  const receiptBefore = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: {
      "office-hours": {
        priorState?: { installedHash?: string };
        rollback?: { appliedFiles?: unknown };
        installedFiles?: unknown;
      };
    };
  };
  const priorSourceHash = receiptBefore.installs["office-hours"].priorState?.installedHash;
  if (typeof priorSourceHash !== "string") {
    throw new Error("expected rollback priorState.installedHash");
  }
  receiptBefore.installs["office-hours"].installedFiles = await buildInstalledFiles(targetSkill);
  if (receiptBefore.installs["office-hours"].rollback !== undefined) {
    receiptBefore.installs["office-hours"].rollback.appliedFiles = await buildInstalledFiles(targetSkill);
  }
  await writeFile(receiptPath, `${JSON.stringify(receiptBefore, null, 2)}\n`, "utf8");

  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"newer\");\n");
  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, true);
  assert.equal(await readFile(path.join(targetSkill, "preserved.txt"), "utf8"), "target-only\n");

  const receiptAfter = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: {
      "office-hours": {
        sourceHash?: string;
        installedFiles?: unknown;
      };
    };
  };
  const record = receiptAfter.installs["office-hours"];
  assert.equal(record.sourceHash, priorSourceHash);
  assert.deepEqual(record.installedFiles, await buildInstalledFiles(targetSkill));

  const statusResult = await status({ source: sourceRoot });
  const officeHours = statusResult.statuses.find((entry) => entry.skill === "office-hours");
  assert.equal(officeHours?.status, "behind");
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

test("rollback refuses file paths with symlinked ancestors", async (t) => {
  const { receiptPath, targetSkill } = await createAppliedUpdate(t);
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-nested-symlink-outside-"));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  const linkPath = path.join(targetSkill, "nested");
  await symlink(outsideRoot, linkPath, "dir");

  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: { "office-hours": { rollback: { files: unknown[] } } };
  };
  receipt.installs["office-hours"].rollback.files.push({
    path: "nested/escaped.txt",
    targetPath: path.join(targetSkill, "nested", "escaped.txt"),
    previous: { kind: "file", bytes: Buffer.from("escaped\n").toString("base64") }
  });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "target_drift");
  await assert.rejects(readFile(path.join(outsideRoot, "escaped.txt"), "utf8"), /ENOENT/);
});

test("rollback removes installs that were missing before apply", async (t) => {
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
  await assert.rejects(stat(targetSkill), /ENOENT/);

  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { installs?: Record<string, unknown> };
  assert.equal(receipt.installs?.["office-hours"], undefined);
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

test("rollback refuses malformed rollback value", async (t) => {
  const { receiptPath, targetSkill } = await createAppliedUpdate(t);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: { "office-hours": { rollback?: unknown } };
  };
  receipt.installs["office-hours"].rollback = [];
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "invalid_receipt");
  assert.equal(result.summary.refused, 1);
  assert.equal(result.rollbacks[0]?.status, "refused");
  assert.equal(await readFile(path.join(targetSkill, "runtime.js"), "utf8"), "console.log(\"new\");\n");
});

test("rollback refuses malformed install records", async (t) => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-invalid-install-"));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  const receiptPath = path.join(targetRoot, RECEIPT_FILE);
  await writeFile(
    receiptPath,
    `${JSON.stringify({
      schema: "calvinnwq.skills.receipt.v0",
      installs: {
        "office-hours": null
      }
    }, null, 2)}\n`
  );

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.summary.refused, 1);
  assert.equal(result.errors[0]?.code, "invalid_receipt");
});

test("rollback refuses array-shaped receipt installs", async (t) => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-array-installs-"));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  const receiptPath = path.join(targetRoot, RECEIPT_FILE);
  await writeFile(
    receiptPath,
    `${JSON.stringify({
      schema: "calvinnwq.skills.receipt.v0",
      installs: []
    }, null, 2)}\n`
  );

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "invalid_receipt");
  assert.equal(result.rollbacks.length, 0);
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

test("rollback returns invalid_receipt for malformed receipt JSON", async (t) => {
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-invalid-json-"));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  const receiptPath = path.join(targetRoot, RECEIPT_FILE);
  await writeFile(receiptPath, "{ not json\n");

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "invalid_receipt");
  assert.deepEqual(result.rollbacks, []);
});

test("rollback reports receipt write failures after restoring files", async (t) => {
  const { receiptPath, targetSkill } = await createAppliedUpdate(t);
  await chmod(receiptPath, 0o400);
  t.after(() => chmod(receiptPath, 0o600).catch(() => undefined));

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "receipt_write_failed"), true);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.rollbacks[0]?.status, "partial");
  assert.equal(await readFile(path.join(targetSkill, "runtime.js"), "utf8"), "console.log(\"old\");\n");
});

async function createTrackedSymlink(t: { after(fn: () => Promise<void> | void): void }): Promise<{
  sourceRoot: string;
  sourceSkill: string;
  targetRoot: string;
  targetSkill: string;
  receiptPath: string;
}> {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-symlink-mode-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-rollback-symlink-mode-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(
    path.join(sourceSkill, "SKILL.md"),
    "---\nname: office-hours\nversion: \"2026.06.14\"\n---\n# office-hours\n"
  );
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"source\");\n");

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:\n  core:\n    skills:\n      - office-hours\n\nassignments:\n  openclaw:\n    suitcases:\n      - core\n\nassignmentPaths:\n  openclaw:\n    kind: openclaw-skills-root\n    assignment: openclaw\n    path: ${targetRoot}\n\ncompatibility:\n  office-hours:\n    agents:\n      - openclaw\n    variant: canonical\n`
  );

  const targetSkill = path.join(targetRoot, "office-hours");
  await symlink(sourceSkill, targetSkill, "dir");

  const trackResult = await track({ source: sourceRoot, target: "openclaw" });
  assert.equal(trackResult.ok, true);

  return {
    sourceRoot,
    sourceSkill,
    targetRoot,
    targetSkill,
    receiptPath: path.join(targetRoot, RECEIPT_FILE)
  };
}

test("rollback treats an adopted symlink install as a safe no-op", async (t) => {
  const { sourceSkill, targetSkill, receiptPath } = await createTrackedSymlink(t);

  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: { "office-hours": { mode?: string } };
  };
  assert.equal(receipt.installs["office-hours"].mode, "symlink");

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, true);
  assert.equal(result.summary.noop, 1);
  assert.equal(result.summary.removed, 0);
  assert.equal(result.summary.restored, 0);
  assert.equal(result.rollbacks[0]?.status, "noop");
  // The adopted link and the catalog source must be left untouched.
  assert.equal((await lstat(targetSkill)).isSymbolicLink(), true);
  assert.equal(path.resolve(await readlink(targetSkill)), path.resolve(sourceSkill));
});

test("rollback never restores copy-style bytes through a symlink-mode install", async (t) => {
  const { sourceSkill, targetSkill, receiptPath } = await createTrackedSymlink(t);
  const sourceBytesBefore = await readFile(path.join(sourceSkill, "runtime.js"), "utf8");

  // Inject a spurious copy-style rollback record. Restoring it would write
  // through the symlink into the catalog source, so rollback must ignore it and
  // treat the symlink install as a safe no-op instead.
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: { "office-hours": Record<string, unknown> };
  };
  receipt.installs["office-hours"].rollback = {
    schema: "calvinnwq.skills.rollback.v0",
    status: "available",
    targetPath: targetSkill,
    appliedFiles: [],
    files: [
      {
        path: "runtime.js",
        targetPath: path.join(targetSkill, "runtime.js"),
        previous: { kind: "file", bytes: Buffer.from("HIJACKED\n").toString("base64") }
      }
    ]
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const result = await rollback({ receipt: receiptPath });

  assert.equal(result.ok, true);
  assert.equal(result.summary.noop, 1);
  assert.equal(result.summary.restored, 0);
  assert.equal(result.rollbacks[0]?.status, "noop");
  // The symlink is intact and the catalog source was never written through.
  assert.equal((await lstat(targetSkill)).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(sourceSkill, "runtime.js"), "utf8"), sourceBytesBefore);
});
