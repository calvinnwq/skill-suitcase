import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { parseSuitcaseManifest } from "../src/suitcase-manifest.js";

test("parses the skills repo suitcase manifest shape", async () => {
  const manifestText = await readFile(
    path.join(process.cwd(), "tests", "fixtures", "skills-catalog", "skill-suitcase.yaml"),
    "utf8"
  );

  const manifest = parseSuitcaseManifest(manifestText);
  const core = manifest.suitcases.core;
  const openclawBuilder = manifest.suitcases["openclaw-builder"];
  const openclawAssignment = manifest.assignments.openclaw;
  const codexGlobal = manifest.assignmentPaths["codex-global"];
  const gnhfCompatibility = manifest.compatibility["gnhf-postflight"];

  assert.ok(core);
  assert.ok(openclawBuilder);
  assert.ok(openclawAssignment);
  assert.ok(codexGlobal);
  assert.ok(gnhfCompatibility);
  assert.ok(gnhfCompatibility.blockedAgents);

  assert.deepEqual(core.skills, ["office-hours"]);
  assert.deepEqual(openclawBuilder.skills, [
    "skillify",
    "gnhf-postflight"
  ]);
  assert.deepEqual(openclawAssignment.suitcases, [
    "core",
    "openclaw-builder"
  ]);
  assert.equal(codexGlobal.assignment, "codex");
  assert.equal(
    gnhfCompatibility.blockedAgents!.codex,
    "Live Codex copy is a slimmer platform variant and must not be overwritten by the OpenClaw canonical bundle."
  );
});
