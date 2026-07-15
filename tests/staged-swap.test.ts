import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  beginStagedSwap,
  hashDirectory,
  listDirectories,
  listFiles,
  recoverSwappedTarget,
  transactionDirectoryForTarget,
  type StagedSwapContext
} from "../src/core/staged-swap.js";

async function makeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
}

async function readTree(root: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const relativePath of await listFiles(root)) {
    tree[relativePath] = await readFile(path.join(root, relativePath), "utf8");
  }
  return tree;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

type FixtureOverrides = Partial<Omit<StagedSwapContext, "installRoot" | "sourcePath" | "targetPath" | "backupPath" | "stagingPath">>;

async function makeFixture(t: { after: (fn: () => Promise<void> | void) => void }, overrides: FixtureOverrides = {}): Promise<{
  root: string;
  installRoot: string;
  sourcePath: string;
  targetPath: string;
  backupPath: string;
  stagingPath: string;
  context: StagedSwapContext;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-staged-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const installRoot = path.join(root, "install-root");
  const sourcePath = path.join(root, "catalog", "demo-skill");
  const targetPath = path.join(installRoot, "demo-skill");
  await makeTree(sourcePath, { "SKILL.md": "catalog content\n", "references/notes.md": "catalog notes\n" });
  await makeTree(targetPath, { "SKILL.md": "dirty content\n", "extra.md": "local extra\n" });

  const transactionDirectory = transactionDirectoryForTarget(targetPath, installRoot);
  const backupPath = path.join(transactionDirectory, ".demo-skill.suitcase-pre-repair-test");
  const stagingPath = path.join(transactionDirectory, ".demo-skill.suitcase-repair-next-test");
  const context: StagedSwapContext = {
    installRoot,
    sourcePath,
    targetPath,
    backupPath,
    stagingPath,
    workflow: "repair",
    requireDirectoryParents: false,
    ...overrides
  };
  return { root, installRoot, sourcePath, targetPath, backupPath, stagingPath, context };
}

test("staged swap replaces the target from source and preserves the backup", async (t) => {
  const fixture = await makeFixture(t);
  const swap = beginStagedSwap(fixture.context);

  await swap.stageSourceTree();
  assert.deepEqual(await readTree(fixture.stagingPath), await readTree(fixture.sourcePath));
  assert.equal(await swap.stagedTreeMatchesSource(), true);
  await swap.moveTargetToBackup();
  await swap.installStagedTree();

  assert.deepEqual(await readTree(fixture.targetPath), {
    "SKILL.md": "catalog content\n",
    "references/notes.md": "catalog notes\n"
  });
  assert.deepEqual(await readTree(fixture.backupPath), {
    "SKILL.md": "dirty content\n",
    "extra.md": "local extra\n"
  });
  assert.equal(await pathExists(fixture.stagingPath), false);
  assert.equal(await hashDirectory(fixture.targetPath), await hashDirectory(fixture.sourcePath));
});

test("staged tree verification reports a mismatch before the target is touched", async (t) => {
  const fixture = await makeFixture(t);
  const swap = beginStagedSwap(fixture.context);

  await swap.stageSourceTree();
  await writeFile(path.join(fixture.stagingPath, "SKILL.md"), "tampered staged copy\n", "utf8");

  assert.equal(await swap.stagedTreeMatchesSource(), false);
  assert.deepEqual(await readTree(fixture.targetPath), {
    "SKILL.md": "dirty content\n",
    "extra.md": "local extra\n"
  });
});

test("staging honors source-policy excludes and still verifies against the source", async (t) => {
  const fixture = await makeFixture(t, { sourcePolicy: { exclude: ["references/**"] } });
  await makeTree(fixture.sourcePath, { "references/cache.md": "generated\n" });
  const swap = beginStagedSwap(fixture.context);

  await swap.stageSourceTree();
  assert.deepEqual(Object.keys(await readTree(fixture.stagingPath)), ["SKILL.md"]);
  assert.equal(await swap.stagedTreeMatchesSource(), true);
});

test("staging refuses a source-policy denied path before any target mutation", async (t) => {
  const fixture = await makeFixture(t, { sourcePolicy: { deny: ["references/notes.md"] } });
  const swap = beginStagedSwap(fixture.context);

  await assert.rejects(swap.stageSourceTree(), /source policy denies paths/);
  assert.deepEqual(await readTree(fixture.targetPath), {
    "SKILL.md": "dirty content\n",
    "extra.md": "local extra\n"
  });
});

test("recovery before backup removes the staged copy and reports no errors", async (t) => {
  const fixture = await makeFixture(t);
  const swap = beginStagedSwap(fixture.context);

  await swap.stageSourceTree();
  const recovery = await swap.recoverAfterFailure();

  assert.deepEqual(recovery, { errors: [], backupRetained: false });
  assert.equal(await pathExists(fixture.stagingPath), false);
  assert.deepEqual(await readTree(fixture.targetPath), {
    "SKILL.md": "dirty content\n",
    "extra.md": "local extra\n"
  });
});

