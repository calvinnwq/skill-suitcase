import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseSuitcaseManifest } from "../src/core/catalog/suitcase-manifest.js";
import { inspectExternalProjections } from "../src/core/external-projections.js";
import { inspectImportSource } from "../src/core/importing/index.js";
import { validateHermesExternalRoot } from "../src/core/hermes-external-root.js";

const cliPath = path.join(process.cwd(), "dist", "src", "cli.js");

function runCliResult<T>(args: string[]): { status: number | null; stdout: T; stderr: string } {
  const result = spawnSync("node", [cliPath, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: JSON.parse(result.stdout) as T,
    stderr: result.stderr
  };
}

test("external projection inspection classifies missing, broken, drifted, and invalid states", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-external-projection-states-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const installRoot = path.join(sandbox, "target");
  const expectedSource = path.join(sandbox, "expected-source");
  const wrongSource = path.join(sandbox, "wrong-source");
  await mkdir(installRoot, { recursive: true });
  await mkdir(expectedSource, { recursive: true });
  await mkdir(wrongSource, { recursive: true });
  await mkdir(path.join(installRoot, "real-directory"));
  await symlink(path.join(sandbox, "missing-source"), path.join(installRoot, "broken"));
  await symlink(wrongSource, path.join(installRoot, "wrong-target"));

  const reports = await inspectExternalProjections({
    installRoot,
    projections: [
      { id: "broken", target: "fixture", skill: "broken", destination: "broken", source: path.join(sandbox, "missing-source"), mode: "symlink", owner: "fixture" },
      { id: "invalid", target: "fixture", skill: "invalid", destination: "../invalid", source: expectedSource, mode: "symlink", owner: "fixture" },
      { id: "missing", target: "fixture", skill: "missing", destination: "missing", source: expectedSource, mode: "symlink", owner: "fixture" },
      { id: "missing-owner", target: "fixture", skill: "missing-owner", destination: "missing-owner", source: expectedSource, mode: "symlink", owner: "" },
      { id: "real-directory", target: "fixture", skill: "real-directory", destination: "real-directory", source: expectedSource, mode: "symlink", owner: "fixture" },
      { id: "wrong-target", target: "fixture", skill: "wrong-target", destination: "wrong-target", source: expectedSource, mode: "symlink", owner: "fixture" }
    ]
  });

  assert.deepEqual(
    Object.fromEntries(reports.map((report) => [report.id, report.state])),
    {
      broken: "external-broken",
      invalid: "external-invalid",
      missing: "external-missing",
      "missing-owner": "external-invalid",
      "real-directory": "external-drifted",
      "wrong-target": "external-drifted"
    }
  );
});

test("external projection inspection rejects a current symlink whose source identity differs", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-external-projection-identity-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const installRoot = path.join(sandbox, "target");
  const source = path.join(sandbox, "source-skill");
  await mkdir(installRoot, { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: different-skill\n---\n# Different\n");
  await symlink(source, path.join(installRoot, "declared-skill"), "dir");

  const [report] = await inspectExternalProjections({
    installRoot,
    projections: [{
      id: "declared-skill",
      target: "fixture",
      skill: "declared-skill",
      destination: "declared-skill",
      source,
      mode: "symlink",
      owner: "fixture"
    }]
  });

  assert.equal(report?.state, "external-invalid");
  assert.match(report?.reason ?? "", /declares declared-skill but its SKILL\.md identity is different-skill/);
});

test("Hermes external validation resolves tilde sources against the overridden home", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-external-projection-home-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const userHome = path.join(sandbox, "user-home");
  const home = path.join(userHome, ".hermes");
  const installRoot = path.join(sandbox, "external-root");
  const source = path.join(userHome, "external-source", "reference-alpha");
  await mkdir(path.join(home, "skills"), { recursive: true });
  await mkdir(path.join(installRoot, "research"), { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(home, "config.yaml"), `skills:\n  external_dirs:\n    - ${installRoot}\n`);
  await writeFile(path.join(source, "SKILL.md"), "---\nname: reference-alpha\n---\n# Reference\n");
  await symlink(source, path.join(installRoot, "research", "reference-alpha"), "dir");

  const findings = await validateHermesExternalRoot({
    home,
    installRoot,
    planned: [],
    externalProjections: [{
      id: "reference-alpha",
      target: "hermes",
      skill: "reference-alpha",
      destination: "research/reference-alpha",
      source: "~/external-source/reference-alpha",
      mode: "symlink",
      owner: "fixture"
    }],
    homeDirectory: userHome
  });

  assert.deepEqual(findings, []);
});

test("external projection inspection rejects a destination beneath a symlinked parent", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-external-projection-parent-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const installRoot = path.join(sandbox, "target");
  const outsideParent = path.join(sandbox, "outside-parent");
  const source = path.join(sandbox, "source");
  await mkdir(installRoot, { recursive: true });
  await mkdir(outsideParent, { recursive: true });
  await mkdir(source, { recursive: true });
  await symlink(outsideParent, path.join(installRoot, "escaped"), "dir");
  await symlink(source, path.join(outsideParent, "reference-alpha"), "dir");

  const [report] = await inspectExternalProjections({
    installRoot,
    projections: [{
      id: "escaped",
      target: "fixture",
      skill: "reference-alpha",
      destination: "escaped/reference-alpha",
      source,
      mode: "symlink",
      owner: "fixture"
    }]
  });

  assert.equal(report?.state, "external-drifted");
  assert.match(report?.reason ?? "", /symlinked parent/);
});

