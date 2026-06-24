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
  assert.equal(result.summary.assignmentPaths, 4);
  assert.equal(result.summary.groups, 3);
  assert.equal(result.summary.upstreamDeclarations, 0);
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

groups:
  bad/group:
    skills:
      - missing-group-skill
    suitcases:
      - missing-group-suitcase
    assignments:
      - missing-group-assignment

compatibility:
  stale-skill:
    agents:
      - codex
`
  );

  const result = await validate({ source });
  const codes = result.findings.map((finding) => finding.code);

  assert.equal(result.ok, false);
  assert.equal(result.summary.findings, 9);
  assert.ok(codes.includes("unknown_suitcase"));
  assert.ok(codes.includes("missing_skill_file"));
  assert.ok(codes.includes("missing_skill_directory"));
  assert.ok(codes.includes("unknown_assignment_path_target"));
  assert.ok(codes.includes("invalid_group"));
  assert.ok(codes.includes("unknown_group_skill"));
  assert.ok(codes.includes("unknown_group_suitcase"));
  assert.ok(codes.includes("unknown_group_assignment"));
  assert.ok(codes.includes("unused_compatibility"));
});

test("reports invalid source policy metadata", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-invalid-source-policy-"));
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

sourcePolicy:
  exclude:
    - ../outside
  deny:
    - secrets/../token
`
  );

  const result = await validate({ source });
  const policyFindings = result.findings.filter((finding) => finding.path?.startsWith("sourcePolicy"));

  assert.equal(result.ok, false);
  assert.deepEqual(
    policyFindings.map((finding) => finding.code),
    ["invalid_source_policy_pattern", "invalid_source_policy_pattern"]
  );
});

test("validates upstream lock metadata when present", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upstream-valid-"));
  await mkdir(path.join(source, "skills", "hyperframes"), { recursive: true });
  await mkdir(path.join(source, ".skill-suitcase"), { recursive: true });
  await writeFile(path.join(source, "skills", "hyperframes", "SKILL.md"), "# HyperFrames\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - hyperframes

assignments:
  codex:
    suitcases:
      - core
`
  );
  await writeFile(
    path.join(source, ".skill-suitcase", "upstream-lock.json"),
    `${JSON.stringify({
      schema: "calvinnwq.skills.upstream-lock.v0",
      skills: {
        hyperframes: {
          provider: "skills-sh",
          packageVersion: "1.0.0",
          upstream: {
            repo: "heygen-com/hyperframes",
            skill: "hyperframes"
          },
          group: "hyperframes"
        }
      }
    }, null, 2)}\n`
  );

  const result = await validate({ source });

  assert.equal(result.ok, true);
  assert.equal(result.summary.upstreamDeclarations, 1);
  assert.deepEqual(result.findings, []);
});

test("reports malformed upstream lock metadata deterministically", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upstream-invalid-"));
  await mkdir(path.join(source, "skills", "hyperframes"), { recursive: true });
  await mkdir(path.join(source, ".skill-suitcase"), { recursive: true });
  await writeFile(path.join(source, "skills", "hyperframes", "SKILL.md"), "# HyperFrames\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - hyperframes

assignments:
  codex:
    suitcases:
      - core
`
  );
  await writeFile(
    path.join(source, ".skill-suitcase", "upstream-lock.json"),
    `${JSON.stringify({
      schema: "wrong",
      skills: {
        "bad/name": {
          provider: "unknown"
        },
        hyperframes: {
          provider: "skills-sh",
          packageVersion: "latest",
          upstream: {}
        }
      }
    }, null, 2)}\n`
  );

  const result = await validate({ source });
  const codes = result.findings.map((finding) => finding.code);

  assert.equal(result.ok, false);
  assert.ok(codes.includes("invalid_upstream_lock_schema"));
  assert.ok(codes.includes("invalid_upstream_skill_name"));
  assert.ok(codes.includes("invalid_upstream_package_version"));
  assert.ok(codes.includes("invalid_upstream_identity"));
});
