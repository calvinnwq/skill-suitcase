import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assessPlanLock, buildPlanLock } from "../src/plan-lock.js";

const fixtureSource = path.join(import.meta.dirname, "fixtures", "skills-catalog");

test("buildPlanLock output is deterministic for the same source and plan context", async () => {
  const first = await buildPlanLock({
    source: fixtureSource,
    target: "openclaw",
    assignmentPath: "openclaw",
    sourceCommit: "deadbeef"
  });
  const second = await buildPlanLock({
    source: fixtureSource,
    target: "openclaw",
    assignmentPath: "openclaw",
    sourceCommit: "deadbeef"
  });

  assert.equal(first.planId, second.planId);
  assert.deepEqual(first, second);
  assert.equal(first.source.commit, "deadbeef");
  assert.equal(first.source.ref, "deadbeef");
  assert.deepEqual(first.selectedSkills, ["gnhf-postflight", "office-hours", "skillify"]);
  assert.deepEqual(Object.keys(first.fileHashes).sort(), ["gnhf-postflight", "office-hours", "skillify"]);
});

test("assessPlanLock detects source file hash drift", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-plan-lock-stale-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const skillRoot = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(skillRoot, "runtime.js"), "console.log(\"current\");\n");

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
    path: ${path.join(sourceRoot, "install-root")}
`
  );

  const lock = await buildPlanLock({
    source: sourceRoot,
    target: "openclaw",
    assignmentPath: "openclaw",
    sourceCommit: "deadbeef"
  });

  await writeFile(path.join(skillRoot, "runtime.js"), "console.log(\"updated\");\n");

  const status = await assessPlanLock({
    source: sourceRoot,
    target: "openclaw",
    assignmentPath: "openclaw",
    lock,
    sourceCommit: "deadbeef"
  });

  assert.equal(status.valid, false);
  assert.equal(
    status.current.fileHashes["office-hours"]["runtime.js"] !== lock.fileHashes["office-hours"]["runtime.js"],
    true
  );
  assert.ok(status.reasons.includes("file_hashes_changed"));
  assert.ok(status.reasons.includes("plan_id_changed"));
});

test("assessPlanLock returns valid when the lock matches the current plan state", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-plan-lock-valid-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const skillRoot = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(skillRoot, "runtime.js"), "console.log(\"current\");\n");

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
    path: ${path.join(sourceRoot, "install-root")}
`
  );

  const lock = await buildPlanLock({
    source: sourceRoot,
    target: "openclaw",
    assignmentPath: "openclaw",
    sourceCommit: "deadbeef"
  });

  const status = await assessPlanLock({
    source: sourceRoot,
    target: "openclaw",
    assignmentPath: "openclaw",
    lock,
    sourceCommit: "deadbeef"
  });

  assert.equal(status.valid, true);
  assert.deepEqual(status.reasons, []);
  assert.equal(status.current.planId, lock.planId);
});

test("assessPlanLock detects source commit drift even without file changes", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-plan-lock-commit-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const skillRoot = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(skillRoot, "runtime.js"), "console.log(\"current\");\n");

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
    path: ${path.join(sourceRoot, "install-root")}
`
  );

  const lock = await buildPlanLock({
    source: sourceRoot,
    target: "openclaw",
    assignmentPath: "openclaw",
    sourceCommit: "deadbeef"
  });

  const status = await assessPlanLock({
    source: sourceRoot,
    target: "openclaw",
    assignmentPath: "openclaw",
    lock,
    sourceCommit: "cafebabe"
  });

  assert.equal(status.valid, false);
  assert.ok(status.reasons.includes("source_commit_changed"));
  assert.ok(status.reasons.includes("source_ref_changed"));
  assert.ok(status.reasons.includes("plan_id_changed"));
});
