import assert from "node:assert/strict";
import { test } from "node:test";
import {
  platformCompatibilityNames,
  resolvePlatformAdapter,
  resolvePlatformInstallRoot
} from "../src/core/platform-adapters.js";

test("resolves explicit platform adapters for declared assignment path kinds", () => {
  const openclaw = resolvePlatformAdapter("openclaw-skills-root");
  const codex = resolvePlatformAdapter("codex-home");
  const nestedCodex = resolvePlatformAdapter("nested-home-codex");
  const claude = resolvePlatformAdapter("claude-skills-root");

  assert.equal(openclaw?.id, "openclaw");
  assert.equal(openclaw?.installRootField, "path");
  assert.deepEqual(openclaw?.requiredFields, ["path"]);
  assert.deepEqual(openclaw?.compatibilityNames, ["openclaw"]);
  assert.equal(openclaw?.metadata.workspaceSkillRoot, true);

  assert.equal(codex?.id, "codex");
  assert.equal(codex?.installRootField, "skillsPath");
  assert.deepEqual(codex?.requiredFields, ["codexHome", "skillsPath"]);
  assert.deepEqual(codex?.compatibilityNames, ["codex"]);

  assert.equal(nestedCodex?.id, "codex");
  assert.equal(nestedCodex?.installRootField, "skillsPath");
  assert.deepEqual(nestedCodex?.requiredFields, ["home", "codexHome", "skillsPath"]);
  assert.deepEqual(nestedCodex?.compatibilityNames, ["codex"]);
  assert.equal(nestedCodex?.metadata.nestedHome, true);

  assert.equal(claude?.id, "claude");
  assert.equal(claude?.installRootField, "path");
  assert.deepEqual(claude?.requiredFields, ["path"]);
  assert.deepEqual(claude?.compatibilityNames, ["claude"]);
});

test("resolves install roots and missing required adapter fields deterministically", () => {
  const codexResolved = resolvePlatformInstallRoot({
    kind: "codex-home",
    assignmentPath: {
      codexHome: "/tmp/codex",
      skillsPath: "/tmp/codex/skills"
    }
  });

  assert.deepEqual(codexResolved, {
    ok: true,
    adapter: resolvePlatformAdapter("codex-home"),
    installRoot: "/tmp/codex/skills",
    missingFields: []
  });

  const missing = resolvePlatformInstallRoot({
    kind: "nested-home-codex",
    assignmentPath: {
      codexHome: "/tmp/workspace/.codex",
      skillsPath: "/tmp/workspace/.codex/skills"
    }
  });

  assert.equal(missing.ok, false);
  assert.equal(missing.adapter?.id, "codex");
  assert.equal(missing.installRoot, "/tmp/workspace/.codex/skills");
  assert.deepEqual(missing.missingFields, ["home"]);
});

test("derives compatibility aliases from explicit platform adapter metadata", () => {
  assert.deepEqual(
    platformCompatibilityNames({
      assignment: "openclaw-codex",
      kind: "codex-home"
    }),
    ["openclaw-codex", "codex"]
  );
  assert.deepEqual(
    platformCompatibilityNames({
      assignment: "global-tools",
      kind: "claude-skills-root"
    }),
    ["global-tools", "claude"]
  );
  assert.deepEqual(
    platformCompatibilityNames({
      assignment: "portable",
      kind: null
    }),
    ["portable"]
  );
});
