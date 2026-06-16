import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RECEIPT_FILE, type Receipt, type ReceiptInstallRecord } from "../src/receipt.js";
import { status } from "../src/status.js";
import { track } from "../src/track.js";

async function writeOpenClawCatalog(sourceRoot: string, targetRoot: string): Promise<void> {
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:\n  core:\n    skills:\n      - office-hours\n  openclaw-builder:\n    skills:\n      - gnhf-postflight\n\nassignments:\n  openclaw:\n    suitcases:\n      - core\n      - openclaw-builder\n\nassignmentPaths:\n  openclaw:\n    kind: openclaw-skills-root\n    assignment: openclaw\n    path: ${targetRoot}\n\ncompatibility:\n  office-hours:\n    agents:\n      - openclaw\n    variant: canonical\n  gnhf-postflight:\n    agents:\n      - openclaw\n    variant: canonical\n`
  );
}

async function createLiveMatchingInstall(t: { after(fn: () => Promise<void> | void): void }): Promise<{
  sourceRoot: string;
  targetRoot: string;
}> {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  const fixtureRoot = path.join(process.cwd(), "tests", "fixtures", "skills-catalog", "skills");
  await mkdir(path.join(sourceRoot, "skills"), { recursive: true });
  await cp(path.join(fixtureRoot, "office-hours"), path.join(sourceRoot, "skills", "office-hours"), { recursive: true });
  await cp(path.join(fixtureRoot, "gnhf-postflight"), path.join(sourceRoot, "skills", "gnhf-postflight"), { recursive: true });
  await cp(path.join(sourceRoot, "skills", "office-hours"), path.join(targetRoot, "office-hours"), { recursive: true });
  await cp(path.join(sourceRoot, "skills", "gnhf-postflight"), path.join(targetRoot, "gnhf-postflight"), { recursive: true });
  await writeOpenClawCatalog(sourceRoot, targetRoot);

  return { sourceRoot, targetRoot };
}

async function createTargetedTrackInstall(t: { after(fn: () => Promise<void> | void): void }): Promise<{
  sourceRoot: string;
  targetRoot: string;
}> {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-targeted-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-targeted-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  const skillsRoot = path.join(sourceRoot, "skills");
  await mkdir(skillsRoot, { recursive: true });
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:\n  core:\n    skills:\n      - office-hours\n      - skillify\n      - gnhf-postflight\n      - improve\n\nassignments:\n  openclaw:\n    suitcases:\n      - core\n\nassignmentPaths:\n  openclaw:\n    kind: openclaw-skills-root\n    assignment: openclaw\n    path: ${targetRoot}\n\ncompatibility:\n  office-hours:\n    agents:\n      - openclaw\n    variant: canonical\n  skillify:\n    agents:\n      - openclaw\n    variant: canonical\n  gnhf-postflight:\n    agents:\n      - openclaw\n    variant: canonical\n  improve:\n    agents:\n      - openclaw\n    variant: canonical\n`
  );

  for (const skill of ["office-hours", "skillify", "gnhf-postflight", "improve"]) {
    const skillRoot = path.join(skillsRoot, skill);
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), `---\nname: ${skill}\nversion: "2026.06.14"\n---\n# ${skill}\n`);
    await writeFile(path.join(skillRoot, "runtime.js"), `console.log("${skill}");\n`);
  }

  for (const skill of ["office-hours", "skillify", "gnhf-postflight"]) {
    await cp(path.join(skillsRoot, skill), path.join(targetRoot, skill), { recursive: true });
  }

  return { sourceRoot, targetRoot };
}

function singleRecord(receipt: Receipt, skill: string): ReceiptInstallRecord {
  const value = receipt.installs?.[skill];
  if (value === undefined) {
    throw new Error(`Missing receipt for ${skill}.`);
  }
  if (Array.isArray(value)) {
    const first = value[0];
    if (first === undefined || value.length !== 1) {
      throw new Error(`Expected one receipt for ${skill}.`);
    }
    return first;
  }
  return value;
}

