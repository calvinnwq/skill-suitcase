import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dispatchCommand, parseCommandArgs } from "../src/commands/index.js";
import { executePromote, planPromote } from "../src/promote.js";

type Cleanup = { after(fn: () => Promise<void> | void): void };

async function makeRepo(t: Cleanup): Promise<string> {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-promote-src-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await mkdir(path.join(sourceRoot, "skills"), { recursive: true });
  return sourceRoot;
}

async function makeTargetSkill(
  t: Cleanup,
  { name = "new-skill", withSkillFile = true }: { name?: string; withSkillFile?: boolean } = {}
): Promise<{ home: string; skillPath: string }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-promote-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const skillPath = path.join(home, "skills", name);
  await mkdir(skillPath, { recursive: true });
  if (withSkillFile) {
    await writeFile(path.join(skillPath, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`);
  }
  await writeFile(path.join(skillPath, "runtime.js"), `console.log("${name}");\n`);
  return { home, skillPath };
}

test("promote dry-run plans a clean copy/verify/symlink/receipt workflow without mutating anything", async (t) => {
  const sourceRoot = await makeRepo(t);
  const { skillPath } = await makeTargetSkill(t);
  const repoSkillPath = path.join(sourceRoot, "skills", "new-skill");

  const result = await planPromote({ source: sourceRoot, targetSkill: skillPath });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.skillName, "new-skill");
  assert.equal(result.repoSkillPath, repoSkillPath);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.plan.map((step) => step.action), ["copy", "verify", "symlink", "receipt"]);
  assert.equal(result.summary.conflicts, 0);
  assert.equal(result.summary.steps, 4);

  // Read-only: no repo copy created, target left as a real directory with its files.
  await assert.rejects(stat(repoSkillPath));
  assert.equal((await lstat(skillPath)).isDirectory(), true);
  assert.equal((await lstat(skillPath)).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(skillPath, "SKILL.md"), "utf8"), "---\nname: new-skill\n---\n# new-skill\n");
});

test("promote dry-run reports existing_repo_skill without touching the existing repo skill", async (t) => {
  const sourceRoot = await makeRepo(t);
  const { skillPath } = await makeTargetSkill(t);
  const repoSkillPath = path.join(sourceRoot, "skills", "new-skill");
  await mkdir(repoSkillPath, { recursive: true });
  await writeFile(path.join(repoSkillPath, "SKILL.md"), "---\nname: new-skill\n---\n# existing\n");

  const result = await planPromote({ source: sourceRoot, targetSkill: skillPath });

  assert.equal(result.ok, false);
  const conflict = result.conflicts.find((entry) => entry.code === "existing_repo_skill");
  assert.ok(conflict, "expected existing_repo_skill conflict");
  assert.equal(conflict?.path, repoSkillPath);
  // Read-only: existing repo skill untouched.
  assert.equal(await readFile(path.join(repoSkillPath, "SKILL.md"), "utf8"), "---\nname: new-skill\n---\n# existing\n");
});

test("promote dry-run reports unsupported_layout when the target has no SKILL.md", async (t) => {
  const sourceRoot = await makeRepo(t);
  const { skillPath } = await makeTargetSkill(t, { withSkillFile: false });

  const result = await planPromote({ source: sourceRoot, targetSkill: skillPath });

  assert.equal(result.ok, false);
  assert.ok(result.conflicts.some((entry) => entry.code === "unsupported_layout"));
});

test("promote dry-run reports unsupported_layout when the target directory is missing", async (t) => {
  const sourceRoot = await makeRepo(t);
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-promote-missing-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const missing = path.join(home, "skills", "ghost");

  const result = await planPromote({ source: sourceRoot, targetSkill: missing });

  assert.equal(result.ok, false);
  assert.ok(result.conflicts.some((entry) => entry.code === "unsupported_layout"));
});

test("promote dry-run reports dirty_target when the target skill root is itself a symlink", async (t) => {
  const sourceRoot = await makeRepo(t);
  const realDir = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-promote-real-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-promote-symroot-"));
  t.after(() => rm(realDir, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(realDir, "SKILL.md"), "---\nname: linked\n---\n# linked\n");
  await mkdir(path.join(home, "skills"), { recursive: true });
  const skillPath = path.join(home, "skills", "linked");
  await symlink(realDir, skillPath, "dir");

  const result = await planPromote({ source: sourceRoot, targetSkill: skillPath });

  assert.equal(result.ok, false);
  assert.ok(result.conflicts.some((entry) => entry.code === "dirty_target"));
  // Read-only: the symlink is left in place.
  assert.equal((await lstat(skillPath)).isSymbolicLink(), true);
});

test("promote dry-run reports dirty_target when the target tree contains a nested symlink", async (t) => {
  const sourceRoot = await makeRepo(t);
  const { skillPath } = await makeTargetSkill(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-promote-nested-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "payload.txt"), "x\n");
  await symlink(outside, path.join(skillPath, "nested"), "dir");

  const result = await planPromote({ source: sourceRoot, targetSkill: skillPath });

  assert.equal(result.ok, false);
  assert.ok(result.conflicts.some((entry) => entry.code === "dirty_target"));
});

test("promote dry-run reports unsafe_path when the target skill already lives inside the source repo", async (t) => {
  const sourceRoot = await makeRepo(t);
  const insidePath = path.join(sourceRoot, "skills", "already-here");
  await mkdir(insidePath, { recursive: true });
  await writeFile(path.join(insidePath, "SKILL.md"), "---\nname: already-here\n---\n# already-here\n");

  const result = await planPromote({ source: sourceRoot, targetSkill: insidePath });

  assert.equal(result.ok, false);
  assert.ok(result.conflicts.some((entry) => entry.code === "unsafe_path"));
});

test("promote dry-run reports unsupported_layout when the source root is missing", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-promote-missing-src-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sourceRoot = path.join(parent, "typo");
  const { skillPath } = await makeTargetSkill(t);

  const result = await planPromote({ source: sourceRoot, targetSkill: skillPath });

  assert.equal(result.ok, false);
  const conflict = result.conflicts.find((entry) => entry.path === sourceRoot);
  assert.equal(conflict?.code, "unsupported_layout");
});

test("promote dry-run reports unsafe_path when the repo destination is inside the target skill", async (t) => {
  const { skillPath } = await makeTargetSkill(t);
  const sourceRoot = path.join(skillPath, "catalog");
  await mkdir(path.join(sourceRoot, "skills"), { recursive: true });

  const result = await planPromote({ source: sourceRoot, targetSkill: skillPath });

  assert.equal(result.ok, false);
  const conflict = result.conflicts.find((entry) => entry.path === path.join(sourceRoot, "skills", "new-skill"));
  assert.equal(conflict?.code, "unsafe_path");
});

test("promote dry-run reports unsafe_path when catalog skills symlink escapes the source root", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-promote-src-"));
  const escapedSkillsRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-promote-escaped-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(escapedSkillsRoot, { recursive: true, force: true }));
  await symlink(escapedSkillsRoot, path.join(sourceRoot, "skills"), "dir");
  const { skillPath } = await makeTargetSkill(t);

  const result = await planPromote({ source: sourceRoot, targetSkill: skillPath });

  assert.equal(result.ok, false);
  const conflict = result.conflicts.find((entry) => entry.path === path.join(sourceRoot, "skills"));
  assert.equal(conflict?.code, "unsafe_path");
  await assert.rejects(stat(path.join(escapedSkillsRoot, "new-skill")));
});

test("promote --apply refuses when catalog skills symlink resolves inside the target skill", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-promote-src-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  const { skillPath } = await makeTargetSkill(t);
  const linkedSkillsRoot = path.join(skillPath, "linked-catalog-skills");
  await mkdir(linkedSkillsRoot, { recursive: true });
  await symlink(linkedSkillsRoot, path.join(sourceRoot, "skills"), "dir");

  const result = await executePromote({ source: sourceRoot, targetSkill: skillPath });

  assert.equal(result.ok, false);
  assert.ok(result.conflicts.some((entry) => entry.code === "unsafe_path"));
  assert.equal((await lstat(skillPath)).isDirectory(), true);
  assert.equal((await lstat(skillPath)).isSymbolicLink(), false);
  await assert.rejects(stat(path.join(linkedSkillsRoot, "new-skill")));
});

test("promote dry-run collects multiple machine-readable conflicts at once", async (t) => {
  const sourceRoot = await makeRepo(t);
  const { skillPath } = await makeTargetSkill(t, { withSkillFile: false });
  const repoSkillPath = path.join(sourceRoot, "skills", "new-skill");
  await mkdir(repoSkillPath, { recursive: true });
  await writeFile(path.join(repoSkillPath, "SKILL.md"), "---\nname: new-skill\n---\n# existing\n");

  const result = await planPromote({ source: sourceRoot, targetSkill: skillPath });

  assert.equal(result.ok, false);
  const codes = result.conflicts.map((entry) => entry.code).sort();
  assert.ok(codes.includes("existing_repo_skill"));
  assert.ok(codes.includes("unsupported_layout"));
  assert.equal(result.summary.conflicts, result.conflicts.length);
});

test("promote command is registered and parses dry-run plan arguments", () => {
  const fixtureSource = `${process.cwd()}/tests/fixtures/skills-catalog`;
  const dispatched = dispatchCommand([
    "promote",
    "--source",
    fixtureSource,
    "--target-skill",
    "/tmp/does-not-matter-for-parse",
    "--dry-run",
    "--json"
  ]);
  assert.ok(dispatched instanceof Promise);
});

test("promote command dispatch returns a successful dry-run plan with exit code 0", async (t) => {
  const sourceRoot = await makeRepo(t);
  const { skillPath } = await makeTargetSkill(t);

  const dispatched = await dispatchCommand([
    "promote",
    "--source",
    sourceRoot,
    "--target-skill",
    skillPath,
    "--dry-run",
    "--json"
  ]);

  assert.equal(dispatched.type, "result");
  if (dispatched.type !== "result") {
    return;
  }
  assert.equal(dispatched.exitCode, 0);
  const result = dispatched.result as Awaited<ReturnType<typeof planPromote>>;
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.skillName, "new-skill");
});

test("promote command dispatch surfaces conflicts with exit code 1", async (t) => {
  const sourceRoot = await makeRepo(t);
  const { skillPath } = await makeTargetSkill(t, { withSkillFile: false });

  const dispatched = await dispatchCommand([
    "promote",
    "--source",
    sourceRoot,
    "--target-skill",
    skillPath,
    "--dry-run",
    "--json"
  ]);

  assert.equal(dispatched.type, "result");
  if (dispatched.type !== "result") {
    return;
  }
  assert.equal(dispatched.exitCode, 1);
  const result = dispatched.result as Awaited<ReturnType<typeof planPromote>>;
  assert.equal(result.ok, false);
});

test("promote --apply copies the target into the catalog, symlinks the target back, and writes a receipt", async (t) => {
  const sourceRoot = await makeRepo(t);
  const { home, skillPath } = await makeTargetSkill(t);
  const repoSkillPath = path.join(sourceRoot, "skills", "new-skill");

  const result = await executePromote({ source: sourceRoot, targetSkill: skillPath });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.skillName, "new-skill");
  assert.equal(result.repoSkillPath, repoSkillPath);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.steps.map((step) => step.action), ["copy", "verify", "symlink", "receipt"]);

  // The catalog now owns a real directory copy with identical content.
  assert.equal((await lstat(repoSkillPath)).isDirectory(), true);
  assert.equal((await lstat(repoSkillPath)).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(repoSkillPath, "SKILL.md"), "utf8"), "---\nname: new-skill\n---\n# new-skill\n");
  assert.equal(await readFile(path.join(repoSkillPath, "runtime.js"), "utf8"), `console.log("new-skill");\n`);

  // The agent-home path is now a symlink back to the catalog source.
  const targetInfo = await lstat(skillPath);
  assert.equal(targetInfo.isSymbolicLink(), true);
  assert.equal(await realpath(skillPath), await realpath(repoSkillPath));

  // A receipt records the promotion as a symlink install with source provenance.
  const receiptPath = path.join(home, "skills", ".skill-suitcase-receipt.json");
  assert.equal(result.receiptPath, receiptPath);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: Record<string, { mode: string; sourcePath: string; targetPath: string; sourceHash?: string }>;
  };
  const record = receipt.installs["new-skill"]!;
  assert.equal(record.mode, "symlink");
  assert.equal(record.sourcePath, repoSkillPath);
  assert.equal(record.targetPath, skillPath);
  assert.ok(typeof record.sourceHash === "string" && record.sourceHash.length > 0);

  // The original target state is preserved (trashable) for rollback.
  assert.ok(typeof result.backupPath === "string");
  assert.equal(await readFile(path.join(result.backupPath as string, "SKILL.md"), "utf8"), "---\nname: new-skill\n---\n# new-skill\n");
});

test("promote --apply leaves the original target untouched when it fails before the swap", async (t) => {
  const sourceRoot = await makeRepo(t);
  const { skillPath } = await makeTargetSkill(t);
  const repoSkillPath = path.join(sourceRoot, "skills", "new-skill");

  const result = await executePromote({
    source: sourceRoot,
    targetSkill: skillPath,
    __test: { failBeforeSwap: true }
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);

  // The target is still the original real directory with its files.
  const targetInfo = await lstat(skillPath);
  assert.equal(targetInfo.isDirectory(), true);
  assert.equal(targetInfo.isSymbolicLink(), false);
  assert.equal(await readFile(path.join(skillPath, "SKILL.md"), "utf8"), "---\nname: new-skill\n---\n# new-skill\n");
  assert.equal(await readFile(path.join(skillPath, "runtime.js"), "utf8"), `console.log("new-skill");\n`);

  // The catalog copy was rolled back and no receipt was written.
  await assert.rejects(stat(repoSkillPath));
  await assert.rejects(stat(path.join(path.dirname(skillPath), ".skill-suitcase-receipt.json")));
});

test("promote --apply restores the original target when the swap fails after backup", async (t) => {
  const sourceRoot = await makeRepo(t);
  const { skillPath } = await makeTargetSkill(t);
  const repoSkillPath = path.join(sourceRoot, "skills", "new-skill");

  const result = await executePromote({
    source: sourceRoot,
    targetSkill: skillPath,
    __test: { failAfterBackup: true }
  });

  assert.equal(result.ok, false);
  const targetInfo = await lstat(skillPath);
  assert.equal(targetInfo.isDirectory(), true);
  assert.equal(targetInfo.isSymbolicLink(), false);
  assert.equal(await readFile(path.join(skillPath, "SKILL.md"), "utf8"), "---\nname: new-skill\n---\n# new-skill\n");
  await assert.rejects(stat(repoSkillPath));
});

test("promote --apply restores the existing receipt when receipt persistence fails", async (t) => {
  const sourceRoot = await makeRepo(t);
  const { home, skillPath } = await makeTargetSkill(t);
  const repoSkillPath = path.join(sourceRoot, "skills", "new-skill");
  const receiptPath = path.join(home, "skills", ".skill-suitcase-receipt.json");
  const beforeReceipt = `${JSON.stringify({
    schema: "calvinnwq.skills.receipt.v0",
    source: {
      repo: sourceRoot,
      ref: null,
      commit: null
    },
    installs: {}
  }, null, 2)}\n`;
  await writeFile(receiptPath, beforeReceipt, "utf8");

  const result = await executePromote({
    source: sourceRoot,
    targetSkill: skillPath,
    __test: { corruptReceiptBeforeFailure: true }
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "promote_receipt_failed"));
  assert.equal(await readFile(receiptPath, "utf8"), beforeReceipt);
  assert.equal((await lstat(skillPath)).isDirectory(), true);
  assert.equal((await lstat(skillPath)).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(skillPath, "SKILL.md"), "utf8"), "---\nname: new-skill\n---\n# new-skill\n");
  await assert.rejects(stat(repoSkillPath));
});

test("promote --apply refuses without mutating when the catalog already has the skill", async (t) => {
  const sourceRoot = await makeRepo(t);
  const { skillPath } = await makeTargetSkill(t);
  const repoSkillPath = path.join(sourceRoot, "skills", "new-skill");
  await mkdir(repoSkillPath, { recursive: true });
  await writeFile(path.join(repoSkillPath, "SKILL.md"), "---\nname: new-skill\n---\n# existing\n");

  const result = await executePromote({ source: sourceRoot, targetSkill: skillPath });

  assert.equal(result.ok, false);
  assert.ok(result.conflicts.some((entry) => entry.code === "existing_repo_skill"));
  // Existing repo skill untouched; the target is still a real directory.
  assert.equal(await readFile(path.join(repoSkillPath, "SKILL.md"), "utf8"), "---\nname: new-skill\n---\n# existing\n");
  assert.equal((await lstat(skillPath)).isSymbolicLink(), false);
});

test("promote --apply refuses a missing source root without mutating target files", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-promote-apply-missing-src-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sourceRoot = path.join(parent, "typo");
  const { skillPath } = await makeTargetSkill(t);

  const result = await executePromote({ source: sourceRoot, targetSkill: skillPath });

  assert.equal(result.ok, false);
  assert.ok(result.conflicts.some((entry) => entry.path === sourceRoot && entry.code === "unsupported_layout"));
  await assert.rejects(stat(sourceRoot));
  assert.equal((await lstat(skillPath)).isDirectory(), true);
  assert.equal((await lstat(skillPath)).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(skillPath, "SKILL.md"), "utf8"), "---\nname: new-skill\n---\n# new-skill\n");
});

test("promote --apply command dispatch performs a live promote with exit code 0", async (t) => {
  const sourceRoot = await makeRepo(t);
  const { skillPath } = await makeTargetSkill(t);

  const dispatched = await dispatchCommand([
    "promote",
    "--source",
    sourceRoot,
    "--target-skill",
    skillPath,
    "--apply",
    "--json"
  ]);

  assert.equal(dispatched.type, "result");
  if (dispatched.type !== "result") {
    return;
  }
  assert.equal(dispatched.exitCode, 0);
  const result = dispatched.result as Awaited<ReturnType<typeof executePromote>>;
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal((await lstat(skillPath)).isSymbolicLink(), true);
});

test("promote command does not accept --apply combined with --dry-run", async () => {
  const dispatched = await dispatchCommand([
    "promote",
    "--source",
    "/tmp/does-not-matter",
    "--target-skill",
    "/tmp/also-irrelevant",
    "--dry-run",
    "--apply",
    "--json"
  ]);

  assert.equal(dispatched.type, "usage");
});

test("the --apply flag is rejected for commands other than promote", () => {
  assert.throws(
    () => parseCommandArgs(["pack", "--source", "/x", "--target", "openclaw", "--apply"]),
    /Unknown argument: --apply/
  );
});
