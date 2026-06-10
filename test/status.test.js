import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { status } from "../src/status.js";

test("status reports manifest-wide statuses for all assignments and respects receipt state", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-test-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });

  await writeFile(path.join(sourceSkill, "SKILL.md"), [
    "---",
    "name: office-hours",
    "version: 2026.06.10",
    "---",
    "",
    "# Office Hours"
  ].join("\n"));
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  const currentHash = await hashDirectory(sourceSkill);

  const currentRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-current-"));
  const missingRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-missing-"));
  const unknownRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-unknown-"));
  const versionRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-version-"));
  const behindRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-behind-"));
  const dirtyRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-dirty-"));
  t.after(() => rm(currentRoot, { recursive: true, force: true }));
  t.after(() => rm(missingRoot, { recursive: true, force: true }));
  t.after(() => rm(unknownRoot, { recursive: true, force: true }));
  t.after(() => rm(versionRoot, { recursive: true, force: true }));
  t.after(() => rm(behindRoot, { recursive: true, force: true }));
  t.after(() => rm(dirtyRoot, { recursive: true, force: true }));

  await mkdir(path.join(currentRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(currentRoot, "office-hours"), { recursive: true });
  await writeReceipt({
    installRoot: currentRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: currentHash
  });

  await mkdir(path.join(unknownRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(unknownRoot, "office-hours"), { recursive: true });

  await mkdir(path.join(versionRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(versionRoot, "office-hours"), { recursive: true });
  await writeReceipt({
    installRoot: versionRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.05.01",
    sourceHash: currentHash
  });

  await mkdir(path.join(behindRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(behindRoot, "office-hours"), { recursive: true });
  await writeFile(path.join(behindRoot, "office-hours", "runtime.js"), "console.log(\"behind\");\n");
  await writeReceipt({
    installRoot: behindRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(path.join(behindRoot, "office-hours"))
  });

  await mkdir(path.join(dirtyRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(dirtyRoot, "office-hours"), { recursive: true });
  await writeFile(path.join(dirtyRoot, "office-hours", "runtime.js"), "console.log(\"dirty\");\n");
  await writeReceipt({
    installRoot: dirtyRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: currentHash
  });

  const manifestPath = path.join(sourceRoot, "skill-suitcase.yaml");
  await writeFile(
    manifestPath,
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  current-openclaw:
    suitcases:
      - core

  missing-openclaw:
    suitcases:
      - core

  unknown-openclaw:
    suitcases:
      - core

  version-openclaw:
    suitcases:
      - core

  behind-openclaw:
    suitcases:
      - core

  dirty-openclaw:
    suitcases:
      - core

assignmentPaths:
  current-openclaw:
    kind: openclaw-skills-root
    assignment: current-openclaw
    path: ${currentRoot}

  missing-openclaw:
    kind: openclaw-skills-root
    assignment: missing-openclaw
    path: ${missingRoot}

  unknown-openclaw:
    kind: openclaw-skills-root
    assignment: unknown-openclaw
    path: ${unknownRoot}

  version-openclaw:
    kind: openclaw-skills-root
    assignment: version-openclaw
    path: ${versionRoot}

  behind-openclaw:
    kind: openclaw-skills-root
    assignment: behind-openclaw
    path: ${behindRoot}

  dirty-openclaw:
    kind: openclaw-skills-root
    assignment: dirty-openclaw
    path: ${dirtyRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, true);
  assert.equal(result.manifestPath, manifestPath);
  assert.equal(result.assignments.length, 6);
  assert.equal(result.statuses.length, 6);
  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.missing, 1);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.summary.version, 1);
  assert.equal(result.summary.behind, 1);
  assert.equal(result.summary.dirty, 1);

  const byPath = new Map(result.statuses.map((item) => [item.assignmentPath, item.status]));
  assert.equal(byPath.get("current-openclaw"), "current");
  assert.equal(byPath.get("missing-openclaw"), "missing");
  assert.equal(byPath.get("unknown-openclaw"), "unknown");
  assert.equal(byPath.get("version-openclaw"), "version");
  assert.equal(byPath.get("behind-openclaw"), "behind");
  assert.equal(byPath.get("dirty-openclaw"), "dirty");
});

test("status reports stale installed content as behind instead of dirty", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-stale-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-stale-install-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"old\");\n");

  const installedHash = await hashDirectory(sourceSkill);
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  await writeReceipt({
    installRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: installedHash
  });

  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"new\");\n");
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, true);
  assert.equal(result.summary.behind, 1);
  assert.equal(result.summary.dirty, 0);
  assert.equal(result.statuses[0].status, "behind");
});

test("status marks compatibility-blocked plan entries", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-blocked-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-blocked-install-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const officeHours = path.join(sourceRoot, "skills", "office-hours");
  const blockedSkill = path.join(sourceRoot, "skills", "gnhf-postflight");
  await mkdir(officeHours, { recursive: true });
  await mkdir(blockedSkill, { recursive: true });
  await writeFile(path.join(officeHours, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(blockedSkill, "SKILL.md"), "---\nname: gnhf-postflight\nversion: 2026.06.10\n---\n");

  await cp(officeHours, path.join(installRoot, "office-hours"), { recursive: true });
  await writeReceipt({
    installRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(officeHours)
  });

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours
      - gnhf-postflight

assignments:
  codex:
    suitcases:
      - core

assignmentPaths:
  codex-global:
    kind: codex-home
    assignment: codex
    skillsPath: ${installRoot}

compatibility:
  gnhf-postflight:
    blockedAgents:
      codex: Codex must use the slimmer platform variant.
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.blocked, 1);
  assert.equal(result.errors.some((entry) => entry.code === "blocked_skill"), true);

  const blocked = result.statuses.find((entry) => entry.skill === "gnhf-postflight");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "Codex must use the slimmer platform variant.");
});

