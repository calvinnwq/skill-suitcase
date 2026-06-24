import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectImportSource } from "../src/core/importing/index.js";

const fixtureSource = path.join(process.cwd(), "tests", "fixtures", "skills-catalog");

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test("inspects the fixture catalog as an importable source", async () => {
  const result = await inspectImportSource({ source: fixtureSource });

  assert.equal(result.ok, true);
  assert.equal(result.source, fixtureSource);
  assert.equal(result.manifestPath, path.join(fixtureSource, "skill-suitcase.yaml"));
  assert.deepEqual(result.summary, {
    discoveredSkills: 3,
    referencedSkills: 3,
    suitcases: 2,
    assignments: 4,
    assignmentPaths: 4,
    groups: 3,
    compatibilityEntries: 3,
    variantEntries: 3,
    warnings: 0,
    errors: 0,
    findings: 0
  });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(
    result.skills.map((skill) => skill.name),
    ["gnhf-postflight", "office-hours", "skillify"]
  );
  assert.deepEqual(
    result.groups.map((group) => ({
      name: group.name,
      provider: group.provider,
      skills: group.skills,
      suitcases: group.suitcases,
      assignments: group.assignments,
      tags: group.tags
    })),
    [
      {
        name: "codex-assigned",
        provider: null,
        skills: [],
        suitcases: [],
        assignments: ["codex"],
        tags: ["assignment"]
      },
      {
        name: "openclaw-builder-tools",
        provider: "openclaw",
        skills: ["gnhf-postflight", "skillify"],
        suitcases: ["openclaw-builder"],
        assignments: [],
        tags: ["workflow"]
      },
      {
        name: "portable-core",
        provider: null,
        skills: [],
        suitcases: ["core"],
        assignments: ["claude", "codex", "openclaw-codex"],
        tags: ["portable"]
      }
    ]
  );

  const gnhf = result.skills.find((skill) => skill.name === "gnhf-postflight");
  assert.ok(gnhf);
  assert.deepEqual(gnhf.groups, ["openclaw-builder-tools"]);
  assert.equal(gnhf.compatibility.declared, true);
  assert.deepEqual(gnhf.compatibility.agents, ["openclaw"]);
  assert.deepEqual(
    gnhf.variants.map((variant) => variant.name),
    ["canonical", "claude", "codex"]
  );

  const officeHours = result.skills.find((skill) => skill.name === "office-hours");
  assert.ok(officeHours);
  assert.deepEqual(officeHours.groups, ["codex-assigned", "portable-core"]);
});

test("expands assignment-backed logical groups into skill memberships", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-assignment-groups-"));
  await mkdir(path.join(source, "skills", "office-hours"), { recursive: true });
  await writeFile(path.join(source, "skills", "office-hours", "SKILL.md"), "# Office Hours\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
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
    codexHome: /tmp/codex
    skillsPath: /tmp/codex/skills

groups:
  assignment-backed:
    assignments:
      - codex

compatibility:
  office-hours:
    agents:
      - codex
    variant: canonical
`
  );

  const result = await inspectImportSource({ source });
  const officeHours = result.skills.find((skill) => skill.name === "office-hours");

  assert.equal(result.ok, true);
  assert.ok(officeHours);
  assert.deepEqual(officeHours.groups, ["assignment-backed"]);
});

test("reports missing manifest and layout issues as deterministic errors", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-missing-manifest-"));

  const result = await inspectImportSource({ source });

  assert.equal(result.ok, false);
  assert.equal(result.source, source);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(
    result.findings.map((finding) => [finding.level, finding.code, finding.path]),
    [
      ["error", "missing_manifest", "skill-suitcase.yaml"],
      ["error", "missing_skills_directory", "skills"]
    ]
  );
  assert.equal(result.summary.errors, 2);
});

test("reports unreadable skills directories as deterministic errors", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-unreadable-skills-"));
  const skillsRoot = path.join(source, "skills");
  await mkdir(skillsRoot, { recursive: true });
  await chmod(skillsRoot, 0);
  t.after(async () => {
    await chmod(skillsRoot, 0o700);
  });

  const result = await inspectImportSource({ source });

  assert.equal(result.ok, false);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(
    result.findings.map((finding) => [finding.level, finding.code, finding.path]),
    [
      ["error", "missing_manifest", "skill-suitcase.yaml"],
      ["error", "unreadable_skills_directory", "skills"]
    ]
  );
});

test("warns when referenced skills are missing portability metadata", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-missing-metadata-"));
  await mkdir(path.join(source, "skills", "office-hours"), { recursive: true });
  await writeFile(path.join(source, "skills", "office-hours", "SKILL.md"), "# Office Hours\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
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

  const result = await inspectImportSource({ source });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.findings.map((finding) => [finding.level, finding.code, finding.path]),
    [
      ["warning", "missing_assignment_paths", "assignmentPaths"],
      ["warning", "missing_compatibility", "compatibility.office-hours"]
    ]
  );
  assert.equal(result.summary.warnings, 2);
});

test("import inspection remains loose when a source skill has untracked files", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-untracked-"));
  t.after(() => rm(source, { recursive: true, force: true }));

  const skillRoot = path.join(source, "skills", "office-hours");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "# Office Hours\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
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
    path: /tmp/openclaw/skills

compatibility:
  office-hours:
    agents:
      - openclaw
    variant: canonical
`
  );
  git(source, "init");
  git(source, "add", "skill-suitcase.yaml", "skills/office-hours/SKILL.md");
  await writeFile(path.join(skillRoot, "scratch.md"), "still importable\n");

  const result = await inspectImportSource({ source });

  assert.equal(result.ok, true);
  assert.equal(result.summary.discoveredSkills, 1);
  assert.equal(result.summary.findings, 0);
});

