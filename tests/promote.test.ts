import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dispatchCommand } from "../src/commands/index.js";
import { planPromote } from "../src/promote.js";

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
