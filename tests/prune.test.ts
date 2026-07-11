import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { prune, PRUNE_TRANSACTION_SCHEMA } from "../src/prune.js";
import {
  buildInstallRecord,
  buildInstalledFiles,
  readReceipt,
  writeReceipt
} from "../src/receipt.js";

type Fixture = {
  sourceRoot: string;
  targetRoot: string;
  directoryTarget: string;
  symlinkTarget: string;
};

async function createFixture(t: { after(fn: () => Promise<void> | void): void }): Promise<Fixture> {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-prune-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-prune-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  for (const skill of ["current", "dir-old", "link-old"]) {
    await mkdir(path.join(sourceRoot, "skills", skill), { recursive: true });
    await writeFile(path.join(sourceRoot, "skills", skill, "SKILL.md"), `---\nname: ${skill}\n---\n# ${skill}\n`);
  }
  await writeFile(path.join(sourceRoot, "skill-suitcase.yaml"), `suitcases:
  core:
    skills:
      - current

assignments:
  codex:
    suitcases:
      - core

assignmentPaths:
  codex:
    kind: codex-home
    assignment: codex
    codexHome: ${path.dirname(targetRoot)}
    skillsPath: ${targetRoot}

compatibility:
  current:
    agents:
      - codex
`);

  const directoryTarget = path.join(targetRoot, "dir-old");
  const symlinkTarget = path.join(targetRoot, "link-old");
  await mkdir(directoryTarget);
  await writeFile(path.join(directoryTarget, "SKILL.md"), "---\nname: dir-old\n---\n# dir-old\n");
  const linkSource = path.join(sourceRoot, "skills", "link-old");
  await symlink(linkSource, symlinkTarget);

  await writeReceipt({
    installRoot: targetRoot,
    receipt: {
      installs: {
        "dir-old": buildInstallRecord({
          skill: "dir-old", agent: "codex", target: "codex", mode: "copy",
          sourcePath: path.join(sourceRoot, "skills", "dir-old"), targetPath: directoryTarget,
          sourceHash: "dir-source", installedFiles: await buildInstalledFiles(directoryTarget)
        }),
        "link-old": buildInstallRecord({
          skill: "link-old", agent: "codex", target: "codex", mode: "symlink",
          sourcePath: linkSource, targetPath: symlinkTarget, sourceHash: "link-source",
          installedFiles: await buildInstalledFiles(linkSource)
        })
      }
    }
  });
  return { sourceRoot, targetRoot, directoryTarget, symlinkTarget };
}

test("prune dry-run plans explicit obsolete directory and symlink without mutation", async (t) => {
  const fixture = await createFixture(t);
  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["link-old", "dir-old"],
    dryRun: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.summary.directories, 1);
  assert.equal(result.summary.symlinks, 1);
  assert.equal(typeof result.plan.id, "string");
  assert.deepEqual(result.candidates.map((candidate) => [candidate.skill, candidate.kind]), [
    ["dir-old", "directory"],
    ["link-old", "symlink"]
  ]);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
  assert.equal(await readlink(fixture.symlinkTarget), path.join(fixture.sourceRoot, "skills", "link-old"));
  assert.equal(result.transactionPath, null);
});

test("prune apply quarantines directories, removes symlinks, and updates receipt", async (t) => {
  const fixture = await createFixture(t);
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old", "link-old"], dryRun: true });
  assert.ok(dryRun.plan.id);

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old", "link-old"],
    planId: dryRun.plan.id,
    apply: true
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.pruned, { skills: ["dir-old", "link-old"], directories: 1, symlinks: 1 });
  await assert.rejects(stat(fixture.directoryTarget), /ENOENT/);
  await assert.rejects(stat(fixture.symlinkTarget), /ENOENT/);
  const quarantined = result.candidates.find((candidate) => candidate.skill === "dir-old")?.quarantinePath;
  assert.ok(quarantined);
  assert.equal((await stat(quarantined)).isDirectory(), true);
  const receipt = await readReceipt({ installRoot: fixture.targetRoot });
  assert.equal(receipt.installs?.["dir-old"], undefined);
  assert.equal(receipt.installs?.["link-old"], undefined);
  assert.ok(result.transactionPath);
  const transaction = JSON.parse(await readFile(result.transactionPath, "utf8"));
  assert.equal(transaction.schema, PRUNE_TRANSACTION_SCHEMA);
  assert.equal(transaction.status, "committed");
  assert.ok(result.receiptBackupPath);
});

