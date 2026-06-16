import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  classifySymlinkInstall,
  isPathWithinRoot,
  SYMLINK_MODE
} from "../src/core/install-modes.js";

async function makeTempDir(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `skill-suitcase-install-modes-${label}-`));
}

test("exposes the symlink install mode constant", () => {
  assert.equal(SYMLINK_MODE, "symlink");
});

test("classifies a symlink pointing at the expected source as correct", async (t) => {
  const root = await makeTempDir("correct");
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceSkill = path.join(root, "source", "office-hours");
  const installRoot = path.join(root, "install");
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(installRoot, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\n---\n");
  const targetPath = path.join(installRoot, "office-hours");
  await symlink(sourceSkill, targetPath, "dir");

  const result = await classifySymlinkInstall({ targetPath, expectedSourcePath: sourceSkill });

  assert.equal(result.state, "correct");
  assert.equal(result.linkTarget, path.resolve(sourceSkill));
});

test("classifies a symlink pointing at a different existing path as wrong-target", async (t) => {
  const root = await makeTempDir("wrong-target");
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceSkill = path.join(root, "source", "office-hours");
  const otherSkill = path.join(root, "source", "skillify");
  const installRoot = path.join(root, "install");
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(otherSkill, { recursive: true });
  await mkdir(installRoot, { recursive: true });
  const targetPath = path.join(installRoot, "office-hours");
  await symlink(otherSkill, targetPath, "dir");

  const result = await classifySymlinkInstall({ targetPath, expectedSourcePath: sourceSkill });

  assert.equal(result.state, "wrong-target");
  assert.equal(result.linkTarget, path.resolve(otherSkill));
});

test("classifies a symlink whose target does not exist as broken", async (t) => {
  const root = await makeTempDir("broken");
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceSkill = path.join(root, "source", "office-hours");
  const installRoot = path.join(root, "install");
  await mkdir(installRoot, { recursive: true });
  const targetPath = path.join(installRoot, "office-hours");
  await symlink(sourceSkill, targetPath, "dir");

  const result = await classifySymlinkInstall({ targetPath, expectedSourcePath: sourceSkill });

  assert.equal(result.state, "broken");
  assert.equal(result.linkTarget, path.resolve(sourceSkill));
});

test("classifies a real directory where a symlink is expected as real-directory", async (t) => {
  const root = await makeTempDir("real-dir");
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceSkill = path.join(root, "source", "office-hours");
  const installRoot = path.join(root, "install");
  await mkdir(sourceSkill, { recursive: true });
  const targetPath = path.join(installRoot, "office-hours");
  await mkdir(targetPath, { recursive: true });
  await writeFile(path.join(targetPath, "SKILL.md"), "---\nname: office-hours\n---\n");

  const result = await classifySymlinkInstall({ targetPath, expectedSourcePath: sourceSkill });

  assert.equal(result.state, "real-directory");
  assert.equal(result.linkTarget, null);
});

test("classifies a missing target path as missing", async (t) => {
  const root = await makeTempDir("missing");
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceSkill = path.join(root, "source", "office-hours");
  const installRoot = path.join(root, "install");
  await mkdir(installRoot, { recursive: true });
  const targetPath = path.join(installRoot, "office-hours");

  const result = await classifySymlinkInstall({ targetPath, expectedSourcePath: sourceSkill });

  assert.equal(result.state, "missing");
  assert.equal(result.linkTarget, null);
});

test("treats a source nested inside the approved root as within the root", () => {
  const root = path.join("/catalog", "repo");
  const sourcePath = path.join(root, "skills", "office-hours");

  assert.equal(isPathWithinRoot({ candidatePath: sourcePath, rootPath: root }), true);
});

test("treats the approved root itself as within the root", () => {
  const root = path.join("/catalog", "repo");

  assert.equal(isPathWithinRoot({ candidatePath: root, rootPath: root }), true);
});

test("rejects a source that escapes the approved root via ..", () => {
  const root = path.join("/catalog", "repo");
  const sourcePath = path.join(root, "skills", "..", "..", "..", "etc", "evil");

  assert.equal(isPathWithinRoot({ candidatePath: sourcePath, rootPath: root }), false);
});

test("rejects a sibling that only shares a name prefix with the approved root", () => {
  const root = path.join("/catalog", "repo");
  const sibling = path.join("/catalog", "repo-evil", "skills", "office-hours");

  assert.equal(isPathWithinRoot({ candidatePath: sibling, rootPath: root }), false);
});

test("classifies a regular file where a symlink is expected as not-symlink", async (t) => {
  const root = await makeTempDir("not-symlink");
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceSkill = path.join(root, "source", "office-hours");
  const installRoot = path.join(root, "install");
  await mkdir(installRoot, { recursive: true });
  const targetPath = path.join(installRoot, "office-hours");
  await writeFile(targetPath, "not a skill directory\n");

  const result = await classifySymlinkInstall({ targetPath, expectedSourcePath: sourceSkill });

  assert.equal(result.state, "not-symlink");
  assert.equal(result.linkTarget, null);
});
