import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { plan } from "../src/planner.js";

const fixtureSource = path.join(process.cwd(), "tests", "fixtures", "skills-catalog");

test("openclaw plans the full OpenClaw builder assignment", async () => {
  const result = await plan({ source: fixtureSource, target: "openclaw" });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.planned.map((item) => item.skill),
    ["office-hours", "skillify", "gnhf-postflight"]
  );
  assert.deepEqual(result.blocked, []);
});

test("codex plans only portable core skills", async () => {
  const result = await plan({ source: fixtureSource, target: "codex" });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.planned.map((item) => item.skill),
    ["office-hours"]
  );
  assert.deepEqual(result.blocked, []);
});

test("openclaw-kody-codex plans only portable core skills", async () => {
  const result = await plan({ source: fixtureSource, target: "openclaw-kody-codex" });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.planned.map((item) => item.skill),
    ["office-hours"]
  );
  assert.deepEqual(result.blocked, []);
});

test("claude plans only portable core skills", async () => {
  const result = await plan({ source: fixtureSource, target: "claude" });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.planned.map((item) => item.skill),
    ["office-hours"]
  );
  assert.deepEqual(result.blocked, []);
});

test("unknown targets return a machine-readable error", async () => {
  const result = await plan({ source: fixtureSource, target: "unknown" });

  assert.equal(result.ok, false);
  assert.deepEqual(result.planned, []);
  assert.equal(result.errors.length > 0, true);
  const [error] = result.errors;
  assert.equal(error?.code, "unknown_target");
});

test("blocked canonical installs carry the manifest reason", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-blocked-"));
  await mkdir(path.join(source, "skills", "office-hours"), { recursive: true });
  await mkdir(path.join(source, "skills", "gnhf-postflight"), { recursive: true });
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours
  openclaw-builder:
    skills:
      - gnhf-postflight

assignments:
  codex:
    suitcases:
      - core
      - openclaw-builder

compatibility:
  office-hours:
    agents:
      - codex
    variant: canonical

  gnhf-postflight:
    agents:
      - openclaw
    variant: canonical
    reason: OpenClaw-only canonical bundle.
    blockedAgents:
      codex: Codex must use the slimmer platform variant.
`
  );

  const result = await plan({ source, target: "codex" });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.planned.map((item) => item.skill),
    ["office-hours"]
  );
  assert.equal(result.blocked.length > 0, true);
  const [blockedItem] = result.blocked;
  assert.equal(blockedItem?.skill, "gnhf-postflight");
  assert.equal(
    blockedItem?.reason,
    "Codex must use the slimmer platform variant."
  );
});

test("blocked platform variants use assignment path adapter metadata instead of target name heuristics", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-platform-blocked-"));
  const codexHome = path.join(source, "codex-home");
  await mkdir(path.join(source, "skills", "gnhf-postflight"), { recursive: true });
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  builder:
    skills:
      - gnhf-postflight

assignments:
  builder:
    suitcases:
      - builder

assignmentPaths:
  global-tools:
    kind: codex-home
    assignment: builder
    codexHome: ${codexHome}
    skillsPath: ${path.join(codexHome, "skills")}

compatibility:
  gnhf-postflight:
    agents:
      - openclaw
    variant: canonical
    reason: Generic incompatibility reason.
    blockedAgents:
      codex: Codex must use the slimmer platform variant.
`
  );

  const result = await plan({ source, target: "builder" });

  assert.equal(result.ok, false);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0]?.skill, "gnhf-postflight");
  assert.equal(
    result.blocked[0]?.reason,
    "Codex must use the slimmer platform variant."
  );
});