test("prune refuses assigned skills", async (t) => {
  const fixture = await createFixture(t);
  const result = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["current"], dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "skill_still_assigned"), true);
  assert.deepEqual(result.preserved.assigned, ["current"]);
});

test("prune preserves assigned skills even when their catalog source cannot be planned", async (t) => {
  const fixture = await createFixture(t);
  await rm(path.join(fixture.sourceRoot, "skills", "current"), { recursive: true });
  const result = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["current"], dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "skill_still_assigned"), true);
  assert.deepEqual(result.preserved.assigned, ["current"]);
});

test("prune refuses malformed target assignments instead of treating them as empty", async (t) => {
  const fixture = await createFixture(t);
  const manifestPath = path.join(fixture.sourceRoot, "skill-suitcase.yaml");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, manifest.replace("assignment: codex", "assignment: missing-assignment"));

  const result = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((error) => error.code === "invalid_target" || error.code === "assignment_unverifiable"),
    true
  );
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
});

test("prune apply refuses drift after review", async (t) => {
  const fixture = await createFixture(t);
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.ok(dryRun.plan.id);
  await writeFile(path.join(fixture.directoryTarget, "extra.txt"), "drift\n");

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old"],
    planId: dryRun.plan.id,
    apply: true
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_drift" || error.code === "stale_plan"), true);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
});

test("prune rolls back a mixed batch when apply fails", async (t) => {
  const fixture = await createFixture(t);
  const receiptBefore = await readFile(path.join(fixture.targetRoot, ".skill-suitcase-receipt.json"), "utf8");
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old", "link-old"], dryRun: true });
  assert.ok(dryRun.plan.id);

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old", "link-old"],
    planId: dryRun.plan.id,
    apply: true,
    __test: { failAfterMutationForSkill: "link-old" }
  });
  assert.equal(result.ok, false);
  assert.equal(result.pruned.skills.length, 0);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
  assert.equal(await readlink(fixture.symlinkTarget), path.join(fixture.sourceRoot, "skills", "link-old"));
  assert.equal(await readFile(path.join(fixture.targetRoot, ".skill-suitcase-receipt.json"), "utf8"), receiptBefore);
});

test("prune removes only the selected target record from a multi-target receipt", async (t) => {
  const fixture = await createFixture(t);
  const receipt = await readReceipt({ installRoot: fixture.targetRoot });
  const current = receipt.installs?.["dir-old"];
  assert.ok(current && !Array.isArray(current));
  const otherTargetPath = path.join(path.dirname(fixture.targetRoot), "other-root", "dir-old");
  receipt.installs!["dir-old"] = [
    current,
    buildInstallRecord({
      skill: "dir-old", agent: "claude", target: "claude", mode: "copy",
      sourcePath: path.join(fixture.sourceRoot, "skills", "dir-old"), targetPath: otherTargetPath,
      sourceHash: "other-source", installedFiles: current.installedFiles
    })
  ];
  await writeReceipt({ installRoot: fixture.targetRoot, receipt });

  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.ok(dryRun.plan.id);
  const result = await prune({
    source: fixture.sourceRoot, target: "codex", skills: ["dir-old"],
    planId: dryRun.plan.id, apply: true
  });
  assert.equal(result.ok, true);
  const after = await readReceipt({ installRoot: fixture.targetRoot });
  const remaining = after.installs?.["dir-old"];
  assert.ok(remaining && !Array.isArray(remaining));
  assert.equal(remaining.targetPath, otherTargetPath);
});

test("prune CLI keeps dry-run JSON on stdout and requires plan id for apply", async (t) => {
  const fixture = await createFixture(t);
  const cli = path.join(process.cwd(), "dist", "src", "cli.js");
  const dryRun = spawnSync("node", [
    cli, "prune", "--source", fixture.sourceRoot, "--target", "codex",
    "--skill", "dir-old", "--dry-run", "--json"
  ], { encoding: "utf8" });
  assert.equal(dryRun.status, 0);
  assert.equal(dryRun.stderr, "");
  const payload = JSON.parse(dryRun.stdout) as { ok: boolean; plan: { id: string } };
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.plan.id, "string");

  const missingPlan = spawnSync("node", [
    cli, "prune", "--source", fixture.sourceRoot, "--target", "codex",
    "--skill", "dir-old", "--apply", "--json"
  ], { encoding: "utf8" });
  assert.equal(missingPlan.status, 2);
  assert.equal(missingPlan.stdout, "");
  assert.equal(missingPlan.stderr.includes("Usage:"), true);
});
