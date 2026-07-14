import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateHermesExternalRoot } from "../src/core/hermes-external-root.js";
import { computePackArtifactId } from "../src/core/packing/artifact-id.js";
import { apply } from "../src/apply.js";
import { reconcile } from "../src/reconcile.js";
import { repair } from "../src/repair.js";

const cliPath = path.join(process.cwd(), "dist", "src", "cli.js");

function runCli<T>(args: string[]): T {
  const result = spawnSync("node", [cliPath, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, cliFailure(result));
  assert.equal(result.stderr, "");
  assert.notEqual(result.stdout.trim(), "");
  return JSON.parse(result.stdout) as T;
}

function runCliResult<T>(args: string[], env?: NodeJS.ProcessEnv): { status: number | null; stdout: T; stderr: string } {
  const result = spawnSync("node", [cliPath, ...args], { encoding: "utf8", env: env === undefined ? process.env : { ...process.env, ...env } });
  return {
    status: result.status,
    stdout: JSON.parse(result.stdout) as T,
    stderr: result.stderr
  };
}

function cliFailure(result: SpawnSyncReturns<string>): string {
  return `expected CLI exit 0, received ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
}

test("Hermes follows the writable target lifecycle used by OpenClaw", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-target-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const source = path.join(sandbox, "catalog");
  const sourceSkill = path.join(source, "skills", "hello-hermes");
  const targetRoot = path.join(sandbox, "hermes", "skills");
  const artifactRoot = path.join(sandbox, "pack");
  const sourceText = "---\nname: hello-hermes\n---\n\n# Hello Hermes\n";

  await mkdir(sourceSkill, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), sourceText);
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - hello-hermes

assignments:
  hermes:
    suitcases:
      - core

assignmentPaths:
  hermes:
    kind: hermes-skills-root
    assignment: hermes
    path: /path/to/hermes/skills

compatibility:
  hello-hermes:
    agents:
      - hermes
    variant: canonical
`
  );

  const targetArgs = [
    "--source",
    source,
    "--target",
    "hermes",
    "--hermes-skills",
    targetRoot,
    "--json"
  ];

  const planned = runCli<{ ok: boolean; planned: Array<{ skill: string }> }>([
    "plan",
    "--source",
    source,
    "--target",
    "hermes",
    "--json"
  ]);
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.planned.map((item) => item.skill), ["hello-hermes"]);

  const packed = runCli<{
    ok: boolean;
    bundle: { artifactPath: string | null };
  }>(["pack", ...targetArgs, "--output", artifactRoot]);
  assert.equal(packed.ok, true);
  assert.equal(typeof packed.bundle.artifactPath, "string");

  const applied = runCli<{ ok: boolean; applied: { skills: string[] } }>([
    "apply",
    ...targetArgs,
    "--artifact",
    packed.bundle.artifactPath as string
  ]);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.applied.skills, ["hello-hermes"]);

  const installedSkill = path.join(targetRoot, "hello-hermes", "SKILL.md");
  assert.equal(await readFile(installedSkill, "utf8"), sourceText);

  await writeFile(installedSkill, `${sourceText}\nLocal edit.\n`);
  const repaired = runCli<{ ok: boolean; repaired: { skills: string[] } }>([
    "repair",
    ...targetArgs,
    "--skill",
    "hello-hermes",
    "--apply"
  ]);
  assert.equal(repaired.ok, true);
  assert.deepEqual(repaired.repaired.skills, ["hello-hermes"]);
  assert.equal(await readFile(installedSkill, "utf8"), sourceText);

  const settled = runCli<{ ok: boolean; summary: { current: number } }>([
    "status",
    ...targetArgs
  ]);
  assert.equal(settled.ok, true);
  assert.equal(settled.summary.current, 1);
});

test("categorized Hermes external root preserves one receipt through plan, pack, apply, status, diff, repair, and prune", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-external-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const source = path.join(sandbox, "catalog");
  const hermesHome = path.join(sandbox, "hermes");
  const externalRoot = path.join(hermesHome, "skill-suitcase", "skills");
  const artifactRoot = path.join(sandbox, "pack");
  const skills = [
    { name: "agent-swarm", category: "autonomous-ai-agents" },
    { name: "improve", category: "software-development" }
  ];

  await mkdir(externalRoot, { recursive: true });
  await mkdir(path.join(hermesHome, "skills"), { recursive: true });
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs:\n    - ${externalRoot}\n`);
  for (const skill of skills) {
    await mkdir(path.join(source, "skills", skill.name), { recursive: true });
    await writeFile(path.join(source, "skills", skill.name, "SKILL.md"), `---\nname: ${skill.name}\n---\n\n# ${skill.name}\n`);
  }

  const writeManifest = async (included = skills) => writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