test("manifest parses generic external projection declarations", () => {
  const manifest = parseSuitcaseManifest(`suitcases: {}
assignments: {}
assignmentPaths: {}
externalProjections:
  fixture-alpha:
    target: hermes
    skill: reference-alpha
    destination: research/reference-alpha
    source: ~/.skill-suitcase/external/reference-alpha
    mode: symlink
    owner: fixture-provider
  fixture-beta:
    target: agents
    skill: reference-beta
    destination: reference-beta
    source: /opt/references/reference-beta
    mode: symlink
    owner: another-provider
`);

  assert.deepEqual(
    (manifest as typeof manifest & { externalProjections: Record<string, unknown> }).externalProjections,
    {
      "fixture-alpha": {
        target: "hermes",
        skill: "reference-alpha",
        destination: "research/reference-alpha",
        source: "~/.skill-suitcase/external/reference-alpha",
        mode: "symlink",
        owner: "fixture-provider"
      },
      "fixture-beta": {
        target: "agents",
        skill: "reference-beta",
        destination: "reference-beta",
        source: "/opt/references/reference-beta",
        mode: "symlink",
        owner: "another-provider"
      }
    }
  );
});

test("catalog import counts valid external projection declarations without reading live sources", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-external-projection-catalog-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  await mkdir(path.join(source, "skills", "catalog-skill"), { recursive: true });
  await writeFile(path.join(source, "skills", "catalog-skill", "SKILL.md"), "---\nname: catalog-skill\n---\n# Catalog\n");
  await writeFile(path.join(source, "skill-suitcase.yaml"), `suitcases:
  core:
    skills:
      - catalog-skill
assignments:
  hermes:
    suitcases:
      - core
    categories:
      catalog-skill: productivity
assignmentPaths:
  hermes:
    kind: hermes-external-skills-root
    assignment: hermes
    home: ~/.hermes
    path: ~/.hermes/skill-suitcase/skills
externalProjections:
  fixture-alpha:
    target: hermes
    skill: reference-alpha
    destination: research/reference-alpha
    source: ~/.skill-suitcase/external/reference-alpha
    mode: symlink
    owner: fixture-provider
  fixture-beta:
    target: hermes
    skill: reference-beta
    destination: media/reference-beta
    source: /opt/references/reference-beta
    mode: symlink
    owner: another-provider
`);

  const result = await inspectImportSource({ source });

  assert.equal(result.ok, true);
  assert.equal((result.summary as typeof result.summary & { externalProjections: number }).externalProjections, 2);
});

test("catalog import rejects unsafe or ambiguous external projection declarations", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-invalid-external-projections-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  await mkdir(path.join(source, "skills", "catalog-skill"), { recursive: true });
  await writeFile(path.join(source, "skills", "catalog-skill", "SKILL.md"), "---\nname: catalog-skill\n---\n# Catalog\n");
  await writeFile(path.join(source, "skill-suitcase.yaml"), `suitcases:
  core:
    skills:
      - catalog-skill
assignments:
  hermes:
    suitcases:
      - core
    categories:
      catalog-skill: productivity
assignmentPaths:
  hermes:
    kind: hermes-external-skills-root
    assignment: hermes
    home: ~/.hermes
    path: ~/.hermes/skill-suitcase/skills
externalProjections:
  missing-owner:
    target: hermes
    skill: missing-owner
    destination: research/missing-owner
    source: /opt/references/missing-owner
    mode: copy
  unknown-target:
    target: nowhere
    skill: unknown-target
    destination: research/unknown-target
    source: /opt/references/unknown-target
    mode: symlink
    owner: fixture-provider
  escaping-destination:
    target: hermes
    skill: escaping-destination
    destination: ../escaping-destination
    source: /opt/references/escaping-destination
    mode: symlink
    owner: fixture-provider
  relative-source:
    target: hermes
    skill: relative-source
    destination: research/relative-source
    source: references/relative-source
    mode: symlink
    owner: fixture-provider
  catalog-conflict:
    target: hermes
    skill: catalog-skill
    destination: research/catalog-skill
    source: /opt/references/catalog-skill
    mode: symlink
    owner: fixture-provider
  duplicate-identity-a:
    target: hermes
    skill: duplicate-identity
    destination: research/duplicate-identity-a
    source: /opt/references/duplicate-identity-a
    mode: symlink
    owner: fixture-provider
  duplicate-identity-b:
    target: hermes
    skill: duplicate-identity
    destination: research/duplicate-identity-b
    source: /opt/references/duplicate-identity-b
    mode: symlink
    owner: fixture-provider
  duplicate-destination-a:
    target: hermes
    skill: duplicate-destination-a
    destination: research/duplicate-destination
    source: /opt/references/duplicate-destination-a
    mode: symlink
    owner: fixture-provider
  duplicate-destination-b:
    target: hermes
    skill: duplicate-destination-b
    destination: research/duplicate-destination
    source: /opt/references/duplicate-destination-b
    mode: symlink
    owner: fixture-provider
`);

  const result = await inspectImportSource({ source });
  const codes = new Set(result.findings.map((finding) => finding.code));

  assert.equal(result.ok, false);
  for (const code of [
    "invalid_external_projection",
    "invalid_external_projection_mode",
    "unknown_external_projection_target",
    "unsafe_external_projection_destination",
    "unsafe_external_projection_source",
    "external_projection_identity_conflict",
    "external_projection_destination_conflict"
  ]) {
    assert.equal(codes.has(code), true, `expected ${code}`);
  }
});

