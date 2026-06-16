import assert from "node:assert/strict";
import { test } from "node:test";
import {
  platformCompatibilityNames,
  resolvePlatformAdapter,
  resolvePlatformInstallRoot
} from "../src/core/platform-adapters.js";
import {
  findTargetRegistryEntriesByAssignment,
  resolveTargetRegistryEntry,
  resolveTargetRegistryEntryFromManifest,
  resolveTargetRegistryEntries
} from "../src/core/catalog/target-registry.js";

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

test("resolves deterministic skills.sh-derived target registry provider entries", () => {
  const entries = resolveTargetRegistryEntries({
    assignments: {},
    assignmentPaths: {}
  });
  const opencode = resolveTargetRegistryEntry("opencode");
  const pi = resolveTargetRegistryEntry("pi");

  assert.ok(opencode);
  assert.ok(pi);
  assert.equal(opencode.kind, "opencode-skills-root");
  assert.equal(opencode.path?.endsWith("/.config/opencode/skills"), true);
  assert.equal(opencode.readOnly, true);
  assert.equal(opencode.provider, "skills.sh");
  assert.equal(pi.kind, "pi-skills-root");
  assert.equal(pi.path?.endsWith("/.pi/agent/skills"), true);
  assert.equal(pi.readOnly, true);
  assert.equal(pi.provider, "skills.sh");
  assert.deepEqual(entries.map((entry) => entry.id), ["opencode", "pi"]);
  assert.equal(resolveTargetRegistryEntry("not-a-real-agent"), null);
});

test("manifest assignment paths outrank skills.sh provider defaults", () => {
  const entries = resolveTargetRegistryEntries({
    assignments: {
      opencode: { suitcases: ["core"] }
    },
    assignmentPaths: {
      opencode: {
        kind: "opencode-skills-root",
        assignment: "opencode",
        path: "/tmp/custom-opencode-skills"
      }
    }
  });

  const opencode = entries.find((entry) => entry.id === "opencode");
  assert.ok(opencode);
  assert.equal(opencode.path, "/tmp/custom-opencode-skills");
  assert.equal(opencode.source, "manifest");
  assert.equal(opencode.readOnly, true);
});

test("manifest assignment paths outrank provider fallbacks by assignment", () => {
  const manifest = {
    assignments: {
      opencode: { suitcases: ["core"] }
    },
    assignmentPaths: {
      "reviewed-opencode": {
        kind: "opencode-skills-root",
        assignment: "opencode",
        path: "/tmp/reviewed-opencode-skills"
      }
    }
  };

  const direct = resolveTargetRegistryEntryFromManifest(manifest, "opencode");
  const assignmentMatches = findTargetRegistryEntriesByAssignment(manifest, "opencode");
  const allEntries = resolveTargetRegistryEntries(manifest);

  assert.ok(direct);
  assert.equal(direct.id, "reviewed-opencode");
  assert.equal(direct.source, "manifest");
  assert.equal(direct.path, "/tmp/reviewed-opencode-skills");
  assert.deepEqual(assignmentMatches.map((entry) => entry.id), ["reviewed-opencode"]);
  assert.equal(allEntries.some((entry) => entry.id === "opencode" && entry.source === "provider"), false);
});