${included.map((skill) => `      - ${skill.name}`).join("\n")}

assignments:
  hermes:
    suitcases:
      - core
    categories:
${included.map((skill) => `      ${skill.name}: ${skill.category}`).join("\n")}

assignmentPaths:
  hermes:
    kind: hermes-external-skills-root
    assignment: hermes
    home: ${hermesHome}
    path: ${externalRoot}

compatibility:
${skills.map((skill) => `  ${skill.name}:\n    agents:\n      - hermes\n    variant: canonical`).join("\n")}
`
  );
  await writeManifest();

  const planned = runCli<{ ok: boolean; planned: Array<{ skill: string; destination: string }> }>([
    "plan", "--source", source, "--target", "hermes", "--json"
  ]);
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.planned.map(({ skill, destination }) => ({ skill, destination })), [
    { skill: "agent-swarm", destination: path.join("autonomous-ai-agents", "agent-swarm") },
    { skill: "improve", destination: path.join("software-development", "improve") }
  ]);

  const packed = runCli<{ ok: boolean; bundle: { artifactPath: string; manifestPath: string } }>([
    "pack", "--source", source, "--target", "hermes", "--output", artifactRoot, "--json"
  ]);
  assert.equal(packed.ok, true);
  const bundleManifest = JSON.parse(await readFile(packed.bundle.manifestPath, "utf8")) as Omit<Parameters<typeof computePackArtifactId>[0], "planned" | "files"> & {
    artifactId: string;
    planned: Array<{ skill: string; destination: string }>;
    files: Array<{ skill: string; destination: string; bundlePath: string }>;
  };
  assert.equal(bundleManifest.planned[0]?.destination, path.join("autonomous-ai-agents", "agent-swarm"));
  assert.equal(bundleManifest.files[0]?.bundlePath, path.join("skills", "autonomous-ai-agents", "agent-swarm", "SKILL.md"));
  assert.equal(computePackArtifactId(bundleManifest), bundleManifest.artifactId);
  assert.equal(computePackArtifactId({
    ...bundleManifest,
    planned: bundleManifest.planned.map((item) => Object.fromEntries(Object.entries(item).reverse())),
    files: bundleManifest.files.map((item) => Object.fromEntries(Object.entries(item).reverse()))
  }), bundleManifest.artifactId);
  assert.notEqual(computePackArtifactId({
    ...bundleManifest,
    planned: bundleManifest.planned.map((item, index) => index === 0
      ? { ...item, destination: path.join("creative", item.skill) }
      : item)
  }), bundleManifest.artifactId);
  assert.notEqual(computePackArtifactId({
    ...bundleManifest,
    files: bundleManifest.files.map((item, index) => index === 0
      ? { ...item, destination: path.join("creative", item.skill) }
      : item)
  }), bundleManifest.artifactId);

  const targetArgs = ["--source", source, "--target", "hermes", "--json"];
  const reviewedManifest = await readFile(path.join(source, "skill-suitcase.yaml"), "utf8");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    reviewedManifest.replace("agent-swarm: autonomous-ai-agents", "agent-swarm: creative")
  );
  const staleDestination = runCliResult<{ errors: Array<{ code: string }> }>([
    "apply", ...targetArgs, "--artifact", packed.bundle.artifactPath
  ]);
  assert.notEqual(staleDestination.status, 0);
  assert.equal(staleDestination.stdout.errors.some((error) => error.code === "artifact_destination_mismatch"), true);
  await assert.rejects(readFile(path.join(externalRoot, "creative", "agent-swarm", "SKILL.md"), "utf8"));
  await writeManifest();

  const escapedApplyCategory = path.join(sandbox, "escaped-apply-category");
  const applyCategory = path.join(externalRoot, "autonomous-ai-agents");
  const guardedApply = await apply({
    source,
    target: "hermes",
    artifact: packed.bundle.artifactPath,
    __test: {
      beforeWriteForSkill: async (skill) => {
        if (skill !== "agent-swarm") return;
        await mkdir(escapedApplyCategory, { recursive: true });
        await symlink(escapedApplyCategory, applyCategory);
      }
    }
  });
  assert.equal(guardedApply.ok, false);
  await assert.rejects(readFile(path.join(escapedApplyCategory, "agent-swarm", "SKILL.md"), "utf8"));
  await rm(applyCategory);
  await rm(escapedApplyCategory, { recursive: true });

  const applied = runCli<{ ok: boolean; applied: { skills: string[] } }>([
    "apply", ...targetArgs, "--artifact", packed.bundle.artifactPath
  ]);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.applied.skills, ["agent-swarm", "improve"]);

  for (const skill of skills) {
    assert.equal(
      await readFile(path.join(externalRoot, skill.category, skill.name, "SKILL.md"), "utf8"),
      `---\nname: ${skill.name}\n---\n\n# ${skill.name}\n`
    );
  }
  const receiptPath = path.join(externalRoot, ".skill-suitcase-receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    installs: Record<string, { destination: string; targetPath: string }>;
  };
  assert.equal(receipt.installs["agent-swarm"]?.destination, path.join("autonomous-ai-agents", "agent-swarm"));
  assert.equal(receipt.installs.improve?.targetPath, path.join(externalRoot, "software-development", "improve"));
  await assert.rejects(readFile(path.join(externalRoot, "software-development", ".skill-suitcase-receipt.json"), "utf8"));

  const redirectedStatusCategory = path.join(externalRoot, "redirected-status-category");
  const swarmCategory = path.join(externalRoot, "autonomous-ai-agents");
  await rename(swarmCategory, redirectedStatusCategory);
  await symlink(redirectedStatusCategory, swarmCategory);
  const unsafeStatus = runCliResult<{ errors: Array<{ code: string }> }>(["status", ...targetArgs]);
  assert.notEqual(unsafeStatus.status, 0);
  assert.equal(unsafeStatus.stdout.errors.some((error) => error.code === "external_category_symlink"), true);
  await rm(swarmCategory);
  await rename(redirectedStatusCategory, swarmCategory);

  const status = runCli<{ ok: boolean; summary: { current: number }; statuses: Array<{ destination: string }> }>([
    "status", ...targetArgs
  ]);
  assert.equal(status.ok, true);
  assert.equal(status.summary.current, 2);
  assert.deepEqual(status.statuses.map((item) => item.destination), [
    path.join("autonomous-ai-agents", "agent-swarm"),
    path.join("software-development", "improve")
  ]);
  const diff = runCli<{ ok: boolean; summary: { unchanged: number } }>(["diff", ...targetArgs]);
  assert.equal(diff.ok, true);
  assert.equal(diff.summary.unchanged, 2);

  const swarmTarget = path.join(externalRoot, "autonomous-ai-agents", "agent-swarm");
  await rm(swarmTarget, { recursive: true });
  const missing = runCli<{ summary: { missing: number } }>(["status", ...targetArgs]);
  assert.equal(missing.summary.missing, 1);
  const missingRepair = runCliResult<{ errors: Array<{ code: string }> }>([
    "repair", ...targetArgs, "--skill", "agent-swarm", "--dry-run"
  ]);
  assert.notEqual(missingRepair.status, 0);
  assert.equal(missingRepair.stdout.errors.some((error) => error.code === "route_to_pack_apply"), true);
  const reapplied = runCli<{ ok: boolean; applied: { skills: string[] } }>([
    "apply", ...targetArgs, "--artifact", packed.bundle.artifactPath
  ]);
  assert.equal(reapplied.ok, true);
  assert.deepEqual(reapplied.applied.skills, ["agent-swarm"]);

  const improveTarget = path.join(externalRoot, "software-development", "improve", "SKILL.md");
  await writeFile(improveTarget, "dirty\n");
  const importPlan = runCli<{ ok: boolean; candidates: Array<{ targetSkillPath: string }> }>([
    "import-target", ...targetArgs, "--skill", "improve", "--dry-run"
  ]);
  assert.equal(importPlan.ok, true);
  assert.deepEqual(importPlan.candidates.map((candidate) => candidate.targetSkillPath), [path.dirname(improveTarget)]);

  const improveCategory = path.join(externalRoot, "software-development");
  const escapedRepairCategory = path.join(externalRoot, "redirected-repair-category");
  const guardedRepair = await repair({
    source,
    target: "hermes",
    skills: ["improve"],
    apply: true,
    __test: {
      beforeMutationForSkill: async () => {
        await rename(improveCategory, escapedRepairCategory);
        await symlink(escapedRepairCategory, improveCategory);
      }
    }
  });
  assert.equal(guardedRepair.ok, false);
  assert.equal(await readFile(path.join(escapedRepairCategory, "improve", "SKILL.md"), "utf8"), "dirty\n");
  await rm(improveCategory);
  await rename(escapedRepairCategory, improveCategory);

  const repaired = runCli<{ ok: boolean; repaired: { skills: string[] } }>([
    "repair", ...targetArgs, "--skill", "improve", "--apply"
  ]);
  assert.equal(repaired.ok, true);
  assert.deepEqual(repaired.repaired.skills, ["improve"]);

  const currentManifest = await readFile(path.join(source, "skill-suitcase.yaml"), "utf8");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    currentManifest.replace("agent-swarm: autonomous-ai-agents", "agent-swarm: creative")
  );
  const moved = runCliResult<{ errors: Array<{ code: string }> }>(["status", ...targetArgs]);
  assert.notEqual(moved.status, 0);
  assert.equal(moved.stdout.errors.some((error) => error.code === "hermes_managed_skill_shadow"), true);
  assert.equal(await readFile(path.join(externalRoot, "autonomous-ai-agents", "agent-swarm", "SKILL.md"), "utf8"), "---\nname: agent-swarm\n---\n\n# agent-swarm\n");
  await writeManifest();

  await writeManifest([skills[0]!]);
  const receiptBeforePrune = await readFile(receiptPath, "utf8");
  const mismatchedReceipt = JSON.parse(receiptBeforePrune) as {
    installs: Record<string, { targetPath: string }>;
  };
  mismatchedReceipt.installs.improve!.targetPath = path.join(externalRoot, "unrelated", "improve");
  await writeFile(receiptPath, `${JSON.stringify(mismatchedReceipt, null, 2)}\n`);
  const mismatchedPrune = runCliResult<{ errors: Array<{ code: string }> }>([
    "prune", ...targetArgs, "--skill", "improve", "--dry-run"
  ]);
  assert.notEqual(mismatchedPrune.status, 0);
  assert.equal(mismatchedPrune.stdout.errors.some((error) => error.code === "missing_receipt_record"), true);
  await writeFile(receiptPath, receiptBeforePrune);

  const escapedCategory = path.join(externalRoot, "redirected-prune-category");
  await rename(path.join(externalRoot, "software-development"), escapedCategory);
  await symlink(escapedCategory, path.join(externalRoot, "software-development"));
  const unsafePrune = runCliResult<{ ok: boolean; errors: Array<{ code: string }> }>([
    "prune", ...targetArgs, "--skill", "improve", "--dry-run"
  ]);
  assert.notEqual(unsafePrune.status, 0);
  assert.equal(unsafePrune.stdout.errors.some((error) => error.code === "unsafe_target_path"), true);
  assert.equal(await readFile(path.join(escapedCategory, "improve", "SKILL.md"), "utf8"), "---\nname: improve\n---\n\n# improve\n");
  await rm(path.join(escapedCategory, "improve"), { recursive: true });
  const unsafeMissingPrune = runCliResult<{ errors: Array<{ code: string }> }>([
    "prune", ...targetArgs, "--skill", "improve", "--dry-run"
  ]);
  assert.notEqual(unsafeMissingPrune.status, 0);
  assert.equal(unsafeMissingPrune.stdout.errors.some((error) => error.code === "unsafe_target_path"), true);
  await rm(path.join(externalRoot, "software-development"));
  await rename(escapedCategory, path.join(externalRoot, "software-development"));
  await rm(path.join(externalRoot, "software-development"), { recursive: true });

  const prunePlan = runCli<{ ok: boolean; plan: { id: string }; candidates: Array<{ kind: string }> }>([
    "prune", ...targetArgs, "--skill", "improve", "--dry-run"
  ]);
  assert.equal(prunePlan.ok, true);
  assert.deepEqual(prunePlan.candidates.map((candidate) => candidate.kind), ["missing"]);
  const pruned = runCli<{ ok: boolean; pruned: { skills: string[] } }>([
    "prune", ...targetArgs, "--skill", "improve", "--apply", "--plan-id", prunePlan.plan.id
  ]);
  assert.equal(pruned.ok, true);
  assert.deepEqual(pruned.pruned.skills, ["improve"]);
  await assert.rejects(readFile(improveTarget, "utf8"));
  assert.equal(await readFile(path.join(externalRoot, "autonomous-ai-agents", "agent-swarm", "SKILL.md"), "utf8"), "---\nname: agent-swarm\n---\n\n# agent-swarm\n");

  const localSentinel = path.join(hermesHome, "skills", "keep.txt");
  await writeFile(localSentinel, "keep\n");
  const rolledBack = runCli<{ ok: boolean }>(["rollback", "--receipt", receiptPath, "--json"]);
  assert.equal(rolledBack.ok, true);
  await assert.rejects(readFile(path.join(externalRoot, "autonomous-ai-agents", "agent-swarm", "SKILL.md"), "utf8"));
  assert.equal(await readFile(localSentinel, "utf8"), "keep\n");
  assert.match(await readFile(path.join(hermesHome, "config.yaml"), "utf8"), /external_dirs/);
});

