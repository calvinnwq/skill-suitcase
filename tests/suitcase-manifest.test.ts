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
  const codexGlobal = manifest.assignmentPaths["codex"];
  const portableCore = manifest.groups["portable-core"];
  const openclawBuilderTools = manifest.groups["openclaw-builder-tools"];
  const codexAssigned = manifest.groups["codex-assigned"];
  const gnhfCompatibility = manifest.compatibility["gnhf-postflight"];
  const gnhfVariants = manifest.variants["gnhf-postflight"];

  assert.ok(core);
  assert.ok(openclawBuilder);
  assert.ok(openclawAssignment);
  assert.ok(codexGlobal);
  assert.ok(portableCore);
  assert.ok(openclawBuilderTools);
  assert.ok(codexAssigned);
  assert.ok(gnhfCompatibility);
  assert.ok(gnhfCompatibility.blockedAgents);
  assert.ok(gnhfVariants);

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
  assert.equal(portableCore.title, "Portable Core");
  assert.equal(portableCore.description, "Skills that are intended to travel across supported agent runtimes.");
  assert.deepEqual(portableCore.suitcases, ["core"]);
  assert.deepEqual(portableCore.assignments, ["codex", "claude", "openclaw-codex"]);
  assert.deepEqual(portableCore.tags, ["portable"]);
  assert.equal(openclawBuilderTools.provider, "openclaw");
  assert.deepEqual(openclawBuilderTools.skills, ["skillify", "gnhf-postflight"]);
  assert.deepEqual(openclawBuilderTools.suitcases, ["openclaw-builder"]);
  assert.equal(codexAssigned.title, "Codex Assigned");
  assert.deepEqual(codexAssigned.assignments, ["codex"]);
  assert.deepEqual(codexAssigned.tags, ["assignment"]);
  assert.deepEqual(manifest.sourcePolicy.exclude, ["**/.cache/**", "**/dist/**"]);
  assert.deepEqual(manifest.sourcePolicy.deny, ["**/secrets/**"]);
  assert.equal(
    gnhfCompatibility.blockedAgents!.codex,
    "Live Codex copy is a slimmer platform variant and must not be overwritten by the OpenClaw canonical bundle."
  );
  assert.equal(gnhfVariants.canonical?.source, "skills/gnhf-postflight");
  assert.deepEqual(gnhfVariants.canonical?.agents, ["openclaw"]);
  assert.equal(gnhfVariants.codex?.source, "variants/codex/gnhf-postflight");
  assert.deepEqual(gnhfVariants.codex?.agents, ["codex"]);
});