test("Hermes accepts multiple exact declared external reference projections", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-external-projections-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const hermesHome = path.join(sandbox, "hermes");
  const installRoot = path.join(sandbox, "managed-skills");
  const sourceAlpha = path.join(sandbox, "sources", "reference-alpha");
  const sourceBeta = path.join(sandbox, "sources", "reference-beta");
  await mkdir(path.join(hermesHome, "skills"), { recursive: true });
  await mkdir(path.join(installRoot, "research"), { recursive: true });
  await mkdir(path.join(installRoot, "media"), { recursive: true });
  await mkdir(sourceAlpha, { recursive: true });
  await mkdir(sourceBeta, { recursive: true });
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${installRoot}\n`);
  await writeFile(path.join(sourceAlpha, "SKILL.md"), "---\nname: reference-alpha\n---\n# Alpha\n");
  await writeFile(path.join(sourceBeta, "SKILL.md"), "---\nname: reference-beta\n---\n# Beta\n");
  await symlink(sourceAlpha, path.join(installRoot, "research", "reference-alpha"), "dir");
  await symlink(sourceBeta, path.join(installRoot, "media", "reference-beta"), "dir");

  const input = {
    home: hermesHome,
    installRoot,
    planned: [{ skill: "catalog-skill", destination: "productivity/catalog-skill" }],
    externalProjections: [
      {
        id: "fixture-alpha",
        target: "hermes",
        skill: "reference-alpha",
        destination: "research/reference-alpha",
        source: sourceAlpha,
        mode: "symlink",
        owner: "fixture-provider"
      },
      {
        id: "fixture-beta",
        target: "hermes",
        skill: "reference-beta",
        destination: "media/reference-beta",
        source: sourceBeta,
        mode: "symlink",
        owner: "fixture-provider"
      }
    ]
  };

  const findings = await validateHermesExternalRoot(input);

  assert.deepEqual(findings, []);
});

test("Hermes status and diff report declared external projections while comparing catalog skills", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-external-projection-cli-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const source = path.join(sandbox, "catalog");
  const catalogSkill = path.join(source, "skills", "catalog-skill");
  const hermesHome = path.join(sandbox, "hermes");
  const installRoot = path.join(sandbox, "managed-skills");
  const targetCatalogSkill = path.join(installRoot, "productivity", "catalog-skill");
  const externalSource = path.join(sandbox, "references", "reference-alpha");
  const externalTarget = path.join(installRoot, "research", "reference-alpha");
  const catalogText = "---\nname: catalog-skill\n---\n# Catalog\n";
  await mkdir(catalogSkill, { recursive: true });
  await mkdir(targetCatalogSkill, { recursive: true });
  await mkdir(path.dirname(externalTarget), { recursive: true });
  await mkdir(path.join(hermesHome, "skills"), { recursive: true });
  await mkdir(externalSource, { recursive: true });
  await writeFile(path.join(catalogSkill, "SKILL.md"), catalogText);
  await writeFile(path.join(targetCatalogSkill, "SKILL.md"), catalogText);
  await writeFile(path.join(externalSource, "SKILL.md"), "---\nname: reference-alpha\n---\n# Alpha\n");
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${installRoot}\n`);
  await symlink(externalSource, externalTarget, "dir");
  await writeFile(path.join(source, "skill-suitcase.yaml"), `suitcases:
  core:
    skills:
      - catalog-skill
assignments:
  hermes:
    suitcases:
      - core
    categories:
      catalog-skill: productivity
assignmentPaths:
  hermes:
    kind: hermes-external-skills-root
    assignment: hermes
    home: ${hermesHome}
    path: ${installRoot}
externalProjections:
  fixture-alpha:
    target: hermes
    skill: reference-alpha
    destination: research/reference-alpha
    source: ${externalSource}
    mode: symlink
    owner: fixture-provider
`);

  type ProjectionReport = { id: string; state: string; skill: string; destination: string };
  const statusResult = runCliResult<{
    ok: boolean;
    externalProjections: ProjectionReport[];
    errors: Array<{ code: string }>;
  }>(["status", "--source", source, "--target", "hermes", "--json"]);
  assert.equal(statusResult.status, 0, JSON.stringify(statusResult.stdout));
  assert.equal(statusResult.stdout.ok, true);
  assert.deepEqual(statusResult.stdout.externalProjections.map(({ id, state, skill, destination }) => ({ id, state, skill, destination })), [
    { id: "fixture-alpha", state: "external-current", skill: "reference-alpha", destination: "research/reference-alpha" }
  ]);
  assert.equal(statusResult.stdout.errors.some((error) => error.code === "hermes_shadow_directory_symlink"), false);

  const diffResult = runCliResult<{
    ok: boolean;
    externalProjections: ProjectionReport[];
    summary: { unchanged: number };
    errors: Array<{ code: string }>;
  }>(["diff", "--source", source, "--target", "hermes", "--json"]);
  assert.equal(diffResult.status, 0, JSON.stringify(diffResult.stdout));
  assert.equal(diffResult.stdout.ok, true);
  assert.equal(diffResult.stdout.summary.unchanged, 1);
  assert.equal(diffResult.stdout.externalProjections[0]?.state, "external-current");
});