test("categorized Hermes external root fails closed for registration, local shadowing, and unsafe categories", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-external-refusal-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const source = path.join(sandbox, "catalog");
  const hermesHome = path.join(sandbox, "hermes");
  const externalRoot = path.join(hermesHome, "skill-suitcase", "skills");
  await mkdir(path.join(source, "skills", "hello-hermes"), { recursive: true });
  await mkdir(externalRoot, { recursive: true });
  await mkdir(path.join(hermesHome, "skills"), { recursive: true });
  await writeFile(path.join(source, "skills", "hello-hermes", "SKILL.md"), "# Hello\n");
  const writeManifest = async (category: string) => writeFile(path.join(source, "skill-suitcase.yaml"), `suitcases:
  core:
    skills:
      - hello-hermes
assignments:
  hermes:
    suitcases:
      - core
    categories:
      hello-hermes: ${category}
assignmentPaths:
  hermes:
    kind: hermes-external-skills-root
    assignment: hermes
    home: ${hermesHome}
    path: ${externalRoot}
compatibility:
  hello-hermes:
    agents:
      - hermes
`);
  await writeManifest("productivity");

  const unregistered = runCliResult<{ ok: boolean; errors: Array<{ code: string }> }>([
    "diff", "--source", source, "--target", "hermes", "--json"
  ]);
  assert.notEqual(unregistered.status, 0);
  assert.equal(unregistered.stdout.errors.some((error) => error.code === "hermes_external_root_unregistered"), true);
  assert.equal(unregistered.stderr, "");
  const unregisteredPrune = runCliResult<{ errors: Array<{ code: string }> }>([
    "prune", "--source", source, "--target", "hermes", "--skill", "hello-hermes", "--dry-run", "--json"
  ]);
  assert.notEqual(unregisteredPrune.status, 0);
  assert.equal(unregisteredPrune.stdout.errors.some((error) => error.code === "hermes_external_root_unregistered"), true);

  await writeFile(path.join(hermesHome, "config.yaml"), "skills:\n  external_dirs: ${HERMES_TEST_EXTERNAL_ROOT}\n");
  await mkdir(path.join(hermesHome, "skills", "productivity", "legacy-directory"), { recursive: true });
  await writeFile(
    path.join(hermesHome, "skills", "productivity", "legacy-directory", "SKILL.md"),
    "---\nname: hello-hermes\n---\n\n# Local shadow\n"
  );
  const shadowed = runCliResult<{ errors: Array<{ code: string }> }>([
    "diff", "--source", source, "--target", "hermes", "--json"
  ], { HERMES_TEST_EXTERNAL_ROOT: externalRoot });
  assert.equal(shadowed.stdout.errors.some((error) => error.code === "hermes_local_skill_shadow"), true);

  await rm(path.join(hermesHome, "skills", "productivity"), { recursive: true });
  await mkdir(path.join(hermesHome, "skills", ".archive", "archived"), { recursive: true });
  await writeFile(
    path.join(hermesHome, "skills", ".archive", "archived", "SKILL.md"),
    "---\nname: hello-hermes\n---\n\n# Excluded archive\n"
  );
  const excludedArchive = runCliResult<{ ok: boolean }>([
    "diff", "--source", source, "--target", "hermes", "--json"
  ], { HERMES_TEST_EXTERNAL_ROOT: externalRoot });
  assert.equal(excludedArchive.status, 0);
  assert.equal(excludedArchive.stdout.ok, true);

  const symlinkedCategorySource = path.join(sandbox, "symlinked-category-source");
  await mkdir(path.join(symlinkedCategorySource, "nested"), { recursive: true });
  await writeFile(
    path.join(symlinkedCategorySource, "nested", "SKILL.md"),
    "---\nname: hello-hermes\n---\n\n# Symlinked local shadow\n"
  );
  const symlinkedCategory = path.join(hermesHome, "skills", "team");
  await symlink(symlinkedCategorySource, symlinkedCategory);
  const symlinkShadow = runCliResult<{ errors: Array<{ code: string }> }>([
    "diff", "--source", source, "--target", "hermes", "--json"
  ], { HERMES_TEST_EXTERNAL_ROOT: externalRoot });
  assert.notEqual(symlinkShadow.status, 0);
  assert.equal(symlinkShadow.stdout.errors.some((error) => error.code === "hermes_local_skill_shadow"), true);
  await rm(symlinkedCategory);

  const symlinkedSkillFileSource = path.join(sandbox, "symlinked-skill-file.md");
  const symlinkedSkillDirectory = path.join(hermesHome, "skills", "team", "legacy-directory");
  await mkdir(symlinkedSkillDirectory, { recursive: true });
  await writeFile(
    symlinkedSkillFileSource,
    "---   \nname: hello-hermes\n---   \n\n# Symlinked skill file\n"
  );
  await symlink(symlinkedSkillFileSource, path.join(symlinkedSkillDirectory, "SKILL.md"));
  const symlinkedSkillFileShadow = runCliResult<{ errors: Array<{ code: string }> }>([
    "diff", "--source", source, "--target", "hermes", "--json"
  ], { HERMES_TEST_EXTERNAL_ROOT: externalRoot });
  assert.notEqual(symlinkedSkillFileShadow.status, 0);
  assert.equal(
    symlinkedSkillFileShadow.stdout.errors.some((error) => error.code === "hermes_local_skill_shadow"),
    true
  );
  await rm(path.join(hermesHome, "skills", "team"), { recursive: true });

  const earlierRoot = path.join(sandbox, "earlier-external");
  await mkdir(path.join(earlierRoot, "legacy"), { recursive: true });
  await writeFile(
    path.join(earlierRoot, "legacy", "SKILL.md"),
    "---\nname: hello-hermes\n---\n\n# Earlier external\n"
  );
  await writeFile(
    path.join(hermesHome, "config.yaml"),
    `skills:\n  external_dirs:\n    - ${earlierRoot}\n    - ${externalRoot}\n`
  );
  const externallyShadowed = runCliResult<{ errors: Array<{ code: string }> }>([
    "diff", "--source", source, "--target", "hermes", "--json"
  ]);
  assert.notEqual(externallyShadowed.status, 0);
  assert.equal(externallyShadowed.stdout.errors.some((error) => error.code === "hermes_external_skill_shadow"), true);

  await writeManifest("node_modules");
  const invalid = runCliResult<{ findings: Array<{ code: string }> }>([
    "validate", "--source", source, "--json"
  ]);
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout.findings.some((finding) => finding.code === "invalid_skill_category"), true);
  await assert.rejects(readFile(path.join(externalRoot, "node_modules", "hello-hermes", "SKILL.md"), "utf8"));

  for (const unsafeCategory of ["CON", "team."]) {
    await writeManifest(unsafeCategory);
    const unsafeCategoryResult = runCliResult<{ findings: Array<{ code: string }> }>([
      "validate", "--source", source, "--json"
    ]);
    assert.notEqual(unsafeCategoryResult.status, 0);
    assert.equal(
      unsafeCategoryResult.stdout.findings.some((finding) => finding.code === "invalid_skill_category"),
      true
    );
  }
});