test("recovery after backup restores the original target", async (t) => {
  const fixture = await makeFixture(t);
  const swap = beginStagedSwap(fixture.context);

  await swap.stageSourceTree();
  await swap.moveTargetToBackup();
  const recovery = await swap.recoverAfterFailure();

  assert.deepEqual(recovery, { errors: [], backupRetained: false });
  assert.equal(await pathExists(fixture.stagingPath), false);
  assert.equal(await pathExists(fixture.backupPath), false);
  assert.deepEqual(await readTree(fixture.targetPath), {
    "SKILL.md": "dirty content\n",
    "extra.md": "local extra\n"
  });
});

test("recovery after install removes the installed tree and restores the backup", async (t) => {
  const fixture = await makeFixture(t);
  const swap = beginStagedSwap(fixture.context);

  await swap.stageSourceTree();
  await swap.moveTargetToBackup();
  await swap.installStagedTree();
  const recovery = await swap.recoverAfterFailure();

  assert.deepEqual(recovery, { errors: [], backupRetained: false });
  assert.equal(await pathExists(fixture.backupPath), false);
  assert.deepEqual(await readTree(fixture.targetPath), {
    "SKILL.md": "dirty content\n",
    "extra.md": "local extra\n"
  });
});

test("incomplete recovery retains the backup and reports structured facts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-staged-swap-incomplete-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const installRoot = path.join(root, "install-root");
  const sourcePath = path.join(root, "catalog", "demo-skill");
  const targetPath = path.join(installRoot, "nested", "demo-skill");
  await makeTree(sourcePath, { "SKILL.md": "catalog content\n" });
  await makeTree(targetPath, { "SKILL.md": "dirty content\n" });

  const transactionDirectory = transactionDirectoryForTarget(targetPath, installRoot);
  const backupPath = path.join(transactionDirectory, ".demo-skill.suitcase-pre-repair-test");
  const stagingPath = path.join(transactionDirectory, ".demo-skill.suitcase-repair-next-test");
  const swap = beginStagedSwap({
    installRoot,
    sourcePath,
    targetPath,
    backupPath,
    stagingPath,
    workflow: "repair",
    requireDirectoryParents: false
  });

  await swap.stageSourceTree();
  await swap.moveTargetToBackup();
  await swap.installStagedTree();

  const nestedParent = path.join(installRoot, "nested");
  const relocatedParent = path.join(root, "relocated-nested");
  await rename(nestedParent, relocatedParent);
  await symlink(relocatedParent, nestedParent);

  const recovery = await swap.recoverAfterFailure();
  assert.equal(recovery.backupRetained, true);
  assert.equal(recovery.errors.length, 2);
  assert.match(recovery.errors[0] ?? "", /Could not safely remove failed repair target .*is a symlink/);
  assert.match(recovery.errors[1] ?? "", /Backup retained at .* could not be safely cleared\./);
  assert.deepEqual(await readTree(backupPath), { "SKILL.md": "dirty content\n" });
});

test("staged copy cleanup failure retains the copy and reports the fact", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-staged-swap-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const installRoot = path.join(root, "install-root");
  const sourcePath = path.join(root, "catalog", "demo-skill");
  const targetPath = path.join(installRoot, "nested", "demo-skill");
  await makeTree(sourcePath, { "SKILL.md": "catalog content\n" });
  await makeTree(targetPath, { "SKILL.md": "dirty content\n" });

  const transactionDirectory = transactionDirectoryForTarget(targetPath, installRoot);
  const backupPath = path.join(transactionDirectory, ".demo-skill.suitcase-pre-reconcile-test");
  const stagingPath = path.join(transactionDirectory, ".demo-skill.suitcase-reconcile-next-test");
  const swap = beginStagedSwap({
    installRoot,
    sourcePath,
    targetPath,
    backupPath,
    stagingPath,
    workflow: "reconcile",
    requireDirectoryParents: true
  });

  await swap.stageSourceTree();

  const relocatedArchive = path.join(root, "relocated-archive");
  await rename(transactionDirectory, relocatedArchive);
  await symlink(relocatedArchive, transactionDirectory);

  const recovery = await swap.recoverAfterFailure();
  assert.equal(recovery.backupRetained, false);
  assert.equal(recovery.errors.length, 1);
  assert.match(recovery.errors[0] ?? "", /Temporary reconcile copy retained at .*is a symlink/);
  assert.deepEqual(await readTree(path.join(relocatedArchive, path.basename(stagingPath))), {
    "SKILL.md": "catalog content\n"
  });
});