test("status requires codex-home skillsPath as the install root", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-codex-root-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-codex-home-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(codexHome, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  codex:
    suitcases:
      - core

assignmentPaths:
  codex-global:
    kind: codex-home
    assignment: codex
    codexHome: ${codexHome}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.statuses.length, 0);
  assert.equal(result.errors[0].code, "invalid_assignment_path");
  assert.equal(result.errors[0].path, "assignmentPaths.codex-global.skillsPath");
});

test("status reports malformed sync receipts as errors", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-receipt-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-receipt-install-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  await writeFile(path.join(installRoot, ".skills-sync.json"), "{ not json\n");
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.errors.some((entry) => entry.code === "invalid_receipt"), true);
});

test("status reports assignment-level validation errors while still evaluating valid assignments", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-invalid-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");

  const validRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-valid-"));
  const brokenRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-broken-"));
  t.after(() => rm(validRoot, { recursive: true, force: true }));
  t.after(() => rm(brokenRoot, { recursive: true, force: true }));

  await mkdir(path.join(validRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(validRoot, "office-hours"), { recursive: true });

  await mkdir(path.join(brokenRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(brokenRoot, "office-hours"), { recursive: true });

  await writeReceipt({
    installRoot: validRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(sourceSkill)
  });

  const manifestPath = path.join(sourceRoot, "skill-suitcase.yaml");
  await writeFile(
    manifestPath,
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${validRoot}

  bad-kind:
    kind: not-a-live-root
    assignment: openclaw
    path: ${brokenRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.assignments.length, 2);

  const validAssignment = result.assignments.find((entry) => entry.assignmentPath === "openclaw");
  const invalidAssignment = result.assignments.find((entry) => entry.assignmentPath === "bad-kind");

  assert.equal(validAssignment.assignment, "openclaw");
  assert.equal(validAssignment.statusCount, 1);
  assert.equal(validAssignment.statuses.length, 1);
  assert.equal(validAssignment.statuses[0].status, "current");

  assert.equal(invalidAssignment.statusCount, 0);
  assert.equal(invalidAssignment.statuses.length, 0);
  assert.equal(invalidAssignment.errors.length, 1);
  assert.equal(invalidAssignment.errors[0].code, "invalid_assignment_path");

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "invalid_assignment_path");
  assert.equal(result.errors[0].path, "assignmentPaths.bad-kind.kind");

  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.unknown, 0);
  assert.equal(result.summary.version, 0);
  assert.equal(result.summary.behind, 0);
  assert.equal(result.summary.dirty, 0);
});

test("status surfaces plan failures and continues evaluating other assignment paths", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-plan-fail-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");

  const validRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-valid-plan-"));
  const failingRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-plan-"));
  t.after(() => rm(validRoot, { recursive: true, force: true }));
  t.after(() => rm(failingRoot, { recursive: true, force: true }));

  await mkdir(path.join(validRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(validRoot, "office-hours"), { recursive: true });

  await mkdir(path.join(failingRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(failingRoot, "office-hours"), { recursive: true });

  await writeReceipt({
    installRoot: validRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(sourceSkill)
  });

  const manifestPath = path.join(sourceRoot, "skill-suitcase.yaml");
  await writeFile(
    manifestPath,
    `suitcases:
  core:
    skills:
      - office-hours
  portable:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

  broken:
    suitcases:
      - missing-suitcase

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${validRoot}

  broken:
    kind: openclaw-skills-root
    assignment: broken
    path: ${failingRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.assignments.length, 2);
  assert.equal(result.errors.some((entry) => entry.code === "plan_failed"), true);

  const validAssignment = result.assignments.find((entry) => entry.assignmentPath === "openclaw");
  const brokenAssignment = result.assignments.find((entry) => entry.assignmentPath === "broken");

  assert.equal(validAssignment.assignment, "openclaw");
  assert.equal(validAssignment.statusCount, 1);
  assert.equal(validAssignment.statuses[0].status, "current");

  assert.equal(brokenAssignment.assignment, "broken");
  assert.equal(brokenAssignment.statusCount, 0);
  assert.equal(brokenAssignment.statuses.length, 0);
  assert.equal(brokenAssignment.errors.length, 1);
  assert.equal(brokenAssignment.errors[0].code, "plan_failed");
});

async function writeReceipt({ installRoot, sourceRoot, skillName, version, sourceHash }) {
  const receipt = {
    schema: "calvinnwq.skills.sync-lock.v0",
    installs: {
      [skillName]: {
        agent: "openclaw",
        mode: "copy",
        sourcePath: path.join(sourceRoot, "skills", skillName),
        targetPath: path.join(installRoot, skillName),
        version,
        sourceCommit: "deadbeef",
        sourceHash
      }
    }
  };

  await writeFile(
    path.join(installRoot, ".skills-sync.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8"
  );
}

async function hashDirectory(root) {
  const digest = createHash("sha256");
  const entries = await listFiles(root);
  for (const entry of entries) {
    const bytes = await readFile(entry, "utf8");
    const relativePath = path.relative(root, entry);
    digest.update(relativePath);
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function listFiles(root) {
  const entries = [];
  const files = await readdir(root, { withFileTypes: true });
  for (const item of files) {
    const itemPath = path.join(root, item.name);
    if (item.isDirectory()) {
      entries.push(...(await listFiles(itemPath)));
      continue;
    }
    if (item.isFile()) {
      entries.push(itemPath);
    }
  }
  return entries.sort();
}