test("categorized Hermes external roots cannot overlap the local recursive skills tree", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-overlap-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const source = path.join(sandbox, "catalog");
  const hermesHome = path.join(sandbox, "hermes");
  const localSkillsRoot = path.join(hermesHome, "skills");
  const aliasRoot = path.join(sandbox, "external-alias");
  await mkdir(path.join(source, "skills", "hello-hermes"), { recursive: true });
  await mkdir(localSkillsRoot, { recursive: true });
  await writeFile(path.join(source, "skills", "hello-hermes", "SKILL.md"), "# Hello\n");
  await symlink(localSkillsRoot, aliasRoot);
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${aliasRoot}\n`);
  await writeFile(path.join(source, "skill-suitcase.yaml"), `suitcases:
  core:
    skills:
      - hello-hermes
assignments:
  hermes:
    suitcases:
      - core
    categories:
      hello-hermes: productivity
assignmentPaths:
  hermes:
    kind: hermes-external-skills-root
    assignment: hermes
    home: ${hermesHome}
    path: ${aliasRoot}
compatibility:
  hello-hermes:
    agents:
      - hermes
`);

  const result = runCliResult<{ errors: Array<{ code: string }> }>([
    "diff", "--source", source, "--target", "hermes", "--json"
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.errors.some((error) => error.code === "hermes_external_root_local_overlap"), true);

  const ancestorManifest = await readFile(path.join(source, "skill-suitcase.yaml"), "utf8");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    ancestorManifest.replace(`path: ${aliasRoot}`, `path: ${hermesHome}`)
  );
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${hermesHome}\n`);
  const ancestor = runCliResult<{ errors: Array<{ code: string }> }>([
    "diff", "--source", source, "--target", "hermes", "--json"
  ]);
  assert.notEqual(ancestor.status, 0);
  assert.equal(ancestor.stdout.errors.some((error) => error.code === "hermes_external_root_local_overlap"), true);

  const dottedChildRoot = path.join(localSkillsRoot, "..suitcase");
  await mkdir(dottedChildRoot, { recursive: true });
  const dottedManifest = await readFile(path.join(source, "skill-suitcase.yaml"), "utf8");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    dottedManifest.replace(`path: ${hermesHome}`, `path: ${dottedChildRoot}`)
  );
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${dottedChildRoot}\n`);
  const dottedChild = runCliResult<{ errors: Array<{ code: string }> }>([
    "diff", "--source", source, "--target", "hermes", "--json"
  ]);
  assert.notEqual(dottedChild.status, 0);
  assert.equal(dottedChild.stdout.errors.some((error) => error.code === "hermes_external_root_local_overlap"), true);
});

test("categorized Hermes registration requires the owned root before first materialization", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-fresh-root-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const hermesHome = path.join(sandbox, "hermes");
  const externalRoot = path.join(hermesHome, "skill-suitcase", "skills");
  await mkdir(hermesHome, { recursive: true });
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${externalRoot}\n`);

  const findings = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot: externalRoot,
    planned: [{ skill: "hello-hermes", destination: path.join("productivity", "hello-hermes") }]
  });

  assert.equal(findings.some((finding) => finding.code === "hermes_external_root_unregistered"), true);
  await assert.rejects(readFile(externalRoot, "utf8"));

  await mkdir(externalRoot, { recursive: true });
  const existingRootFindings = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot: externalRoot,
    planned: [{ skill: "hello-hermes", destination: path.join("productivity", "hello-hermes") }]
  });
  assert.equal(existingRootFindings.some((finding) => finding.code === "hermes_external_root_unregistered"), false);
});