test("strict parent guard rejects a non-directory parent component; lenient guard does not", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-staged-swap-parent-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const installRoot = path.join(root, "install-root");
  const sourcePath = path.join(root, "catalog", "demo-skill");
  await makeTree(sourcePath, { "SKILL.md": "catalog content\n" });
  await mkdir(installRoot, { recursive: true });
  await writeFile(path.join(installRoot, "nested"), "a regular file\n", "utf8");
  const targetPath = path.join(installRoot, "nested", "demo-skill");
  const transactionDirectory = transactionDirectoryForTarget(targetPath, installRoot);
  const contextFor = (requireDirectoryParents: boolean) => ({
    installRoot,
    sourcePath,
    targetPath,
    backupPath: path.join(transactionDirectory, ".demo-skill.backup-test"),
    stagingPath: path.join(transactionDirectory, ".demo-skill.staging-test"),
    workflow: requireDirectoryParents ? "reconcile" : "repair",
    requireDirectoryParents
  });

  await assert.rejects(
    beginStagedSwap(contextFor(true)).stageSourceTree(),
    /Target parent component .* is not a directory\./
  );
  await assert.doesNotReject(beginStagedSwap(contextFor(false)).stageSourceTree());
});

test("symlink parent components are rejected by both guard variants", async (t) => {
  for (const requireDirectoryParents of [true, false]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-staged-swap-symlink-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const installRoot = path.join(root, "install-root");
    const sourcePath = path.join(root, "catalog", "demo-skill");
    const escapePath = path.join(root, "escape");
    await makeTree(sourcePath, { "SKILL.md": "catalog content\n" });
    await mkdir(installRoot, { recursive: true });
    await mkdir(escapePath, { recursive: true });
    await symlink(escapePath, path.join(installRoot, "nested"));
    const targetPath = path.join(installRoot, "nested", "demo-skill");
    const transactionDirectory = transactionDirectoryForTarget(targetPath, installRoot);

    await assert.rejects(
      beginStagedSwap({
        installRoot,
        sourcePath,
        targetPath,
        backupPath: path.join(transactionDirectory, ".demo-skill.backup-test"),
        stagingPath: path.join(transactionDirectory, ".demo-skill.staging-test"),
        workflow: "repair",
        requireDirectoryParents
      }).stageSourceTree(),
      /Target parent component .* is a symlink\./
    );
  }
});

test("reverse-order recovery restores multiple completed swaps", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-staged-swap-multi-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const installRoot = path.join(root, "install-root");
  const completed: Array<{ targetPath: string; backupPath: string }> = [];
  for (const skill of ["alpha-skill", "beta-skill"]) {
    const sourcePath = path.join(root, "catalog", skill);
    const targetPath = path.join(installRoot, skill);
    await makeTree(sourcePath, { "SKILL.md": `${skill} catalog\n` });
    await makeTree(targetPath, { "SKILL.md": `${skill} dirty\n` });
    const transactionDirectory = transactionDirectoryForTarget(targetPath, installRoot);
    const backupPath = path.join(transactionDirectory, `.${skill}.suitcase-pre-repair-test`);
    const swap = beginStagedSwap({
      installRoot,
      sourcePath,
      targetPath,
      backupPath,
      stagingPath: path.join(transactionDirectory, `.${skill}.suitcase-repair-next-test`),
      workflow: "repair",
      requireDirectoryParents: false
    });
    await swap.stageSourceTree();
    await swap.moveTargetToBackup();
    await swap.installStagedTree();
    completed.push({ targetPath, backupPath });
  }

  for (const swapState of completed.reverse()) {
    const errors = await recoverSwappedTarget({
      targetPath: swapState.targetPath,
      backupPath: swapState.backupPath,
      installed: true,
      backedUp: true,
      installRoot,
      requireDirectoryParents: false,
      workflow: "repair"
    });
    assert.deepEqual(errors, []);
  }

  assert.deepEqual(await readTree(path.join(installRoot, "alpha-skill")), { "SKILL.md": "alpha-skill dirty\n" });
  assert.deepEqual(await readTree(path.join(installRoot, "beta-skill")), { "SKILL.md": "beta-skill dirty\n" });
});

test("transaction directory selection and tree listing helpers stay deterministic", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-staged-swap-helpers-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const installRoot = path.join(root, "install-root");
  assert.equal(
    transactionDirectoryForTarget(path.join(installRoot, "demo-skill"), installRoot),
    installRoot
  );
  assert.equal(
    transactionDirectoryForTarget(path.join(installRoot, "category", "demo-skill"), installRoot),
    path.join(installRoot, ".archive")
  );

  const treeRoot = path.join(root, "tree");
  await makeTree(treeRoot, {
    "SKILL.md": "content\n",
    "references/notes.md": "notes\n",
    "references/deep/more.md": "more\n"
  });
  assert.deepEqual(await listFiles(treeRoot), [
    "SKILL.md",
    path.join("references", "deep", "more.md"),
    path.join("references", "notes.md")
  ]);
  assert.deepEqual(await listDirectories(treeRoot), [
    "references",
    path.join("references", "deep")
  ]);
  const entries = await readdir(treeRoot);
  assert.deepEqual(entries.sort(), ["SKILL.md", "references"]);
});