test("ignores support-only directories marked under skills", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-support-directory-"));
  await mkdir(path.join(source, "skills", "office-hours"), { recursive: true });
  await mkdir(path.join(source, "skills", "check-resolvable-local", "fixtures"), { recursive: true });
  await writeFile(path.join(source, "skills", "office-hours", "SKILL.md"), "# Office Hours\n");
  await writeFile(path.join(source, "skills", "check-resolvable-local", ".support-directory"), "");
  await writeFile(
    path.join(source, "skills", "check-resolvable-local", "fixtures", "routing-fixtures.json"),
    "[]"
  );
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
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
    path: /tmp/openclaw/skills
    assignment: openclaw

compatibility:
  office-hours:
    agents:
      - openclaw
    variant: canonical
`
  );

  const result = await inspectImportSource({ source });

  assert.equal(result.ok, true);
  assert.equal(result.summary.discoveredSkills, 1);
  assert.deepEqual(result.skills.map((skill) => skill.name), ["office-hours"]);
  assert.deepEqual(result.findings, []);
});

test("reports malformed assignment path metadata as deterministic errors", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-bad-targets-"));
  await mkdir(path.join(source, "skills", "office-hours"), { recursive: true });
  await writeFile(path.join(source, "skills", "office-hours", "SKILL.md"), "# Office Hours\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  codex:
    suitcases:
      - core

assignmentPaths:
  missing-assignment:
    kind: codex-home
    codexHome: /tmp/codex
    skillsPath: /tmp/codex/skills
  missing-kind:
    assignment: codex
    codexHome: /tmp/codex
    skillsPath: /tmp/codex/skills
  unsupported-kind:
    kind: not-a-platform
    assignment: codex
    path: /tmp/skills
  missing-required-field:
    kind: codex-home
    assignment: codex
    codexHome: /tmp/codex

compatibility:
  office-hours:
    agents:
      - codex
    variant: canonical
`
  );

  const result = await inspectImportSource({ source });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.findings.map((finding) => [finding.level, finding.code, finding.path]),
    [
      ["error", "invalid_assignment_path", "assignmentPaths.missing-assignment.assignment"],
      ["error", "invalid_assignment_path", "assignmentPaths.missing-kind.kind"],
      ["error", "invalid_assignment_path", "assignmentPaths.unsupported-kind.kind"],
      ["error", "invalid_assignment_path", "assignmentPaths.missing-required-field.skillsPath"]
    ]
  );
});

test("reports invalid logical group metadata deterministically", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-bad-groups-"));
  await mkdir(path.join(source, "skills", "office-hours"), { recursive: true });
  await writeFile(path.join(source, "skills", "office-hours", "SKILL.md"), "# Office Hours\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
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
    codexHome: /tmp/codex
    skillsPath: /tmp/codex/skills

groups:
  bad/group:
    skills:
      - missing-skill
    suitcases:
      - missing-suitcase
    assignments:
      - missing-assignment
  empty-group:
    title: Empty Group

compatibility:
  office-hours:
    agents:
      - codex
    variant: canonical
`
  );

  const result = await inspectImportSource({ source });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.findings.map((finding) => [finding.level, finding.code, finding.path]),
    [
      ["error", "invalid_group", "groups.bad/group"],
      ["error", "unknown_group_skill", "groups.bad/group.skills"],
      ["error", "unknown_group_suitcase", "groups.bad/group.suitcases"],
      ["error", "unknown_group_assignment", "groups.bad/group.assignments"],
      ["warning", "empty_group", "groups.empty-group"]
    ]
  );
});

test("warns when blocked platform compatibility lacks variant source metadata", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-missing-variants-"));
  await mkdir(path.join(source, "skills", "gnhf-postflight"), { recursive: true });
  await writeFile(path.join(source, "skills", "gnhf-postflight", "SKILL.md"), "# GNHF Postflight\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - gnhf-postflight

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    path: /tmp/openclaw/skills
    assignment: openclaw

compatibility:
  gnhf-postflight:
    agents:
      - openclaw
    variant: canonical
    blockedAgents:
      codex: Needs a slim Codex variant.
`
  );

  const result = await inspectImportSource({ source });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.findings.map((finding) => [finding.level, finding.code, finding.path]),
    [
      ["warning", "missing_variant_metadata", "variants.gnhf-postflight"]
    ]
  );
});

