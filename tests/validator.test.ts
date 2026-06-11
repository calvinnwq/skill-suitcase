import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validate } from "../src/validator.js";

const fixtureSource = path.join(process.cwd(), "tests", "fixtures", "skills-catalog");

test("validates the skills repo fixture", async () => {
  const result = await validate({ source: fixtureSource });

  assert.equal(result.ok, true);
  assert.equal(result.summary.suitcases, 2);
  assert.equal(result.summary.assignments, 4);
  assert.equal(result.summary.assignmentPaths, 5);
  assert.equal(result.summary.referencedSkills, 3);
  assert.deepEqual(result.findings, []);
});

test("reports manifest relationship and filesystem errors", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-invalid-"));
  await mkdir(path.join(source, "skills", "office-hours"), { recursive: true });
  await writeFile(path.join(source, "skills", "office-hours", "SKILL.md"), "# Office Hours\n");
  await mkdir(path.join(source, "skills", "missing-skill-file"), { recursive: true });
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours
      - missing-skill-file
      - missing-directory

assignments:
  codex:
    suitcases:
      - core
      - missing-suitcase

assignmentPaths:
  broken:
    assignment: missing-assignment

compatibility:
  stale-skill:
    agents:
      - codex
`
  );

  const result = await validate({ source });
  const codes = result.findings.map((finding) => finding.code);

  assert.equal(result.ok, false);
  assert.equal(result.summary.findings, 5);
  assert.ok(codes.includes("unknown_suitcase"));
  assert.ok(codes.includes("missing_skill_file"));
  assert.ok(codes.includes("missing_skill_directory"));
  assert.ok(codes.includes("unknown_assignment_path_target"));
  assert.ok(codes.includes("unused_compatibility"));
});
