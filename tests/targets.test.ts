import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { targets } from "../src/targets.js";

const fixtureSource = path.join(process.cwd(), "tests", "fixtures", "skills-catalog");

test("lists all assignment paths with stability fields from the fixture catalog", async () => {
  const result = await targets({ source: fixtureSource });
  const targetIds = result.targets.map((entry) => entry.id);

  assert.equal(result.ok, true);
  assert.equal(result.targets.length, 4);
  assert.deepEqual(targetIds.sort(), [
    "claude",
    "codex",
    "openclaw",
    "openclaw-codex"
  ]);
  assert.deepEqual(result.findings, []);

  const codexGlobal = result.targets.find((entry) => entry.id === "codex");
  if (codexGlobal === undefined) {
    throw new Error("Expected codex target entry in fixture output.");
  }
  assert.equal(codexGlobal.path, "/tmp/codex");
  assert.equal(codexGlobal.codexHome, "/tmp/codex");
  assert.equal(codexGlobal.skillsPath, "/tmp/codex/skills");
  assert.deepEqual(codexGlobal.platform, {
    adapter: "codex",
    installRoot: "/tmp/codex/skills",
    compatibility: ["codex"],
    metadata: {}
  });

  const openclaw = result.targets.find((entry) => entry.id === "openclaw");
  if (openclaw === undefined) {
    throw new Error("Expected openclaw target entry in fixture output.");
  }
  assert.deepEqual(openclaw.platform, {
    adapter: "openclaw",
    installRoot: "/tmp/openclaw/skills",
    compatibility: ["openclaw"],
    metadata: {
      workspaceSkillRoot: true
    }
  });

  for (const entry of result.targets) {
    assert.equal(typeof entry.id, "string");
    assert.equal(typeof entry.name, "string");
    assert.equal(typeof entry.assignment, "string");
    assert.equal(typeof entry.kind, "string");
    assert.equal(typeof entry.safety.classification, "string");
    assert.ok(typeof entry.exists.path === "boolean");
    assert.ok(typeof entry.exists.skillsPath === "boolean");
    assert.ok(["live-install-root", "missing", "invalid"].includes(entry.safety.classification));
  }
});

test("local target overrides replace global Codex and Claude install paths", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-targets-codex-home-"));
  const codexSkills = path.join(codexHome, "custom-skills");
  const claudeSkills = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-targets-claude-skills-"));
  await mkdir(codexSkills, { recursive: true });
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  t.after(() => rm(claudeSkills, { recursive: true, force: true }));

  const result = await targets({
    source: fixtureSource,
    targetOverrides: {
      codexHome,
      codexSkills,
      claudeSkills
    }
  });

  const codexGlobal = result.targets.find((entry) => entry.id === "codex");
  const kodyCodex = result.targets.find((entry) => entry.id === "openclaw-codex");
  const claudeGlobal = result.targets.find((entry) => entry.id === "claude");

  assert.ok(codexGlobal);
  assert.equal(codexGlobal.codexHome, codexHome);
  assert.equal(codexGlobal.skillsPath, codexSkills);
  assert.equal(codexGlobal.platform?.installRoot, codexSkills);
  assert.equal(codexGlobal.exists.codexHome, true);
  assert.equal(codexGlobal.exists.skillsPath, true);

  assert.ok(kodyCodex);
  assert.equal(kodyCodex.codexHome, "/tmp/openclaw-codex");
  assert.equal(kodyCodex.skillsPath, "/tmp/openclaw-codex/skills");

  assert.ok(claudeGlobal);
  assert.equal(claudeGlobal.path, claudeSkills);
  assert.equal(claudeGlobal.platform?.installRoot, claudeSkills);
  assert.equal(claudeGlobal.exists.path, true);
});

test("--codex-skills alone overrides only skillsPath and preserves codexHome", async (t) => {
  const codexSkills = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-targets-codex-skills-"));
  t.after(() => rm(codexSkills, { recursive: true, force: true }));

  const result = await targets({
    source: fixtureSource,
    targetOverrides: {
      codexSkills
    }
  });

  const codexGlobal = result.targets.find((entry) => entry.id === "codex");

  assert.ok(codexGlobal);
  assert.equal(codexGlobal.codexHome, "/tmp/codex");
  assert.equal(codexGlobal.skillsPath, codexSkills);
  assert.equal(codexGlobal.platform?.installRoot, codexSkills);
});

test("--codex-home alone overrides codexHome and defaults skillsPath to <home>/skills", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-targets-codex-home-only-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));

  const result = await targets({
    source: fixtureSource,
    targetOverrides: {
      codexHome
    }
  });

  const codexGlobal = result.targets.find((entry) => entry.id === "codex");

  assert.ok(codexGlobal);
  assert.equal(codexGlobal.codexHome, codexHome);
  assert.equal(codexGlobal.skillsPath, path.join(codexHome, "skills"));
});

test("reports malformed assignmentPaths as errors and classifies them as invalid", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-targets-invalid-"));
  const existingPath = path.join(source, "skills-root");
  await mkdir(existingPath, { recursive: true });
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  claude:
    suitcases:
      - core

assignmentPaths:
  valid-live-root:
    kind: claude-skills-root
    assignment: claude
    path: ${existingPath}
  bad-assignment:
    kind: claude-skills-root
    assignment: missing-assignment
    path: ${existingPath}
  bad-kind:
    kind: not-a-live-root
    assignment: claude
    path: ${existingPath}
  broken-not-object:
    /tmp/bad-target-entry
`
  );

  const result = await targets({ source });
  const findings = result.findings.map((item) => item.code);

  assert.equal(result.ok, false);
  assert.equal(result.targets.length, 4);
  assert.ok(findings.includes("unknown_assignment_path_target"));
  assert.ok(findings.includes("invalid_assignment_path"));

  const invalidEntries = result.targets.filter(
    (entry) => entry.safety.classification === "invalid"
  );
  assert.ok(invalidEntries.length >= 3);
  assert.ok(
    invalidEntries.some((entry) => entry.id === "bad-assignment" && entry.assignment === "missing-assignment")
  );
  assert.ok(invalidEntries.some((entry) => entry.id === "bad-kind"));
  assert.ok(invalidEntries.some((entry) => entry.id === "broken-not-object"));
});

test("missing required path fields are invalid rather than live or missing", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-targets-missing-field-"));
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
    codexHome: ${source}
    assignment: codex
`
  );

  const result = await targets({ source });
  const codexGlobal = result.targets.find((entry) => entry.id === "codex");

  assert.equal(result.ok, false);
  if (codexGlobal === undefined) {
    throw new Error("Expected codex target entry in fixture output.");
  }
  assert.equal(codexGlobal.safety.classification, "invalid");
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.code === "invalid_assignment_path" &&
        finding.path === "assignmentPaths.codex.skillsPath"
    )
  );
});