test("Hermes apply preserves declared external projections while installing catalog skills", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-external-projection-apply-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const source = path.join(sandbox, "catalog");
  const catalogSkill = path.join(source, "skills", "catalog-skill");
  const hermesHome = path.join(sandbox, "hermes");
  const installRoot = path.join(sandbox, "managed-skills");
  const externalSource = path.join(sandbox, "references", "reference-alpha");
  const externalTarget = path.join(installRoot, "research", "reference-alpha");
  const catalogText = "---\nname: catalog-skill\n---\n# Catalog\n";
  await mkdir(catalogSkill, { recursive: true });
  await mkdir(path.dirname(externalTarget), { recursive: true });
  await mkdir(path.join(hermesHome, "skills"), { recursive: true });
  await mkdir(externalSource, { recursive: true });
  await writeFile(path.join(catalogSkill, "SKILL.md"), catalogText);
  await writeFile(path.join(externalSource, "SKILL.md"), "---\nname: reference-alpha\n---\n# Alpha\n");
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${installRoot}\n`);
  await symlink(externalSource, externalTarget, "dir");
  await writeFile(path.join(source, "skill-suitcase.yaml"), `suitcases:
  core:
    skills:
      - catalog-skill
assignments:
  hermes:
    suitcases:
      - core
    categories:
      catalog-skill: productivity
assignmentPaths:
  hermes:
    kind: hermes-external-skills-root
    assignment: hermes
    home: ${hermesHome}
    path: ${installRoot}
externalProjections:
  fixture-alpha:
    target: hermes
    skill: reference-alpha
    destination: research/reference-alpha
    source: ${externalSource}
    mode: symlink
    owner: fixture-provider
`);

  const packed = runCliResult<{ ok: boolean; bundle: { artifactPath: string } }>([
    "pack", "--source", source, "--target", "hermes", "--output", path.join(sandbox, "pack"), "--json"
  ]);
  assert.equal(packed.status, 0, JSON.stringify(packed.stdout));
  const applied = runCliResult<{
    ok: boolean;
    postApplyStatus: { externalProjections: Array<{ id: string; state: string }> } | null;
    errors: Array<{ code: string }>;
  }>([
    "apply", "--source", source, "--target", "hermes", "--artifact", packed.stdout.bundle.artifactPath, "--json"
  ]);

  assert.equal(applied.status, 0, JSON.stringify(applied.stdout));
  assert.equal(applied.stdout.ok, true);
  assert.equal(await readlink(externalTarget), externalSource);
  assert.equal(await readFile(path.join(installRoot, "productivity", "catalog-skill", "SKILL.md"), "utf8"), catalogText);
  assert.deepEqual(applied.stdout.postApplyStatus?.externalProjections.map(({ id, state }) => ({ id, state })), [
    { id: "fixture-alpha", state: "external-current" }
  ]);
});