test("track records existing matching office-hours and OpenClaw gnhf-postflight installs without rewriting files", async (t) => {
  const { sourceRoot, targetRoot } = await createLiveMatchingInstall(t);
  const officeSkillFile = path.join(targetRoot, "office-hours", "SKILL.md");
  const gnhfSkillFile = path.join(targetRoot, "gnhf-postflight", "SKILL.md");
  const beforeOffice = await stat(officeSkillFile);
  const beforeGnhf = await stat(gnhfSkillFile);

  const result = await track({ source: sourceRoot, target: "openclaw" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.tracked.skills, ["gnhf-postflight", "office-hours"]);
  assert.equal(result.tracked.files > 2, true);
  assert.equal((await stat(officeSkillFile)).mtimeMs, beforeOffice.mtimeMs);
  assert.equal((await stat(gnhfSkillFile)).mtimeMs, beforeGnhf.mtimeMs);

  const receipt = JSON.parse(await readFile(path.join(targetRoot, RECEIPT_FILE), "utf8")) as Receipt;
  const officeRecord = singleRecord(receipt, "office-hours");
  const gnhfRecord = singleRecord(receipt, "gnhf-postflight");
  assert.equal(officeRecord.mode, "track");
  assert.equal(gnhfRecord.mode, "track");
  assert.equal(typeof officeRecord.sourceHash, "string");
  assert.equal(typeof gnhfRecord.sourceHash, "string");
  assert.equal(Array.isArray(officeRecord.installedFiles), true);
  assert.equal(Array.isArray(gnhfRecord.installedFiles), true);

  const statusResult = await status({ source: sourceRoot });
  assert.equal(statusResult.ok, true);
  assert.equal(statusResult.summary.current, 2);
});

test("track refuses provider-modeled read-only targets without creating roots", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-provider-src-"));
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-provider-home-"));
  const opencodeRoot = path.join(fakeHome, ".config", "opencode", "skills");
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(fakeHome, { recursive: true, force: true }));

  await mkdir(path.join(sourceRoot, "skills", "office-hours"), { recursive: true });
  await writeFile(path.join(sourceRoot, "skills", "office-hours", "SKILL.md"), "---\nname: office-hours\n---\n");
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:

assignmentPaths:
`
  );

  const result = await track({
    source: sourceRoot,
    target: "opencode",
    targetOverrides: {
      home: fakeHome
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.installRoot, opencodeRoot);
  assert.ok(result.errors.some((error) => error.code === "read_only_target"));
  await assert.rejects(() => stat(opencodeRoot));
});

test("track refuses canonical gnhf-postflight for Codex slimmer variant targets", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-codex-blocked-src-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-codex-blocked-home-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(codexHome, { recursive: true, force: true }));

  const skillsPath = path.join(codexHome, "skills");
  const fixtureRoot = path.join(process.cwd(), "tests", "fixtures", "skills-catalog", "skills");
  await mkdir(path.join(sourceRoot, "skills"), { recursive: true });
  await cp(path.join(fixtureRoot, "gnhf-postflight"), path.join(sourceRoot, "skills", "gnhf-postflight"), { recursive: true });
  await mkdir(path.join(skillsPath, "gnhf-postflight"), { recursive: true });
  await writeFile(path.join(skillsPath, "gnhf-postflight", "SKILL.md"), "# Slim Codex variant\n");
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  builder:
    skills:
      - gnhf-postflight

assignments:
  codex:
    suitcases:
      - builder

assignmentPaths:
  codex:
    kind: codex-home
    assignment: codex
    codexHome: ${codexHome}
    skillsPath: ${skillsPath}

compatibility:
  gnhf-postflight:
    agents:
      - openclaw
    variant: canonical
    blockedAgents:
      codex: Codex must use the slimmer platform variant.
`
  );

  const result = await track({ source: sourceRoot, target: "codex" });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "blocked_skill"), true);
  assert.equal(result.summary.blocked, 1);
  await assert.rejects(readFile(path.join(skillsPath, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("track records versions with the same frontmatter semantics as status", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-version-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-version-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:\n  core:\n    skills:\n      - office-hours\n\nassignments:\n  openclaw:\n    suitcases:\n      - core\n\nassignmentPaths:\n  openclaw:\n    kind: openclaw-skills-root\n    assignment: openclaw\n    path: ${targetRoot}\n`
  );
  await writeFile(
    path.join(sourceSkill, "SKILL.md"),
    "---\r\nname: office-hours\r\nversion: \"2026.06.10\"\r\n---\r\n# Office Hours\r\n"
  );
  await cp(sourceSkill, path.join(targetRoot, "office-hours"), { recursive: true });

  const result = await track({ source: sourceRoot, target: "openclaw" });

  assert.equal(result.ok, true);
  const receipt = JSON.parse(await readFile(path.join(targetRoot, RECEIPT_FILE), "utf8")) as Receipt;
  assert.equal(singleRecord(receipt, "office-hours").version, "\"2026.06.10\"");

  const statusResult = await status({ source: sourceRoot });
  assert.equal(statusResult.ok, true);
  assert.equal(statusResult.summary.current, 1);
  assert.equal(statusResult.statuses[0]?.currentVersion, "\"2026.06.10\"");
});

test("targeted track adopts selected unchanged skills while ignoring unselected create candidates", async (t) => {
  const { sourceRoot, targetRoot } = await createTargetedTrackInstall(t);
  const beforeImprove = await readFile(path.join(sourceRoot, "skills", "improve", "runtime.js"), "utf8");

  const result = await track({
    source: sourceRoot,
    target: "openclaw",
    skills: ["office-hours", "skillify", "gnhf-postflight"]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.selected.skills, ["gnhf-postflight", "office-hours", "skillify"]);
  assert.deepEqual(result.tracked.skills, ["gnhf-postflight", "office-hours", "skillify"]);
  assert.deepEqual(result.refused.skills, []);
  assert.equal(result.summary.planned, 3);
  assert.equal(result.summary.tracked, 3);
  await assert.rejects(readFile(path.join(targetRoot, "improve", "runtime.js"), "utf8"), /ENOENT/);
  assert.equal(await readFile(path.join(sourceRoot, "skills", "improve", "runtime.js"), "utf8"), beforeImprove);

  const receipt = JSON.parse(await readFile(path.join(targetRoot, RECEIPT_FILE), "utf8")) as Receipt;
  assert.equal(singleRecord(receipt, "office-hours").mode, "track");
  assert.equal(singleRecord(receipt, "skillify").mode, "track");
  assert.equal(singleRecord(receipt, "gnhf-postflight").mode, "track");
  assert.equal(receipt.installs?.improve, undefined);
});

test("targeted track ignores source listing errors for unselected planned skills", async (t) => {
  const { sourceRoot, targetRoot } = await createTargetedTrackInstall(t);
  const unreadableImprovePath = path.join(sourceRoot, "skills", "improve", "unreadable");
  await mkdir(unreadableImprovePath, { recursive: true });
  await chmod(unreadableImprovePath, 0o000);
  t.after(() => chmod(unreadableImprovePath, 0o755).catch(() => undefined));

  const result = await track({
    source: sourceRoot,
    target: "openclaw",
    skills: ["office-hours", "skillify", "gnhf-postflight"]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.tracked.skills, ["gnhf-postflight", "office-hours", "skillify"]);
  assert.deepEqual(result.refused.skills, []);

  const receipt = JSON.parse(await readFile(path.join(targetRoot, RECEIPT_FILE), "utf8")) as Receipt;
  assert.equal(singleRecord(receipt, "office-hours").mode, "track");
  assert.equal(singleRecord(receipt, "skillify").mode, "track");
  assert.equal(singleRecord(receipt, "gnhf-postflight").mode, "track");
  assert.equal(receipt.installs?.improve, undefined);
});

test("targeted track ignores missing source directories for unselected planned skills", async (t) => {
  const { sourceRoot, targetRoot } = await createTargetedTrackInstall(t);
  await rm(path.join(sourceRoot, "skills", "improve"), { recursive: true, force: true });

  const result = await track({
    source: sourceRoot,
    target: "openclaw",
    skills: ["office-hours", "skillify", "gnhf-postflight"]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.tracked.skills, ["gnhf-postflight", "office-hours", "skillify"]);
  assert.deepEqual(result.refused.skills, []);

  const receipt = JSON.parse(await readFile(path.join(targetRoot, RECEIPT_FILE), "utf8")) as Receipt;
  assert.equal(singleRecord(receipt, "office-hours").mode, "track");
  assert.equal(singleRecord(receipt, "skillify").mode, "track");
  assert.equal(singleRecord(receipt, "gnhf-postflight").mode, "track");
  assert.equal(receipt.installs?.improve, undefined);
});

test("targeted track refuses blank skill filters without writing receipts", async (t) => {
  const { sourceRoot, targetRoot } = await createTargetedTrackInstall(t);

  const result = await track({
    source: sourceRoot,
    target: "openclaw",
    skills: ["   "]
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.selected.skills, []);
  assert.deepEqual(result.tracked.skills, []);
  assert.equal(result.errors[0]?.code, "invalid_skill_filter");
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("targeted track refuses selected missing source directories without throwing", async (t) => {
  const { sourceRoot, targetRoot } = await createTargetedTrackInstall(t);
  await rm(path.join(sourceRoot, "skills", "improve"), { recursive: true, force: true });

  const result = await track({
    source: sourceRoot,
    target: "openclaw",
    skills: ["improve"]
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.selected.skills, ["improve"]);
  assert.deepEqual(result.tracked.skills, []);
  assert.deepEqual(result.refused.skills, ["improve"]);
  assert.equal(result.summary.refused, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.code, "source_missing");
  assert.equal(result.errors[0]?.skill, "improve");
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("track without skill filters preserves all-or-nothing create refusal", async (t) => {
  const { sourceRoot, targetRoot } = await createTargetedTrackInstall(t);

  const result = await track({ source: sourceRoot, target: "openclaw" });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_missing" && error.skill === "improve"), true);
  assert.deepEqual(result.tracked.skills, []);
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("targeted track refuses selected create, update, and extra entries without writing receipts", async (t) => {
  const { sourceRoot, targetRoot } = await createTargetedTrackInstall(t);
  await writeFile(path.join(targetRoot, "skillify", "runtime.js"), "console.log(\"changed\");\n");
  await writeFile(path.join(targetRoot, "gnhf-postflight", "extra.txt"), "extra\n");

  const result = await track({
    source: sourceRoot,
    target: "openclaw",
    skills: ["improve", "skillify", "gnhf-postflight"]
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.selected.skills, ["gnhf-postflight", "improve", "skillify"]);
  assert.deepEqual(result.refused.skills, ["gnhf-postflight", "improve", "skillify"]);
  assert.equal(result.errors.some((error) => error.code === "target_missing" && error.skill === "improve"), true);
  assert.equal(result.errors.some((error) => error.code === "target_mismatch" && error.skill === "skillify"), true);
  assert.equal(result.errors.some((error) => error.code === "target_mismatch" && error.skill === "gnhf-postflight"), true);
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("targeted track refuses blocked and non-planned selected skills", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-targeted-blocked-src-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-targeted-blocked-home-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(codexHome, { recursive: true, force: true }));

  const skillsPath = path.join(codexHome, "skills");
  const fixtureRoot = path.join(process.cwd(), "tests", "fixtures", "skills-catalog", "skills");
  await mkdir(path.join(sourceRoot, "skills"), { recursive: true });
  await cp(path.join(fixtureRoot, "gnhf-postflight"), path.join(sourceRoot, "skills", "gnhf-postflight"), { recursive: true });
  await mkdir(path.join(skillsPath, "gnhf-postflight"), { recursive: true });
  await writeFile(path.join(skillsPath, "gnhf-postflight", "SKILL.md"), "# Slim Codex variant\n");
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:\n  builder:\n    skills:\n      - gnhf-postflight\n\nassignments:\n  codex:\n    suitcases:\n      - builder\n\nassignmentPaths:\n  codex:\n    kind: codex-home\n    assignment: codex\n    codexHome: ${codexHome}\n    skillsPath: ${skillsPath}\n\ncompatibility:\n  gnhf-postflight:\n    agents:\n      - openclaw\n    variant: canonical\n    blockedAgents:\n      codex: Codex must use the slimmer platform variant.\n`
  );

  const result = await track({
    source: sourceRoot,
    target: "codex",
    skills: ["gnhf-postflight", "office-hours"]
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.selected.skills, ["gnhf-postflight", "office-hours"]);
  assert.deepEqual(result.refused.skills, ["gnhf-postflight", "office-hours"]);
  assert.equal(result.errors.some((error) => error.code === "blocked_skill" && error.skill === "gnhf-postflight"), true);
  assert.equal(result.errors.some((error) => error.code === "skill_not_planned" && error.skill === "office-hours"), true);
  await assert.rejects(readFile(path.join(skillsPath, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("track refuses dirty targets and does not write receipts", async (t) => {
  const { sourceRoot, targetRoot } = await createLiveMatchingInstall(t);
  await writeFile(path.join(targetRoot, "gnhf-postflight", "failure_patterns.yaml"), "dirty\n");

  const result = await track({ source: sourceRoot, target: "openclaw" });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_mismatch"), true);
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("track refuses missing live installs", async (t) => {
  const { sourceRoot, targetRoot } = await createLiveMatchingInstall(t);
  await rm(path.join(targetRoot, "office-hours"), { recursive: true, force: true });

  const result = await track({ source: sourceRoot, target: "openclaw" });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_missing"), true);
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("track refuses planned skills whose target directory is absent", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-empty-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-empty-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:\n  core:\n    skills:\n      - office-hours\n\nassignments:\n  openclaw:\n    suitcases:\n      - core\n\nassignmentPaths:\n  openclaw:\n    kind: openclaw-skills-root\n    assignment: openclaw\n    path: ${targetRoot}\n`
  );
  await mkdir(path.join(sourceRoot, "skills", "office-hours"), { recursive: true });

  const result = await track({ source: sourceRoot, target: "openclaw" });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_missing"), true);
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("track reports unreadable target scans without throwing", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-file-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-file-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:\n  core:\n    skills:\n      - office-hours\n\nassignments:\n  openclaw:\n    suitcases:\n      - core\n\nassignmentPaths:\n  openclaw:\n    kind: openclaw-skills-root\n    assignment: openclaw\n    path: ${targetRoot}\n`
  );
  await mkdir(path.join(sourceRoot, "skills", "office-hours"), { recursive: true });
  await writeFile(path.join(targetRoot, "office-hours"), "not a directory\n");

  const result = await track({ source: sourceRoot, target: "openclaw" });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_unreadable"), true);
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("track refuses symlinked target trees", async (t) => {
  const { sourceRoot, targetRoot } = await createLiveMatchingInstall(t);
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-symlink-outside-"));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));

  const sourceNested = path.join(sourceRoot, "skills", "office-hours", "nested");
  await mkdir(sourceNested, { recursive: true });
  await writeFile(path.join(sourceNested, "payload.txt"), "same\n");
  await writeFile(path.join(outsideRoot, "payload.txt"), "same\n");
  await symlink(outsideRoot, path.join(targetRoot, "office-hours", "nested"), "dir");

  const result = await track({ source: sourceRoot, target: "openclaw" });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_symlink"), true);
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("track reports receipt write failures without partial adoption", async (t) => {
  const { sourceRoot, targetRoot } = await createLiveMatchingInstall(t);
  await chmod(targetRoot, 0o555);

  let result: Awaited<ReturnType<typeof track>> | undefined;
  try {
    result = await track({ source: sourceRoot, target: "openclaw" });
  } finally {
    await chmod(targetRoot, 0o755).catch(() => undefined);
  }

  assert.ok(result);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "receipt_write_failed"), true);
  assert.equal(result.summary.tracked, 0);
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

async function createSymlinkAdoptionFixture(t: { after(fn: () => Promise<void> | void): void }): Promise<{
  sourceRoot: string;
  targetRoot: string;
  sourceSkillPath: string;
  targetSkillPath: string;
}> {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-symlink-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-symlink-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  const sourceSkillPath = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkillPath, { recursive: true });
  await writeFile(
    path.join(sourceSkillPath, "SKILL.md"),
    `---\nname: office-hours\nversion: "2026.06.14"\n---\n# office-hours\n`
  );
  await writeFile(path.join(sourceSkillPath, "runtime.js"), `console.log("office-hours");\n`);

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:\n  core:\n    skills:\n      - office-hours\n\nassignments:\n  openclaw:\n    suitcases:\n      - core\n\nassignmentPaths:\n  openclaw:\n    kind: openclaw-skills-root\n    assignment: openclaw\n    path: ${targetRoot}\n\ncompatibility:\n  office-hours:\n    agents:\n      - openclaw\n    variant: canonical\n`
  );

  const targetSkillPath = path.join(targetRoot, "office-hours");
  await symlink(sourceSkillPath, targetSkillPath, "dir");

  return { sourceRoot, targetRoot, sourceSkillPath, targetSkillPath };
}

test("track adopts an existing correct symlink as symlink mode without rewriting files", async (t) => {
  const { sourceRoot, targetRoot, sourceSkillPath, targetSkillPath } = await createSymlinkAdoptionFixture(t);

  const result = await track({ source: sourceRoot, target: "openclaw" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.tracked.skills, ["office-hours"]);
  // Adoption must not replace the symlink with copied files.
  assert.equal((await lstat(targetSkillPath)).isSymbolicLink(), true);

  const receipt = JSON.parse(await readFile(path.join(targetRoot, RECEIPT_FILE), "utf8")) as Receipt;
  const officeRecord = singleRecord(receipt, "office-hours");
  assert.equal(officeRecord.mode, "symlink");
  assert.equal(officeRecord.sourcePath, sourceSkillPath);
  assert.equal(typeof officeRecord.sourceHash, "string");

  const statusResult = await status({ source: sourceRoot });
  assert.equal(statusResult.ok, true);
  assert.equal(statusResult.summary.current, 1);
});

test("track refuses a target symlink that points at the wrong source path", async (t) => {
  const { sourceRoot, targetRoot, sourceSkillPath, targetSkillPath } = await createSymlinkAdoptionFixture(t);
  // Repoint the install symlink at a decoy with identical content so the diff
  // still sees an unchanged tree but the link target is not the selected source.
  const decoyPath = path.join(sourceRoot, "skills", "office-hours-decoy");
  await cp(sourceSkillPath, decoyPath, { recursive: true });
  await rm(targetSkillPath, { force: true });
  await symlink(decoyPath, targetSkillPath, "dir");

  const result = await track({ source: sourceRoot, target: "openclaw" });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_symlink_mismatch"), true);
  assert.equal((await lstat(targetSkillPath)).isSymbolicLink(), true);
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});