test("categorized Hermes reconcile refuses a replaced category parent", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-reconcile-parent-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const source = path.join(sandbox, "catalog");
  const sourceSkill = path.join(source, "skills", "hello-hermes");
  const hermesHome = path.join(sandbox, "hermes");
  const externalRoot = path.join(sandbox, "external");
  const category = path.join(externalRoot, "productivity");
  const escapedCategory = path.join(sandbox, "escaped-category");
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(path.join(category, "hello-hermes"), { recursive: true });
  await mkdir(path.join(hermesHome, "skills"), { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: hello-hermes\n---\n# Catalog\n");
  await writeFile(path.join(category, "hello-hermes", "SKILL.md"), "---\nname: hello-hermes\n---\n# Existing\n");
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${externalRoot}\n`);
  await writeFile(path.join(source, "skill-suitcase.yaml"), `suitcases:
  core:
    skills:
      - hello-hermes
assignments:
  hermes:
    suitcases:
      - core
    categories:
      hello-hermes: productivity
assignmentPaths:
  hermes:
    kind: hermes-external-skills-root
    assignment: hermes
    home: ${hermesHome}
    path: ${externalRoot}
compatibility:
  hello-hermes:
    agents:
      - hermes
`);

  const result = await reconcile({
    source,
    target: "hermes",
    skills: ["hello-hermes"],
    apply: true,
    __test: {
      beforeMutationForSkill: async () => {
        await rename(category, escapedCategory);
        await symlink(escapedCategory, category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(
    await readFile(path.join(escapedCategory, "hello-hermes", "SKILL.md"), "utf8"),
    "---\nname: hello-hermes\n---\n# Existing\n"
  );
});

test("categorized Hermes root overlap follows the actual volume case semantics", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-case-overlap-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const caseProbe = path.join(sandbox, "CaseProbe");
  await mkdir(caseProbe);
  let caseInsensitive = process.platform === "win32";
  try {
    caseInsensitive = caseInsensitive
      || await realpath(path.join(sandbox, "caseProbe")) === await realpath(caseProbe);
  } catch {
    // The volume distinguishes case.
  }
  const hermesHome = path.join(sandbox, "hermes");
  const externalRoot = path.join(hermesHome, "SKILLS", "owned");
  await mkdir(externalRoot, { recursive: true });
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${externalRoot}\n`);

  const findings = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot: externalRoot,
    planned: [{ skill: "hello-hermes", destination: path.join("productivity", "hello-hermes") }]
  });

  assert.equal(
    findings.some((finding) => finding.code === "hermes_external_root_local_overlap"),
    caseInsensitive
  );
});