test("rejects referenced skill names that escape the skills directory", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-escape-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-external-"));
  await mkdir(path.join(source, "skills"), { recursive: true });
  await writeFile(path.join(external, "SKILL.md"), "# External\n");
  const escapingName = path.relative(path.join(source, "skills"), external);
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - ${escapingName}

assignments:
  codex:
    suitcases:
      - core

assignmentPaths:
  codex:
    kind: codex-home
    codexHome: /tmp/codex
    skillsPath: /tmp/codex/skills
    assignment: codex
`
  );

  const result = await inspectImportSource({ source });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.findings.map((finding) => [finding.level, finding.code, finding.path]),
    [
      ["error", "invalid_skill_name", `skills.${escapingName}`],
      ["warning", "missing_compatibility", `compatibility.${escapingName}`]
    ]
  );
  assert.equal(result.skills[0]?.path, null);
  assert.equal(result.skills[0]?.skillFile, null);
});

test("checks variant metadata without mutating live install paths", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-variant-"));
  const liveHome = path.join(source, "live-home");
  const liveSkills = path.join(liveHome, "skills");
  await mkdir(path.join(source, "skills", "office-hours"), { recursive: true });
  await writeFile(path.join(source, "skills", "office-hours", "SKILL.md"), "# Office Hours\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
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
    codexHome: ${liveHome}
    skillsPath: ${liveSkills}
    assignment: codex

compatibility:
  office-hours:
    agents:
      - codex
    variant: canonical
    evidence:
      - README.md

variants:
  office-hours:
    codex:
      source: variants/codex/office-hours
`
  );

  const result = await inspectImportSource({ source });

  assert.equal(await pathExists(liveHome), false);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.findings.map((finding) => [finding.level, finding.code, finding.path]),
    [
      ["warning", "missing_variant_agents", "variants.office-hours.codex.agents"],
      ["error", "missing_variant_directory", "variants.office-hours.codex.source"],
      ["error", "missing_variant_skill_file", "variants.office-hours.codex.SKILL.md"]
    ]
  );
});

test("rejects variant sources that are symlinks outside the source repo", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-variant-symlink-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-variant-external-"));
  await mkdir(path.join(source, "skills", "office-hours"), { recursive: true });
  await writeFile(path.join(source, "skills", "office-hours", "SKILL.md"), "# Office Hours\n");
  await mkdir(path.join(source, "variants", "codex"), { recursive: true });
  await writeFile(path.join(external, "SKILL.md"), "# External Variant\n");
  await symlink(external, path.join(source, "variants", "codex", "office-hours"));
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
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
    codexHome: /tmp/codex
    skillsPath: /tmp/codex/skills
    assignment: codex

compatibility:
  office-hours:
    agents:
      - codex
    variant: canonical

variants:
  office-hours:
    codex:
      source: variants/codex/office-hours
      agents:
        - codex
`
  );

  const result = await inspectImportSource({ source });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.findings.map((finding) => [finding.level, finding.code, finding.path]),
    [
      ["error", "invalid_variant_source", "variants.office-hours.codex.source"]
    ]
  );
});

test("rejects variant sources that traverse symlinked parents outside the source repo", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-variant-parent-symlink-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-import-variant-parent-external-"));
  await mkdir(path.join(source, "skills", "office-hours"), { recursive: true });
  await writeFile(path.join(source, "skills", "office-hours", "SKILL.md"), "# Office Hours\n");
  await mkdir(path.join(source, "variants"), { recursive: true });
  await mkdir(path.join(external, "office-hours"), { recursive: true });
  await writeFile(path.join(external, "office-hours", "SKILL.md"), "# External Variant\n");
  await symlink(external, path.join(source, "variants", "codex"));
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
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
    codexHome: /tmp/codex
    skillsPath: /tmp/codex/skills
    assignment: codex

compatibility:
  office-hours:
    agents:
      - codex
    variant: canonical

variants:
  office-hours:
    codex:
      source: variants/codex/office-hours
      agents:
        - codex
`
  );

  const result = await inspectImportSource({ source });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.findings.map((finding) => [finding.level, finding.code, finding.path]),
    [
      ["error", "invalid_variant_source", "variants.office-hours.codex.source"]
    ]
  );
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.status, 0, result.stderr);
}
