import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RECEIPT_FILE } from "../src/receipt.js";
import { importTarget } from "../src/import-target.js";
import { status } from "../src/status.js";
import { track } from "../src/track.js";

const CATALOG_RUNTIME = "console.log(\"catalog\");\n";
const SKILL_MD = "---\nname: skill-cleaner\nversion: 2026.06.17\n---\n# Skill Cleaner\n";
const LOCAL_RUNTIME = "console.log(\"locally edited\");\n";
const LOCAL_EXTRA = "console.log(\"local extra\");\n";

type ImportFixture = {
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

async function createCatalog(t: { after(fn: () => Promise<void> | void): void }): Promise<ImportFixture> {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-target-"));
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
async function createTrackedFixture(t: { after(fn: () => Promise<void> | void): void }): Promise<ImportFixture> {
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

async function editTheTarget(fixture: ImportFixture): Promise<void> {
  await writeFile(path.join(fixture.targetSkill, "runtime.js"), LOCAL_RUNTIME);
  await writeFile(path.join(fixture.targetSkill, "extra.js"), LOCAL_EXTRA);
}

test("import-target dry-run plans importing a dirty receipt-owned skill into the catalog without mutating files", async (t) => {
  const fixture = await createTrackedFixture(t);
  await editTheTarget(fixture);

  const before = await status({ source: fixture.sourceRoot, target: "openclaw" });
  assert.equal(before.summary.dirty, 1, "precondition: target should be dirty");

  const result = await importTarget({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.target, "openclaw");
  assert.equal(result.assignment, "openclaw");
  assert.equal(result.installRoot, fixture.targetRoot);
  assert.deepEqual(result.selected.skills, ["skill-cleaner"]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.skill), ["skill-cleaner"]);

  const candidate = result.candidates[0];
  assert.ok(candidate !== undefined);
  assert.equal(candidate.status, "dirty");
  assert.equal(candidate.receiptState, "receipt-owned");
  assert.equal(candidate.targetSkillPath, fixture.targetSkill);
  assert.equal(candidate.catalogSkillPath, fixture.sourceSkill);
  assert.equal(candidate.finalAction, "replace-catalog-from-target");
  assert.equal(typeof candidate.receiptHash, "string");
  assert.equal(typeof candidate.catalogHash, "string");
  assert.equal(typeof candidate.targetHash, "string");
  assert.notEqual(candidate.targetHash, candidate.catalogHash);

  // The edited runtime.js updates the catalog; the new extra.js creates a catalog file.
  assert.equal(candidate.changes.update, 1);
  assert.equal(candidate.changes.create, 1);
  assert.equal(candidate.changes.delete, 0);

  const writesByPath = new Map(candidate.repoWrites.map((write) => [write.relativePath, write]));
  assert.equal(writesByPath.get("runtime.js")?.action, "update");
  assert.equal(writesByPath.get("runtime.js")?.catalogPath, path.join(fixture.sourceSkill, "runtime.js"));
  assert.equal(writesByPath.get("runtime.js")?.targetPath, path.join(fixture.targetSkill, "runtime.js"));
  assert.equal(writesByPath.get("extra.js")?.action, "create");
  assert.equal(writesByPath.get("extra.js")?.catalogPath, path.join(fixture.sourceSkill, "extra.js"));

  // Read-only: live target, catalog source, and receipt are all untouched.
  assert.equal(await readFile(path.join(fixture.targetSkill, "runtime.js"), "utf8"), LOCAL_RUNTIME);
  assert.equal(await readFile(path.join(fixture.sourceSkill, "runtime.js"), "utf8"), CATALOG_RUNTIME);
  await assert.rejects(readFile(path.join(fixture.sourceSkill, "extra.js"), "utf8"), /ENOENT/);
  assert.equal(result.imported.skills.length, 0);
  assert.equal(result.imported.files, 0);
  assert.equal(result.receiptPath, null);
});

test("import-target dry-run reports a catalog file the target dropped as a delete", async (t) => {
  const fixture = await createTrackedFixture(t);
  // Add a second catalog file, adopt it, then delete it from the live target so
  // importing the target would remove it from the catalog.
  await writeFile(path.join(fixture.sourceSkill, "helper.js"), "console.log(\"helper\");\n");
  await writeFile(path.join(fixture.targetSkill, "helper.js"), "console.log(\"helper\");\n");
  const retracked = await track({ source: fixture.sourceRoot, target: "openclaw", skills: ["skill-cleaner"] });
  assert.equal(retracked.ok, true);
  await rm(path.join(fixture.targetSkill, "helper.js"), { force: true });

  const result = await importTarget({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, true);
  const candidate = result.candidates[0];
  assert.ok(candidate !== undefined);
  assert.equal(candidate.changes.delete, 1);
  const deletion = candidate.repoWrites.find((write) => write.relativePath === "helper.js");
  assert.equal(deletion?.action, "delete");
  assert.equal(deletion?.catalogPath, path.join(fixture.sourceSkill, "helper.js"));
  // Read-only: the catalog file the import would remove still exists.
  assert.equal(await readFile(path.join(fixture.sourceSkill, "helper.js"), "utf8"), "console.log(\"helper\");\n");
});

test("import-target refuses a current skill as a no-op without mutating", async (t) => {
  const fixture = await createTrackedFixture(t);

  const result = await importTarget({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.errors.some((error) => error.code === "already_current" && error.skill === "skill-cleaner"), true);
  assert.equal(await readFile(path.join(fixture.sourceSkill, "runtime.js"), "utf8"), CATALOG_RUNTIME);
});

test("import-target refuses an unknown target and routes it to promote", async (t) => {
  const fixture = await createCatalog(t);
  await mkdir(fixture.targetSkill, { recursive: true });
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), SKILL_MD);
  await writeFile(path.join(fixture.targetSkill, "runtime.js"), "console.log(\"no receipt\");\n");

  const result = await importTarget({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 0);
  assert.equal(
    result.errors.some((error) => error.code === "route_to_promote" && error.skill === "skill-cleaner"),
    true
  );
  await assert.rejects(readFile(path.join(fixture.targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("import-target refuses a missing target and routes it to pack and apply", async (t) => {
  const fixture = await createCatalog(t);

  const result = await importTarget({
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

test("import-target refuses a behind target and routes it to pack and apply", async (t) => {
  const fixture = await createTrackedFixture(t);
  // Catalog moves ahead while the live target still matches its receipt.
  await writeFile(path.join(fixture.sourceSkill, "runtime.js"), "console.log(\"catalog moved ahead\");\n");

  const before = await status({ source: fixture.sourceRoot, target: "openclaw" });
  assert.equal(before.summary.behind, 1, "precondition: target should be behind");

  const result = await importTarget({
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

test("import-target refuses a dirty target whose catalog has also diverged", async (t) => {
  const fixture = await createTrackedFixture(t);
  await editTheTarget(fixture);
  await writeFile(path.join(fixture.sourceSkill, "runtime.js"), "console.log(\"catalog moved ahead\");\n");

  const before = await status({ source: fixture.sourceRoot, target: "openclaw" });
  const beforeItem = before.statuses.find((item) => item.skill === "skill-cleaner");
  assert.equal(beforeItem?.status, "dirty", "precondition: target should be dirty");
  assert.notEqual(beforeItem?.installedHash, beforeItem?.currentHash, "precondition: catalog should be diverged");

  const result = await importTarget({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 0);
  assert.equal(
    result.errors.some((error) => error.code === "catalog_diverged" && error.skill === "skill-cleaner"),
    true
  );
  // Read-only: neither the local edits nor the catalog are touched.
  assert.equal(await readFile(path.join(fixture.targetSkill, "runtime.js"), "utf8"), LOCAL_RUNTIME);
  assert.equal(await readFile(path.join(fixture.sourceSkill, "runtime.js"), "utf8"), "console.log(\"catalog moved ahead\");\n");
});

test("import-target refuses to import a dirty symlink-mode install", async (t) => {
  const fixture = await createCatalog(t);
  await symlink(fixture.sourceSkill, fixture.targetSkill, "dir");

  const tracked = await track({ source: fixture.sourceRoot, target: "openclaw", skills: ["skill-cleaner"] });
  assert.equal(tracked.ok, true, "fixture setup: track should adopt the symlink target");

  // Materialize the symlink into a real, locally-edited directory.
  await unlink(fixture.targetSkill);
  await mkdir(fixture.targetSkill, { recursive: true });
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), SKILL_MD);
  await writeFile(path.join(fixture.targetSkill, "runtime.js"), "console.log(\"locally materialized\");\n");

  const before = await status({ source: fixture.sourceRoot, target: "openclaw" });
  const beforeItem = before.statuses.find((item) => item.skill === "skill-cleaner");
  assert.equal(beforeItem?.status, "dirty", "precondition: symlink-mode install should be dirty");

  const result = await importTarget({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 0);
  assert.equal(
    result.errors.some((error) => error.code === "unsupported_install_mode" && error.skill === "skill-cleaner"),
    true
  );
});

test("import-target refuses read-only provider targets without touching the filesystem", async (t) => {
  const fixture = await createCatalog(t);
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-provider-home-"));
  t.after(() => rm(fakeHome, { recursive: true, force: true }));

  const result = await importTarget({
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

test("import-target refuses a dirty target whose tree contains a symlink", async (t) => {
  const fixture = await createTrackedFixture(t);
  await writeFile(path.join(fixture.targetSkill, "runtime.js"), LOCAL_RUNTIME);
  await symlink(path.join(fixture.targetRoot), path.join(fixture.targetSkill, "escape"), "dir");

  const result = await importTarget({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 0);
  assert.equal(
    result.errors.some((error) => error.code === "unsafe_target_tree" && error.skill === "skill-cleaner"),
    true
  );
});

test("import-target refuses a dirty target whose catalog tree contains a symlink", async (t) => {
  const fixture = await createTrackedFixture(t);
  await writeFile(path.join(fixture.targetSkill, "runtime.js"), LOCAL_RUNTIME);
  await symlink(path.join(fixture.sourceRoot), path.join(fixture.sourceSkill, "escape"), "dir");

  const result = await importTarget({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 0);
  assert.equal(
    result.errors.some((error) => error.code === "unsafe_catalog_tree" && error.skill === "skill-cleaner"),
    true
  );
});

test("import-target requires at least one explicitly selected skill", async (t) => {
  const fixture = await createTrackedFixture(t);

  const result = await importTarget({
    source: fixture.sourceRoot,
    target: "openclaw",
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "invalid_skill_filter"), true);
});

test("import-target requires exactly one of dry-run or apply", async (t) => {
  const fixture = await createTrackedFixture(t);
  await editTheTarget(fixture);

  const neither = await importTarget({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"]
  });
  assert.equal(neither.ok, false);
  assert.equal(neither.errors.some((error) => error.code === "invalid_import_mode"), true);

  const both = await importTarget({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    dryRun: true,
    apply: true
  });
  assert.equal(both.ok, false);
  assert.equal(both.errors.some((error) => error.code === "invalid_import_mode"), true);
});

test("import-target apply is not yet implemented and mutates nothing", async (t) => {
  const fixture = await createTrackedFixture(t);
  await editTheTarget(fixture);

  const result = await importTarget({
    source: fixture.sourceRoot,
    target: "openclaw",
    skills: ["skill-cleaner"],
    apply: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsupported_import_mode"), true);
  // Read-only: the catalog is untouched and no extra.js leaked into the repo.
  assert.equal(await readFile(path.join(fixture.sourceSkill, "runtime.js"), "utf8"), CATALOG_RUNTIME);
  await assert.rejects(readFile(path.join(fixture.sourceSkill, "extra.js"), "utf8"), /ENOENT/);
});
