import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { test } from "node:test";

// NGX-493 acceptance dogfood: prove that an intentional local edit to a
// catalog-owned skill in a modeled writable target can be imported back into the
// repo through the real CLI, then validated with `import`, `validate`, and
// status/diff checks. Unlike import-target.test.ts (which drives the in-process
// core), this walks the shipped command surface end to end the way an operator
// would, so it catches regressions where the slices stop composing.

function runCli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync("node", [path.join(process.cwd(), "dist", "src", "cli.js"), ...args], {
    encoding: "utf8"
  });
}

function parseJson<T>(result: SpawnSyncReturns<string>): T {
  assert.equal(result.status, 0, `expected exit 0 but got ${result.status}: ${result.stderr}`);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.trim()) as T;
}

type StatusSummary = {
  current: number;
  behind: number;
  version: number;
  dirty: number;
  missing: number;
  unknown: number;
  blocked: number;
};

type StatusResult = {
  ok: boolean;
  summary: StatusSummary;
  statuses: Array<{ skill: string; status: string }>;
};

type ImportTargetApplyResult = {
  ok: boolean;
  imported: { skills: string[]; files: number };
  receiptPath: string | null;
  postImportStatus: { summary: StatusSummary } | null;
};

type ImportInspectResult = {
  ok: boolean;
  summary: { errors: number; findings: number; discoveredSkills: number; referencedSkills: number };
  skills: Array<{ name: string }>;
};

type ValidateResult = {
  ok: boolean;
  findings: Array<{ level: string }>;
};

type DiffResult = {
  ok: boolean;
  summary: { create: number; update: number; unchanged: number; extra: number; missing: number; blocked: number };
};

const SKILL_MD = "---\nname: skill-cleaner\nversion: 2026.06.20\n---\n# Skill Cleaner\n";
const CATALOG_RUNTIME = "console.log(\"catalog\");\n";
const LOCAL_RUNTIME = "console.log(\"locally edited\");\n";
const LOCAL_EXTRA = "console.log(\"local extra\");\n";

function manifest(targetRoot: string): string {
  return `suitcases:
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
`;
}

test("dogfood: an intentional local edit imports into the catalog and validates through the real CLI", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-dogfood-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-dogfood-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "skill-cleaner");
  const targetSkill = path.join(targetRoot, "skill-cleaner");

  // 1. The catalog is the source of truth and the live target matches it exactly.
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), SKILL_MD);
  await writeFile(path.join(sourceSkill, "runtime.js"), CATALOG_RUNTIME);
  await writeFile(path.join(sourceRoot, "skill-suitcase.yaml"), manifest(targetRoot));

  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), SKILL_MD);
  await writeFile(path.join(targetSkill, "runtime.js"), CATALOG_RUNTIME);

  // Adopt the matching target so it is receipt-owned and reads `current`.
  const tracked = parseJson<{ ok: boolean }>(
    runCli(["track", "--source", sourceRoot, "--target", "openclaw", "--skill", "skill-cleaner", "--json"])
  );
  assert.equal(tracked.ok, true);

  // 2. The operator intentionally edits the live target: a changed file and a new file.
  await writeFile(path.join(targetSkill, "runtime.js"), LOCAL_RUNTIME);
  await writeFile(path.join(targetSkill, "extra.js"), LOCAL_EXTRA);

  // 3. The lightweight drift heartbeat (status) surfaces the dirty target that an
  //    operator must explicitly approve before importing.
  const drift = parseJson<StatusResult>(
    runCli(["status", "--source", sourceRoot, "--target", "openclaw", "--json"])
  );
  assert.equal(drift.summary.dirty, 1, "heartbeat: the edited target should read dirty before import");
  assert.equal(drift.summary.current, 0);
  assert.equal(drift.statuses[0]?.status, "dirty");

  // 4. With approval, import the intentional edit back into the catalog source path.
  const imported = parseJson<ImportTargetApplyResult>(
    runCli(["import-target", "--source", sourceRoot, "--target", "openclaw", "--skill", "skill-cleaner", "--apply", "--json"])
  );
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.imported.skills, ["skill-cleaner"]);
  // SKILL.md, runtime.js, and the new extra.js all land in the catalog.
  assert.equal(imported.imported.files, 3);
  assert.equal(typeof imported.receiptPath, "string");
  assert.equal(imported.postImportStatus?.summary.current, 1);
  assert.equal(imported.postImportStatus?.summary.dirty, 0);

  // The catalog now carries the edit; the live target is the untouched source.
  assert.equal(await readFile(path.join(sourceSkill, "runtime.js"), "utf8"), LOCAL_RUNTIME);
  assert.equal(await readFile(path.join(sourceSkill, "extra.js"), "utf8"), LOCAL_EXTRA);
  assert.equal(await readFile(path.join(sourceSkill, "SKILL.md"), "utf8"), SKILL_MD);
  assert.equal(await readFile(path.join(targetSkill, "runtime.js"), "utf8"), LOCAL_RUNTIME);

  // 5. Validate the imported catalog with the operator's verification loop.

  // `import` inspects the catalog as an import source and finds the skill cleanly.
  const inspected = parseJson<ImportInspectResult>(runCli(["import", "--source", sourceRoot, "--json"]));
  assert.equal(inspected.ok, true);
  assert.equal(inspected.summary.errors, 0);
  assert.equal(inspected.summary.discoveredSkills, 1);
  assert.equal(inspected.summary.referencedSkills, 1);
  assert.deepEqual(inspected.skills.map((skill) => skill.name), ["skill-cleaner"]);

  // `validate` confirms the catalog has no error-level findings.
  const validated = parseJson<ValidateResult>(runCli(["validate", "--source", sourceRoot, "--json"]));
  assert.equal(validated.ok, true);
  assert.equal(validated.findings.filter((finding) => finding.level === "error").length, 0);

  // status now reads `current`: the target matches the freshly-imported catalog.
  const settled = parseJson<StatusResult>(
    runCli(["status", "--source", sourceRoot, "--target", "openclaw", "--json"])
  );
  assert.equal(settled.summary.current, 1);
  assert.equal(settled.summary.dirty, 0);
  assert.equal(settled.statuses[0]?.status, "current");

  // diff confirms catalog and target are byte-for-byte in sync: no pending writes.
  const settledDiff = parseJson<DiffResult>(
    runCli(["diff", "--source", sourceRoot, "--target", "openclaw", "--json"])
  );
  assert.equal(settledDiff.ok, true);
  assert.equal(settledDiff.summary.create, 0);
  assert.equal(settledDiff.summary.update, 0);
  assert.equal(settledDiff.summary.extra, 0);
  assert.equal(settledDiff.summary.missing, 0);
  assert.equal(settledDiff.summary.blocked, 0);
  assert.equal(settledDiff.summary.unchanged, 3);
});