test("earlier external roots cannot contain or shadow the managed root", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-ancestor-root-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const hermesHome = path.join(sandbox, "hermes");
  const sharedRoot = path.join(sandbox, "shared");
  const externalRoot = path.join(sharedRoot, "skill-suitcase");
  await mkdir(path.join(externalRoot, "productivity", "hello-hermes"), { recursive: true });
  await mkdir(hermesHome, { recursive: true });
  await writeFile(
    path.join(externalRoot, "productivity", "hello-hermes", "SKILL.md"),
    "---\nname: hello-hermes\n---\n\n# Hello\n"
  );
  await writeFile(
    path.join(hermesHome, "config.yaml"),
    `skills:\n  external_dirs:\n    - ${sharedRoot}\n    - ${externalRoot}\n`
  );

  const findings = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot: externalRoot,
    planned: [{ skill: "hello-hermes", destination: path.join("productivity", "hello-hermes") }]
  });

  assert.equal(findings.some((finding) => finding.code === "hermes_external_root_precedence_overlap"), true);

  const nestedEarlierRoot = path.join(externalRoot, "legacy");
  await mkdir(path.join(nestedEarlierRoot, "archived-name"), { recursive: true });
  await writeFile(
    path.join(nestedEarlierRoot, "archived-name", "SKILL.md"),
    "---\nname: hello-hermes\n---\n\n# Earlier nested root\n"
  );
  await writeFile(
    path.join(hermesHome, "config.yaml"),
    `skills:\n  external_dirs:\n    - ${nestedEarlierRoot}\n    - ${externalRoot}\n`
  );
  const nestedFindings = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot: externalRoot,
    planned: [{ skill: "hello-hermes", destination: path.join("productivity", "hello-hermes") }]
  });
  assert.equal(nestedFindings.some((finding) => finding.code === "hermes_external_root_precedence_overlap"), true);

  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${externalRoot}\n`);
  await mkdir(path.join(externalRoot, "a", "legacy-name"), { recursive: true });
  await writeFile(
    path.join(externalRoot, "a", "legacy-name", "SKILL.md"),
    "---\nname: hello-hermes\n---\n\n# Managed-root shadow\n"
  );
  const managedShadowFindings = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot: externalRoot,
    planned: [{ skill: "hello-hermes", destination: path.join("productivity", "hello-hermes") }]
  });
  assert.equal(managedShadowFindings.some((finding) => finding.code === "hermes_managed_skill_shadow"), true);
});

test("Hermes shadow validation uses source metadata identity", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-source-identity-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const hermesHome = path.join(sandbox, "hermes");
  const externalRoot = path.join(sandbox, "external");
  const sourceSkill = path.join(sandbox, "catalog", "skills", "manifest-alias");
  const localSkill = path.join(hermesHome, "skills", "actual-name");
  await mkdir(externalRoot, { recursive: true });
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(localSkill, { recursive: true });
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${externalRoot}\n`);
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: actual-name\n---\n# Source\n");
  await writeFile(path.join(localSkill, "SKILL.md"), "---\nname: actual-name\n---\n# Local\n");

  const findings = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot: externalRoot,
    planned: [{
      skill: "manifest-alias",
      sourcePath: sourceSkill,
      destination: path.join("productivity", "manifest-alias")
    }]
  });

  assert.equal(findings.some((finding) =>
    finding.code === "hermes_local_skill_shadow" && finding.skill === "actual-name"
  ), true);
});

test("Hermes external roots reject duplicate planned metadata identities", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-duplicate-identity-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const hermesHome = path.join(sandbox, "hermes");
  const externalRoot = path.join(sandbox, "external");
  const firstSource = path.join(sandbox, "catalog", "skills", "first-alias");
  const secondSource = path.join(sandbox, "catalog", "skills", "second-alias");
  await mkdir(firstSource, { recursive: true });
  await mkdir(secondSource, { recursive: true });
  await writeFile(path.join(firstSource, "SKILL.md"), "---\nname: shared-name\n---\n# First\n");
  await writeFile(path.join(secondSource, "SKILL.md"), "---\nname: shared-name\n---\n# Second\n");

  const findings = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot: externalRoot,
    planned: [
      {
        skill: "first-alias",
        sourcePath: firstSource,
        destination: path.join("one", "first-alias")
      },
      {
        skill: "second-alias",
        sourcePath: secondSource,
        destination: path.join("two", "second-alias")
      }
    ]
  });

  assert.deepEqual(findings, [{
    code: "hermes_planned_skill_identity_conflict",
    message: "Planned Hermes skills first-alias, second-alias share identity shared-name and would create duplicate skills.",
    skill: "shared-name"
  }]);
});
