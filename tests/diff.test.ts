import assert from "node:assert/strict";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { diff } from "../src/diff.js";

type DiffEntry = {
  action: string;
  relativePath: string | null;
  skill: string;
  targetPath: string | null;
  reason?: string | undefined;
};

async function createCatalog(root: string, manifest: string) {
  await writeFile(path.join(root, "skill-suitcase.yaml"), manifest);
}

function actionByKey(
  entries: DiffEntry[],
  action: string,
  relativePath: string,
  skill = "office-hours"
): DiffEntry | undefined {
  return entries.find((entry: DiffEntry) =>
    entry.action === action && entry.relativePath === relativePath && entry.skill === skill
  );
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

  const unchangedEntry = actionByKey(result.entries, "unchanged", "SKILL.md");
  assert.ok(unchangedEntry);
  assert.ok(unchangedEntry.targetPath);

  const payload = await readFile(
    unchangedEntry.targetPath,
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
  assert.ok(blockedEntry);
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
  codex:
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

  const result = await diff({ source, target: "codex" });

  assert.equal(result.ok, true);
  assert.equal(result.target, "codex");
  assert.equal(result.assignment, "codex");
  assert.equal(result.installRoot, skillsPath);
  assert.equal(result.summary.unchanged, 1);
  assert.equal(result.errors.length, 0);
});

test("diff resolves assignment names to matching assignment paths", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-assignment-name-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-assignment-name-home-"));
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
  codex:
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

  const result = await diff({ source, target: "codex" });

  assert.equal(result.ok, true);
  assert.equal(result.target, "codex");
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

test("diff reports no-install-root for assignment-name targets without assignment paths", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-missing-root-"));
  t.after(() => rm(source, { recursive: true, force: true }));

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
  codex:
    suitcases:
      - core
`
  );

  const result = await diff({ source, target: "codex" });

  assert.equal(result.ok, false);
  assert.equal(result.target, "codex");
  assert.equal(result.assignment, "codex");
  assert.equal(result.installRoot, null);
  assert.equal(result.entries.length, 0);
  assert.ok(result.errors.some((item) => item.code === "missing_install_root"));
  assert.ok(result.summary);
});

test("diff reports provider-modeled read-only targets without creating absent roots", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-provider-readonly-"));
  const missingParent = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-provider-parent-"));
  const opencodeRoot = path.join(missingParent, ".config", "opencode", "skills");
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(missingParent, { recursive: true, force: true }));

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
  codex:
    suitcases:
      - core

assignmentPaths:
  codex:
    kind: codex-home
    assignment: codex
    codexHome: /definitely/missing/codex
    skillsPath: /definitely/missing/codex/skills

compatibility:
  office-hours:
    agents:
      - codex
`
  );

  const result = await diff({
    source,
    target: "opencode",
    targetOverrides: {
      home: missingParent
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.target, "opencode");
  assert.equal(result.assignment, "opencode");
  assert.equal(result.installRoot, opencodeRoot);
  assert.equal(result.entries.length, 0);
  assert.deepEqual(result.errors, []);
  await assert.rejects(() => access(opencodeRoot));
});

test("diff resolves assignment-named provider targets to manifest assignment paths first", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-provider-manifest-"));
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-provider-manifest-home-"));
  const reviewedRoot = path.join(source, "reviewed-opencode-skills");
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(fakeHome, { recursive: true, force: true }));

  const skillRoot = path.join(source, "skills", "office-hours");
  await mkdir(skillRoot, { recursive: true });
  await mkdir(reviewedRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "Office Hours\n");

  await createCatalog(
    source,
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  opencode:
    suitcases:
      - core

assignmentPaths:
  reviewed-opencode:
    kind: opencode-skills-root
    assignment: opencode
    path: ${reviewedRoot}

compatibility:
  office-hours:
    agents:
      - opencode
`
  );

  const result = await diff({
    source,
    target: "opencode",
    targetOverrides: {
      home: fakeHome
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.assignment, "opencode");
  assert.equal(result.installRoot, reviewedRoot);
  assert.equal(result.readOnly, false);
  assert.equal(result.summary.create, 1);
  assert.deepEqual(result.errors, []);
});

test("diff includes installable skill diffs when other skills are blocked", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-blocked-installable-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-blocked-installable-home-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(codexHome, { recursive: true, force: true }));

  const skillsPath = path.join(codexHome, "skills");
  const officeHoursSource = path.join(source, "skills", "office-hours");
  const blockedSkillSource = path.join(source, "skills", "gnhf-postflight");
  const blockedTarget = path.join(skillsPath, "gnhf-postflight");
  await mkdir(officeHoursSource, { recursive: true });
  await mkdir(blockedSkillSource, { recursive: true });
  await mkdir(path.join(skillsPath, "office-hours"), { recursive: true });
  await writeFile(path.join(officeHoursSource, "SKILL.md"), "Office Hours\n");
  await writeFile(path.join(officeHoursSource, "runtime.js"), "runtime v1\n");
  await writeFile(path.join(skillsPath, "office-hours", "SKILL.md"), "Office Hours\n");
  await writeFile(path.join(skillsPath, "office-hours", "runtime.js"), "runtime v2\n");
  await mkdir(blockedTarget, { recursive: true });
  await writeFile(path.join(blockedTarget, "SKILL.md"), "Blocked skill should stay unchanged\n");

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

  gnhf-postflight:
    agents:
      - openclaw
    blockedAgents:
      codex: Canonical gnhf-postflight cannot be installed into Codex.
`
  );

  const result = await diff({ source, target: "codex" });

  assert.equal(result.ok, false);
  const blockedEntries = result.entries.filter((entry) => entry.action === "blocked");
  assert.equal(blockedEntries.length, 1);
  assert.ok(blockedEntries[0]);
  assert.equal(blockedEntries[0].skill, "gnhf-postflight");
  assert.equal(result.summary.blocked, 1);
  assert.equal(result.summary.update, 1);
  assert.equal(result.summary.create + result.summary.unchanged, 1);
});

