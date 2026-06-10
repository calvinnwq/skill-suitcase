import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { diff } from "../src/diff.js";

async function createCatalog(root, manifest) {
  await writeFile(path.join(root, "skill-suitcase.yaml"), manifest);
}

function actionByKey(entries, action, relativePath, skill = "office-hours") {
  return entries.find((entry) => entry.action === action && entry.relativePath === relativePath && entry.skill === skill);
}

test("diff reports create, update, unchanged, and extra actions", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-main-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-target-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  const skillRoot = path.join(source, "skills", "office-hours");
  await mkdir(skillRoot, { recursive: true });
  await mkdir(path.join(skillRoot, "nested"), { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "Office Hours\n");
  await writeFile(path.join(skillRoot, "nested", "notes.txt"), "same content\n");
  await writeFile(path.join(skillRoot, "runtime.js"), "console.log('update me');\n");
  await writeFile(path.join(skillRoot, "pending.txt"), "planned only\n");

  const targetSkillRoot = path.join(targetRoot, "office-hours");
  await mkdir(path.join(targetSkillRoot, "nested"), { recursive: true });
  await mkdir(path.join(targetSkillRoot), { recursive: true });
  await writeFile(path.join(targetSkillRoot, "SKILL.md"), "Office Hours\n");
  await writeFile(path.join(targetSkillRoot, "nested", "notes.txt"), "new content\n");
  await writeFile(path.join(targetSkillRoot, "runtime.js"), "console.log('update me');\n");
  await writeFile(path.join(targetSkillRoot, "extra.md"), "not planned\n");

  await createCatalog(
    source,
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
    path: ${targetRoot}

compatibility:
  office-hours:
    agents:
      - openclaw
    variant: canonical
`
  );

  const result = await diff({ source, target: "openclaw" });

  assert.equal(result.ok, true);
  assert.equal(result.installRoot, targetRoot);
  assert.equal(result.summary.create, 1);
  assert.equal(result.summary.update, 1);
  assert.equal(result.summary.unchanged, 2);
  assert.equal(result.summary.extra, 1);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.blocked, 0);

  assert.ok(actionByKey(result.entries, "create", "pending.txt"));
  assert.ok(actionByKey(result.entries, "update", path.join("nested", "notes.txt")));
  assert.ok(actionByKey(result.entries, "unchanged", "SKILL.md"));
  assert.ok(actionByKey(result.entries, "extra", "extra.md"));

  const payload = await readFile(
    actionByKey(result.entries, "unchanged", "SKILL.md").targetPath,
    "utf8"
  );
  assert.equal(payload, "Office Hours\n");
});

test("diff marks blocked canonical installs for a Codex-like target", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-blocked-"));
  t.after(() => rm(source, { recursive: true, force: true }));

  const codexHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-codex-home-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const skillsPath = path.join(codexHome, "skills");
  const openclawSkillRoot = path.join(source, "skills", "office-hours");
  const blockedSkillRoot = path.join(source, "skills", "gnhf-postflight");
  await mkdir(openclawSkillRoot, { recursive: true });
  await writeFile(path.join(openclawSkillRoot, "SKILL.md"), "Office Hours\n");
  await mkdir(path.join(skillsPath, "office-hours"), { recursive: true });
  await writeFile(path.join(skillsPath, "office-hours", "SKILL.md"), "Office Hours\n");
  await mkdir(blockedSkillRoot, { recursive: true });

  await createCatalog(
    source,
    `suitcases:
  openclaw-builder:
    skills:
      - gnhf-postflight

  core:
    skills:
      - office-hours

assignments:
  codex:
    suitcases:
      - core
      - openclaw-builder

assignmentPaths:
  codex:
    kind: codex-home
    assignment: codex
    codexHome: ${codexHome}
    skillsPath: ${skillsPath}

compatibility:
  office-hours:
    agents:
      - codex
    variant: canonical

  gnhf-postflight:
    agents:
      - openclaw
    variant: canonical
    reason: Live Codex should use a slimmer platform variant.
    blockedAgents:
      codex: Canonical gnhf-postflight cannot be installed into Codex.
`
  );

  const result = await diff({ source, target: "codex" });

  assert.equal(result.ok, false);
  assert.equal(result.installRoot, skillsPath);
  const blockedEntry = result.entries.find((entry) => entry.action === "blocked");
  assert.equal(blockedEntry.skill, "gnhf-postflight");
  assert.equal(blockedEntry.reason, "Canonical gnhf-postflight cannot be installed into Codex.");
  assert.equal(result.summary.blocked, 1);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.update + result.summary.create, 0);
});

test("diff accepts assignment path target selectors", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-selector-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-selector-home-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(codexHome, { recursive: true, force: true }));

  const skillsPath = path.join(codexHome, "skills");
  const skillRoot = path.join(source, "skills", "office-hours");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "Office Hours\n");
  await mkdir(path.join(skillsPath, "office-hours"), { recursive: true });
  await writeFile(path.join(skillsPath, "office-hours", "SKILL.md"), "Office Hours\n");

  await createCatalog(
    source,
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
    skillsPath: ${skillsPath}

compatibility:
  office-hours:
    agents:
      - codex
`
  );

  const result = await diff({ source, target: "codex-global" });

  assert.equal(result.ok, true);
  assert.equal(result.target, "codex-global");
  assert.equal(result.assignment, "codex");
  assert.equal(result.installRoot, skillsPath);
  assert.equal(result.summary.unchanged, 1);
  assert.equal(result.errors.length, 0);
});

test("diff is read-only and does not create missing install roots", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-readonly-"));
  const targetParent = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-target-parent-"));
  const targetRoot = path.join(targetParent, "missing-root");

  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(targetParent, { recursive: true, force: true }));

  const skillRoot = path.join(source, "skills", "office-hours");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "Office Hours\n");

  await createCatalog(
    source,
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
    path: ${targetRoot}

compatibility:
  office-hours:
    agents:
      - openclaw
`
  );

  const result = await diff({ source, target: "openclaw" });

  assert.equal(result.ok, false);
  assert.equal(result.installRoot, targetRoot);
  assert.ok(result.errors.some((item) => item.code === "missing_install_root"));
  await assert.rejects(() => access(targetRoot));
});
