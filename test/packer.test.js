import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pack } from "../src/packer.js";

const fixtureSource = path.join(import.meta.dirname, "fixtures", "skills-catalog");

test("dry-run pack reports OpenClaw skill files without an output path", async () => {
  const result = await pack({ source: fixtureSource, target: "openclaw", dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.bundle.outputPath, null);
  assert.deepEqual(
    result.planned.map((item) => item.skill),
    ["office-hours", "skillify", "gnhf-postflight"]
  );
  assert.ok(result.files.length > 3);
  assert.ok(result.summary.bytes > 0);
  assert.ok(result.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(result.files.some((file) => file.bundlePath === "skills/office-hours/SKILL.md"));
});

test("dry-run pack follows target assignment scope", async () => {
  const result = await pack({ source: fixtureSource, target: "codex", dryRun: true });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.planned.map((item) => item.skill),
    ["office-hours"]
  );
  assert.ok(result.files.every((file) => file.skill === "office-hours"));
});

test("pack refuses non dry-run mode", async () => {
  await assert.rejects(
    () => pack({ source: fixtureSource, target: "openclaw", dryRun: false }),
    /--dry-run only/
  );
});

test("dry-run pack surfaces blocked plans without file enumeration", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-blocked-"));
  await mkdir(path.join(source, "skills", "gnhf-postflight"), { recursive: true });
  await writeFile(path.join(source, "skills", "gnhf-postflight", "SKILL.md"), "# GNHF\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  openclaw-builder:
    skills:
      - gnhf-postflight

assignments:
  codex:
    suitcases:
      - openclaw-builder

compatibility:
  gnhf-postflight:
    agents:
      - openclaw
    blockedAgents:
      codex: Codex must use the slimmer platform variant.
`
  );

  const result = await pack({ source, target: "codex", dryRun: true });

  assert.equal(result.ok, false);
  assert.equal(result.blocked[0].skill, "gnhf-postflight");
  assert.equal(result.summary.files, 0);
  assert.deepEqual(result.files, []);
});