test("diff returns structured errors when source traversal fails", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-source-error-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-source-error-target-"));
  const targetSkillRoot = path.join(targetRoot, "office-hours");
  const privateDir = path.join(source, "skills", "office-hours", "private");
  t.after(async () => {
    await chmod(privateDir, 0o755).catch(() => {});
  });
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  const skillRoot = path.join(source, "skills", "office-hours");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "Office Hours\n");
  await mkdir(privateDir, { recursive: true });
  await writeFile(path.join(privateDir, "secret.txt"), "cannot be read\n");
  await chmod(privateDir, 0o000);

  await mkdir(targetSkillRoot, { recursive: true });
  await writeFile(path.join(targetSkillRoot, "extra.txt"), "extra file\n");

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
  assert.equal(result.summary.unchanged, 0);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.create, 0);
  assert.ok(result.errors.some((item) => item.code === "source_entry_list_failed"));
  assert.equal(result.entries.length, 0);
  assert.equal(result.entries.filter((entry) => entry.action === "extra").length, 0);
});

test("diff returns ambiguous install-root error for duplicate assignment paths", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-ambiguous-target-"));
  const primaryRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-ambiguous-primary-"));
  const secondaryRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-diff-ambiguous-secondary-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(primaryRoot, { recursive: true, force: true }));
  t.after(() => rm(secondaryRoot, { recursive: true, force: true }));

  const primarySkillsPath = path.join(primaryRoot, "skills");
  const secondarySkillsPath = path.join(secondaryRoot, "skills");
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
  codex:
    suitcases:
      - core

assignmentPaths:
  codex-primary:
    kind: codex-home
    assignment: codex
    codexHome: ${primaryRoot}
    skillsPath: ${primarySkillsPath}

  codex-secondary:
    kind: codex-home
    assignment: codex
    codexHome: ${secondaryRoot}
    skillsPath: ${secondarySkillsPath}

compatibility:
  office-hours:
    agents:
      - codex
`
  );

  const result = await diff({ source, target: "codex" });

  assert.equal(result.ok, false);
  assert.equal(result.installRoot, null);
  assert.equal(result.target, "codex");
  assert.equal(result.assignment, "codex");
  assert.equal(result.entries.length, 0);
  const error = result.errors.find((item) => item.code === "ambiguous_install_root");
  assert.ok(error);
  assert.equal(error.message.includes("pass a concrete assignmentPath target selector"), true);
  assert.deepEqual(error.candidates, ["codex-primary", "codex-secondary"]);
});
