import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseSuitcaseManifest } from "../src/suitcase-manifest.js";

test("parses the skills repo suitcase manifest shape", async () => {
  const manifestText = await readFile(
    "/Users/ngxcalvin/repos/skills/skill-suitcase.yaml",
    "utf8"
  );

  const manifest = parseSuitcaseManifest(manifestText);

  assert.deepEqual(manifest.suitcases.core.skills, ["office-hours"]);
  assert.deepEqual(manifest.suitcases["openclaw-builder"].skills, [
    "skillify",
    "gnhf-postflight"
  ]);
  assert.deepEqual(manifest.assignments.openclaw.suitcases, [
    "core",
    "openclaw-builder"
  ]);
  assert.equal(
    manifest.compatibility["gnhf-postflight"].blockedAgents.codex,
    "Live Codex copy is a slimmer platform variant and must not be overwritten by the OpenClaw canonical bundle."
  );
});
