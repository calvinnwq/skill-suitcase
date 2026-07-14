import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isCaseInsensitiveFilesystem } from "../src/core/filesystem-comparison.js";
import { expandHermesHomePrefix, validateHermesExternalRoot } from "../src/core/hermes-external-root.js";
import { computePackArtifactId } from "../src/core/packing/artifact-id.js";
import { apply } from "../src/apply.js";
import { importTarget } from "../src/import-target.js";
import { reconcile } from "../src/reconcile.js";
import { repair } from "../src/repair.js";
import { prune } from "../src/prune.js";
import { rollback } from "../src/rollback.js";
import { track } from "../src/track.js";

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

test("Hermes config tilde expansion accepts POSIX and Windows separators", () => {
  assert.equal(expandHermesHomePrefix("~/shared-skills", "/home/tester"), "/home/tester/shared-skills");
  assert.equal(expandHermesHomePrefix("~\\shared-skills", "C:\\Users\\tester"), "C:\\Users\\tester\\shared-skills");
});

async function createCategorizedRecoveryFixture(
  t: { after(fn: () => Promise<void> | void): void }
): Promise<{
  sandbox: string;
  source: string;
  sourceSkill: string;
  hermesHome: string;
  externalRoot: string;
  category: string;
  targetSkill: string;
  artifactPath: string;
  writeManifest: (included?: boolean) => Promise<void>;
}> {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-recovery-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const source = path.join(sandbox, "catalog");
  const sourceSkill = path.join(source, "skills", "hello-hermes");
  const hermesHome = path.join(sandbox, "hermes");
  const externalRoot = path.join(sandbox, "external");
  const category = path.join(externalRoot, "productivity");
  const targetSkill = path.join(category, "hello-hermes");
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(path.join(hermesHome, "skills"), { recursive: true });
  await mkdir(externalRoot, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: hello-hermes\n---\n# Catalog\n");
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${externalRoot}\n`);
  const writeManifest = async (included = true) => writeFile(path.join(source, "skill-suitcase.yaml"), `suitcases:
  core:
    skills:${included ? "\n      - hello-hermes" : " []"}
assignments:
  hermes:
    suitcases:
      - core
    categories:${included ? "\n      hello-hermes: productivity" : " {}"}
assignmentPaths:
  hermes:
    kind: hermes-external-skills-root
    assignment: hermes
    home: ${hermesHome}
    path: ${externalRoot}
compatibility:${included ? "\n  hello-hermes:\n    agents:\n      - hermes" : " {}"}
`);
  await writeManifest();
  const artifactRoot = path.join(sandbox, "artifact");
  const packed = runCli<{ bundle: { artifactPath: string } }>([
    "pack", "--source", source, "--target", "hermes", "--output", artifactRoot, "--json"
  ]);
  return {
    sandbox,
    source,
    sourceSkill,
    hermesHome,
    externalRoot,
    category,
    targetSkill,
    artifactPath: packed.bundle.artifactPath,
    writeManifest
  };
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

test("Hermes path override applies to a named categorized target", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-named-override-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const source = path.join(sandbox, "catalog");
  const sourceSkill = path.join(source, "skills", "hello-hermes");
  const hermesHome = path.join(sandbox, "hermes");
  const manifestRoot = path.join(sandbox, "manifest-external");
  const overrideRoot = path.join(sandbox, "override-external");
  const artifactRoot = path.join(sandbox, "pack");
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(path.join(hermesHome, "skills"), { recursive: true });
  await mkdir(overrideRoot, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: hello-hermes\n---\n# Hello\n");
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${overrideRoot}\n`);
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
  hermes-external:
    kind: hermes-external-skills-root
    assignment: hermes
    home: ${hermesHome}
    path: ${manifestRoot}
compatibility:
  hello-hermes:
    agents:
      - hermes
`);

  const targetArgs = [
    "--source", source,
    "--target", "hermes-external",
    "--hermes-skills", overrideRoot,
    "--json"
  ];
  const packed = runCli<{ bundle: { artifactPath: string } }>([
    "pack", ...targetArgs, "--output", artifactRoot
  ]);
  const applied = runCli<{ ok: boolean; applied: { skills: string[] } }>([
    "apply", ...targetArgs, "--artifact", packed.bundle.artifactPath
  ]);

  assert.equal(applied.ok, true);
  assert.deepEqual(applied.applied.skills, ["hello-hermes"]);
  assert.equal(
    await readFile(path.join(overrideRoot, "productivity", "hello-hermes", "SKILL.md"), "utf8"),
    "---\nname: hello-hermes\n---\n# Hello\n"
  );
  await assert.rejects(readFile(path.join(manifestRoot, "productivity", "hello-hermes", "SKILL.md"), "utf8"));
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

test("categorized Hermes import-target refuses a category swapped before target reads", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  await mkdir(fixture.targetSkill, { recursive: true });
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), "---\nname: hello-hermes\n---\n# Catalog\n");
  const tracked = await track({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"]
  });
  assert.equal(tracked.ok, true);
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), "local edit\n");
  const receiptPath = path.join(fixture.externalRoot, ".skill-suitcase-receipt.json");
  const receiptBefore = await readFile(receiptPath, "utf8");
  const retainedCategory = path.join(fixture.sandbox, "retained-import-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-import-category");
  await mkdir(path.join(attackedCategory, "hello-hermes"), { recursive: true });
  await writeFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "outside victim\n");

  const result = await importTarget({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"],
    apply: true,
    __test: {
      beforeTargetReadForSkill: async () => {
        await rename(fixture.category, retainedCategory);
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "import_write_failed"), true);
  assert.equal(await readFile(path.join(fixture.sourceSkill, "SKILL.md"), "utf8"), "---\nname: hello-hermes\n---\n# Catalog\n");
  assert.equal(await readFile(path.join(retainedCategory, "hello-hermes", "SKILL.md"), "utf8"), "local edit\n");
  assert.equal(await readFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "utf8"), "outside victim\n");
  assert.equal(await readFile(receiptPath, "utf8"), receiptBefore);
});

test("categorized Hermes track refuses a category swapped before inspection", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  await mkdir(fixture.targetSkill, { recursive: true });
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), "---\nname: hello-hermes\n---\n# Catalog\n");
  const retainedCategory = path.join(fixture.sandbox, "retained-track-inspection-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-track-inspection-category");
  await mkdir(path.join(attackedCategory, "hello-hermes"), { recursive: true });
  await writeFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "---\nname: hello-hermes\n---\n# Catalog\n");

  const result = await track({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"],
    __test: {
      beforeTargetInspectionForSkill: async () => {
        await rename(fixture.category, retainedCategory);
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_path"), true);
  await assert.rejects(readFile(path.join(fixture.externalRoot, ".skill-suitcase-receipt.json"), "utf8"), /ENOENT/);
  assert.equal(await readFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "utf8"), "---\nname: hello-hermes\n---\n# Catalog\n");
});

test("categorized Hermes track refuses a category swapped before receipt adoption", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  await mkdir(fixture.targetSkill, { recursive: true });
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), "---\nname: hello-hermes\n---\n# Catalog\n");
  const retainedCategory = path.join(fixture.sandbox, "retained-track-receipt-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-track-receipt-category");
  await mkdir(path.join(attackedCategory, "hello-hermes"), { recursive: true });
  await writeFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "---\nname: hello-hermes\n---\n# Catalog\n");

  const result = await track({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"],
    __test: {
      beforeReceiptWriteForSkill: async () => {
        await rename(fixture.category, retainedCategory);
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_path"), true);
  await assert.rejects(readFile(path.join(fixture.externalRoot, ".skill-suitcase-receipt.json"), "utf8"), /ENOENT/);
  assert.equal(await readFile(path.join(retainedCategory, "hello-hermes", "SKILL.md"), "utf8"), "---\nname: hello-hermes\n---\n# Catalog\n");
  assert.equal(await readFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "utf8"), "---\nname: hello-hermes\n---\n# Catalog\n");
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
  assert.equal(symlinkShadow.stdout.errors.some((error) => error.code === "hermes_shadow_directory_symlink"), true);
  assert.equal(symlinkShadow.stdout.errors.some((error) => error.code === "hermes_local_skill_shadow"), false);
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

test("categorized Hermes registration uses the process environment for variable expansion", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-registration-env-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const hermesHome = path.join(sandbox, "hermes");
  const installRoot = path.join(hermesHome, "external");
  const otherHome = path.join(sandbox, "other-hermes");
  await mkdir(installRoot, { recursive: true });
  await mkdir(path.join(otherHome, "external"), { recursive: true });
  await writeFile(path.join(hermesHome, "config.yaml"), "skills:\n  external_dirs: ${HERMES_HOME}/external\n");
  const originalHermesHome = process.env["HERMES_HOME"];
  const unresolvedVariable = "SKILL_SUITCASE_UNSET_HERMES_ROOT";
  const originalUnresolvedValue = process.env[unresolvedVariable];
  t.after(() => {
    if (originalHermesHome === undefined) delete process.env["HERMES_HOME"];
    else process.env["HERMES_HOME"] = originalHermesHome;
    if (originalUnresolvedValue === undefined) delete process.env[unresolvedVariable];
    else process.env[unresolvedVariable] = originalUnresolvedValue;
  });

  process.env["HERMES_HOME"] = otherHome;
  const mismatched = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot,
    planned: [{ skill: "hello-hermes", destination: path.join("productivity", "hello-hermes") }]
  });
  assert.equal(mismatched.some((finding) => finding.code === "hermes_external_root_unregistered"), true);

  delete process.env["HERMES_HOME"];
  const unresolved = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot,
    planned: [{ skill: "hello-hermes", destination: path.join("productivity", "hello-hermes") }]
  });
  assert.equal(unresolved.some((finding) => finding.code === "hermes_external_root_unregistered"), true);

  const literalVariableRoot = path.join(hermesHome, "${HERMES_HOME}", "external");
  await mkdir(literalVariableRoot, { recursive: true });
  const literalVariable = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot: literalVariableRoot,
    planned: [{ skill: "hello-hermes", destination: path.join("productivity", "hello-hermes") }]
  });
  assert.equal(literalVariable.some((finding) => finding.code === "hermes_external_root_unregistered"), true);

  delete process.env[unresolvedVariable];
  const literalPrecedingRoot = path.join(hermesHome, `\${${unresolvedVariable}}`);
  await mkdir(path.join(literalPrecedingRoot, "hello-hermes"), { recursive: true });
  await writeFile(
    path.join(literalPrecedingRoot, "hello-hermes", "SKILL.md"),
    "---\nname: hello-hermes\n---\n# Earlier shadow\n"
  );
  await writeFile(
    path.join(hermesHome, "config.yaml"),
    `skills:\n  external_dirs:\n    - \${${unresolvedVariable}}\n    - ${installRoot}\n`
  );
  const unresolvedPrecedingEntry = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot,
    planned: [{ skill: "hello-hermes", destination: path.join("productivity", "hello-hermes") }]
  });
  assert.equal(
    unresolvedPrecedingEntry.some((finding) => finding.code === "hermes_external_root_unregistered"),
    true
  );
});

test("categorized Hermes rejects planned destinations that alias on the target filesystem", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-hermes-destination-alias-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const hermesHome = path.join(sandbox, "hermes");
  const installRoot = path.join(sandbox, "external");
  await mkdir(installRoot, { recursive: true });
  await mkdir(hermesHome, { recursive: true });
  await writeFile(path.join(hermesHome, "config.yaml"), `skills:\n  external_dirs: ${installRoot}\n`);

  const exactConflict = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot,
    planned: [
      { skill: "first", destination: path.join("productivity", "shared") },
      { skill: "second", destination: path.join("productivity", "shared") }
    ]
  });
  assert.equal(
    exactConflict.some((finding) => finding.code === "hermes_planned_destination_conflict"),
    true
  );

  const caseConflict = await validateHermesExternalRoot({
    home: hermesHome,
    installRoot,
    planned: [
      { skill: "Foo", destination: path.join("Product", "Foo") },
      { skill: "foo", destination: path.join("product", "foo") }
    ]
  });
  assert.equal(
    caseConflict.some((finding) => finding.code === "hermes_planned_destination_conflict"),
    await isCaseInsensitiveFilesystem(installRoot)
  );
});

test("categorized Hermes copy apply retains and reports an unsafe rollback backup", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const initial = await apply({ source: fixture.source, target: "hermes", artifact: fixture.artifactPath });
  assert.equal(initial.ok, true);
  await writeFile(path.join(fixture.sourceSkill, "SKILL.md"), "---\nname: hello-hermes\n---\n# Updated catalog\n");
  const updatedArtifact = runCli<{ bundle: { artifactPath: string } }>([
    "pack",
    "--source", fixture.source,
    "--target", "hermes",
    "--output", path.join(fixture.sandbox, "updated-artifact"),
    "--json"
  ]);
  const retainedCategory = path.join(fixture.sandbox, "retained-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-category");
  await mkdir(path.join(attackedCategory, "hello-hermes"), { recursive: true });
  await writeFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "outside victim\n");

  const result = await apply({
    source: fixture.source,
    target: "hermes",
    artifact: updatedArtifact.bundle.artifactPath,
    __test: {
      afterCopyBackup: async () => {
        await rename(fixture.category, retainedCategory);
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "apply_recovery_failed"), true);
  assert.equal(await readFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "utf8"), "outside victim\n");
  assert.equal(
    (await readdir(path.join(retainedCategory, "hello-hermes"))).some((entry) => entry.startsWith("SKILL.md.previous-")),
    true
  );
});

test("categorized Hermes apply refuses an unowned exact planned destination", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  await mkdir(fixture.targetSkill, { recursive: true });
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), "unowned target\n");

  const result = await apply({
    source: fixture.source,
    target: "hermes",
    artifact: fixture.artifactPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.preApplyStatus.summary.unknown, 1);
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_state"), true);
  assert.equal(await readFile(path.join(fixture.targetSkill, "SKILL.md"), "utf8"), "unowned target\n");
});

test("categorized Hermes symlink materialization remains valid for apply, status, and diff", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);

  const result = await apply({
    source: fixture.source,
    target: "hermes",
    artifact: fixture.artifactPath,
    mode: "symlink"
  });

  assert.equal(result.ok, true);
  assert.equal(await readlink(fixture.targetSkill), fixture.sourceSkill);
  assert.equal(result.postApplyStatus?.ok, true);
  assert.equal(result.postApplyStatus?.summary.current, 1);

  const targetArgs = ["--source", fixture.source, "--target", "hermes", "--json"];
  const settled = runCli<{ ok: boolean; summary: { current: number } }>([
    "status", ...targetArgs
  ]);
  assert.equal(settled.ok, true);
  assert.equal(settled.summary.current, 1);

  const unchanged = runCli<{ ok: boolean; summary: { unchanged: number } }>([
    "diff", ...targetArgs
  ]);
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.summary.unchanged, 1);

  const nestedDirectory = path.join(fixture.sandbox, "nested-symlink-directory");
  await mkdir(nestedDirectory);
  await symlink(nestedDirectory, path.join(fixture.sourceSkill, "linked-directory"), "dir");
  const nestedShadow = runCliResult<{ errors: Array<{ code: string }> }>([
    "status", ...targetArgs
  ]);
  assert.notEqual(nestedShadow.status, 0);
  assert.equal(nestedShadow.stdout.errors.some((error) => error.code === "hermes_shadow_directory_symlink"), true);
  await rm(path.join(fixture.sourceSkill, "linked-directory"));

  const unexpectedSource = path.join(fixture.sandbox, "unexpected-symlink-source");
  await mkdir(unexpectedSource);
  await writeFile(path.join(unexpectedSource, "SKILL.md"), "---\nname: hello-hermes\n---\n# Unexpected\n");
  await rm(fixture.targetSkill);
  await symlink(unexpectedSource, fixture.targetSkill, "dir");
  const shadowed = runCliResult<{ errors: Array<{ code: string }> }>([
    "status", ...targetArgs
  ]);
  assert.notEqual(shadowed.status, 0);
  assert.equal(shadowed.stdout.errors.some((error) => error.code === "hermes_shadow_directory_symlink"), true);
});

test("categorized Hermes status and diff match planned destinations across category casing", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const result = await apply({
    source: fixture.source,
    target: "hermes",
    artifact: fixture.artifactPath
  });
  assert.equal(result.ok, true);

  const mixedCaseCategory = path.join(fixture.externalRoot, "Productivity");
  try {
    await realpath(mixedCaseCategory);
  } catch {
    t.skip("requires a case-insensitive filesystem");
    return;
  }
  await rename(fixture.category, mixedCaseCategory);

  const targetArgs = ["--source", fixture.source, "--target", "hermes", "--json"];
  const settled = runCli<{ ok: boolean; summary: { current: number } }>([
    "status", ...targetArgs
  ]);
  assert.equal(settled.ok, true);
  assert.equal(settled.summary.current, 1);

  const unchanged = runCli<{ ok: boolean; summary: { unchanged: number } }>([
    "diff", ...targetArgs
  ]);
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.summary.unchanged, 1);
});

test("categorized Hermes symlink apply cleanup refuses a replaced category", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const retainedCategory = path.join(fixture.sandbox, "retained-symlink-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-symlink-category");

  const result = await apply({
    source: fixture.source,
    target: "hermes",
    artifact: fixture.artifactPath,
    mode: "symlink",
    __test: {
      failAfterSuccessfulWrites: 1,
      beforeSymlinkFailureCleanup: async () => {
        await rename(fixture.category, retainedCategory);
        await mkdir(attackedCategory, { recursive: true });
        await symlink(fixture.sourceSkill, path.join(attackedCategory, "hello-hermes"));
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "symlink_cleanup_failed"), true);
  assert.equal(await readlink(path.join(attackedCategory, "hello-hermes")), fixture.sourceSkill);
  assert.equal(await readlink(path.join(retainedCategory, "hello-hermes")), fixture.sourceSkill);
});

test("categorized Hermes symlink cleanup revalidates its parent after classification", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const retainedCategory = path.join(fixture.sandbox, "retained-classified-symlink-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-classified-symlink-category");

  const result = await apply({
    source: fixture.source,
    target: "hermes",
    artifact: fixture.artifactPath,
    mode: "symlink",
    __test: {
      failAfterSuccessfulWrites: 1,
      afterSymlinkCleanupClassification: async () => {
        await rename(fixture.category, retainedCategory);
        await mkdir(attackedCategory, { recursive: true });
        await symlink(fixture.sourceSkill, path.join(attackedCategory, "hello-hermes"));
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "symlink_cleanup_failed"), true);
  assert.equal(await readlink(path.join(attackedCategory, "hello-hermes")), fixture.sourceSkill);
  assert.equal(await readlink(path.join(retainedCategory, "hello-hermes")), fixture.sourceSkill);
});

test("categorized Hermes symlink cleanup refuses a replaced link after classification", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const replacement = "replacement data\n";

  const result = await apply({
    source: fixture.source,
    target: "hermes",
    artifact: fixture.artifactPath,
    mode: "symlink",
    __test: {
      failAfterSuccessfulWrites: 1,
      afterSymlinkCleanupClassification: async (targetPath) => {
        await rm(targetPath);
        await writeFile(targetPath, replacement);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "symlink_cleanup_failed"), true);
  assert.equal(await readFile(fixture.targetSkill, "utf8"), replacement);
});

test("categorized Hermes copy apply reports a retained final backup", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const initial = await apply({ source: fixture.source, target: "hermes", artifact: fixture.artifactPath });
  assert.equal(initial.ok, true);
  await writeFile(path.join(fixture.sourceSkill, "SKILL.md"), "---\nname: hello-hermes\n---\n# Updated catalog\n");
  const updatedArtifact = runCli<{ bundle: { artifactPath: string } }>([
    "pack",
    "--source", fixture.source,
    "--target", "hermes",
    "--output", path.join(fixture.sandbox, "cleanup-artifact"),
    "--json"
  ]);
  const retainedCategory = path.join(fixture.sandbox, "retained-cleanup-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-cleanup-category");
  let retainedBackupPath: string | null = null;
  let attackedBackupPath: string | null = null;

  const result = await apply({
    source: fixture.source,
    target: "hermes",
    artifact: updatedArtifact.bundle.artifactPath,
    __test: {
      beforeCopyBackupCleanup: async (_targetPath, backupPath) => {
        retainedBackupPath = path.join(retainedCategory, path.relative(fixture.category, backupPath));
        attackedBackupPath = path.join(attackedCategory, path.relative(fixture.category, backupPath));
        await rename(fixture.category, retainedCategory);
        await mkdir(path.dirname(attackedBackupPath), { recursive: true });
        await writeFile(attackedBackupPath, "outside backup\n");
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) =>
    error.code === "apply_backup_cleanup_failed" && error.message.includes("Apply backup retained at")
  ), true);
  assert.notEqual(retainedBackupPath, null);
  assert.notEqual(attackedBackupPath, null);
  assert.equal(await readFile(retainedBackupPath!, "utf8"), "---\nname: hello-hermes\n---\n# Catalog\n");
  assert.equal(await readFile(attackedBackupPath!, "utf8"), "outside backup\n");
});

test("categorized Hermes reconcile retains and reports an unsafe recovery backup", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  await mkdir(fixture.targetSkill, { recursive: true });
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), "old target\n");
  const retainedCategory = path.join(fixture.sandbox, "retained-reconcile-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-reconcile-category");
  await mkdir(path.join(attackedCategory, "hello-hermes"), { recursive: true });
  await writeFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "outside victim\n");

  const result = await reconcile({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"],
    apply: true,
    __test: {
      failAfterBackup: true,
      beforeFailureRecoveryForSkill: async () => {
        await rename(fixture.category, retainedCategory);
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "reconcile_recovery_failed"), true);
  assert.equal(result.reconciled.backups.length, 1);
  assert.equal(await readFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "utf8"), "outside victim\n");
  assert.equal(
    (await readdir(path.join(fixture.externalRoot, ".archive"))).some((entry) => entry.includes("suitcase-pre-reconcile")),
    true
  );
});

test("categorized Hermes repair retains and reports an unsafe recovery backup", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const initial = await apply({ source: fixture.source, target: "hermes", artifact: fixture.artifactPath });
  assert.equal(initial.ok, true);
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), "dirty target\n");
  const retainedCategory = path.join(fixture.sandbox, "retained-repair-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-repair-category");
  await mkdir(path.join(attackedCategory, "hello-hermes"), { recursive: true });
  await writeFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "outside victim\n");

  const result = await repair({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"],
    apply: true,
    __test: {
      failAfterBackup: true,
      afterStagingForSkill: async (_skill, stagingPath) => {
        assert.equal(path.dirname(stagingPath), path.join(fixture.externalRoot, ".archive"));
        const findings = await validateHermesExternalRoot({
          home: fixture.hermesHome,
          installRoot: fixture.externalRoot,
          planned: [{
            skill: "hello-hermes",
            sourcePath: fixture.sourceSkill,
            destination: path.join("productivity", "hello-hermes")
          }]
        });
        assert.equal(findings.some((finding) => finding.code === "hermes_managed_skill_shadow"), false);
      },
      beforeFailureRecoveryForSkill: async () => {
        await rename(fixture.category, retainedCategory);
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "repair_recovery_failed"), true);
  assert.equal(result.repaired.backups.length, 1);
  assert.equal(await readFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "utf8"), "outside victim\n");
  assert.equal(
    (await readdir(path.join(fixture.externalRoot, ".archive"))).some((entry) => entry.includes("suitcase-pre-repair")),
    true
  );
});

test("categorized Hermes reconcile rollback accepts archived transaction backups", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  await mkdir(fixture.targetSkill, { recursive: true });
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), "old unmanaged target\n");
  const reconciled = await reconcile({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"],
    apply: true
  });
  assert.equal(reconciled.ok, true);
  assert.equal(path.dirname(reconciled.reconciled.backups[0]!.backupPath), path.join(fixture.externalRoot, ".archive"));

  const rolledBack = await rollback({
    receipt: path.join(fixture.externalRoot, ".skill-suitcase-receipt.json")
  });
  assert.equal(rolledBack.ok, true);
  assert.equal(await readFile(path.join(fixture.targetSkill, "SKILL.md"), "utf8"), "old unmanaged target\n");
});

test("categorized Hermes copy rollback refuses an in-root category symlink", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const initial = await apply({ source: fixture.source, target: "hermes", artifact: fixture.artifactPath });
  assert.equal(initial.ok, true);
  await writeFile(path.join(fixture.sourceSkill, "SKILL.md"), "---\nname: hello-hermes\n---\n# Updated catalog\n");
  const updatedArtifact = runCli<{ bundle: { artifactPath: string } }>([
    "pack",
    "--source", fixture.source,
    "--target", "hermes",
    "--output", path.join(fixture.sandbox, "rollback-symlink-artifact"),
    "--json"
  ]);
  const updated = await apply({ source: fixture.source, target: "hermes", artifact: updatedArtifact.bundle.artifactPath });
  assert.equal(updated.ok, true);
  const redirectedCategory = path.join(fixture.externalRoot, "redirected-productivity");
  await rename(fixture.category, redirectedCategory);
  await symlink(redirectedCategory, fixture.category);

  const result = await rollback({ receipt: path.join(fixture.externalRoot, ".skill-suitcase-receipt.json") });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_drift"), true);
  assert.equal(await readFile(path.join(redirectedCategory, "hello-hermes", "SKILL.md"), "utf8"), "---\nname: hello-hermes\n---\n# Updated catalog\n");
});

test("categorized Hermes symlink rollback refuses a replaced link after classification", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const applied = await apply({
    source: fixture.source,
    target: "hermes",
    artifact: fixture.artifactPath,
    mode: "symlink"
  });
  assert.equal(applied.ok, true);
  const replacement = "replacement data\n";

  const result = await rollback({
    receipt: path.join(fixture.externalRoot, ".skill-suitcase-receipt.json"),
    __test: {
      afterAppliedSymlinkClassification: async (targetPath) => {
        await rm(targetPath);
        await writeFile(targetPath, replacement);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_drift"), true);
  assert.equal(await readFile(fixture.targetSkill, "utf8"), replacement);
});

test("categorized Hermes copy rollback revalidates before restoring a file", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const initial = await apply({ source: fixture.source, target: "hermes", artifact: fixture.artifactPath });
  assert.equal(initial.ok, true);
  await writeFile(path.join(fixture.sourceSkill, "SKILL.md"), "---\nname: hello-hermes\n---\n# Updated catalog\n");
  const updatedArtifact = runCli<{ bundle: { artifactPath: string } }>([
    "pack",
    "--source", fixture.source,
    "--target", "hermes",
    "--output", path.join(fixture.sandbox, "rollback-race-artifact"),
    "--json"
  ]);
  const updated = await apply({ source: fixture.source, target: "hermes", artifact: updatedArtifact.bundle.artifactPath });
  assert.equal(updated.ok, true);
  const retainedCategory = path.join(fixture.sandbox, "retained-rollback-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-rollback-category");
  let swapped = false;

  const result = await rollback({
    receipt: path.join(fixture.externalRoot, ".skill-suitcase-receipt.json"),
    __test: {
      beforeFileMutation: async () => {
        if (swapped) return;
        swapped = true;
        await rename(fixture.category, retainedCategory);
        await mkdir(path.join(attackedCategory, "hello-hermes"), { recursive: true });
        await writeFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "outside victim\n");
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "restore_write_failed"), true);
  assert.equal(await readFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "utf8"), "outside victim\n");
  assert.equal(await readFile(path.join(retainedCategory, "hello-hermes", "SKILL.md"), "utf8"), "---\nname: hello-hermes\n---\n# Updated catalog\n");
});

test("categorized Hermes copy rollback replaces a swapped target symlink", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const initial = await apply({ source: fixture.source, target: "hermes", artifact: fixture.artifactPath });
  assert.equal(initial.ok, true);
  await writeFile(path.join(fixture.sourceSkill, "SKILL.md"), "---\nname: hello-hermes\n---\n# Updated catalog\n");
  const updatedArtifact = runCli<{ bundle: { artifactPath: string } }>([
    "pack",
    "--source", fixture.source,
    "--target", "hermes",
    "--output", path.join(fixture.sandbox, "rollback-target-symlink-artifact"),
    "--json"
  ]);
  const updated = await apply({ source: fixture.source, target: "hermes", artifact: updatedArtifact.bundle.artifactPath });
  assert.equal(updated.ok, true);
  const outsideFile = path.join(fixture.sandbox, "outside-target.txt");
  await writeFile(outsideFile, "outside victim\n");
  let swapped = false;

  const result = await rollback({
    receipt: path.join(fixture.externalRoot, ".skill-suitcase-receipt.json"),
    __test: {
      beforeFileMutation: async (targetPath) => {
        if (swapped) return;
        swapped = true;
        await rm(targetPath);
        await symlink(outsideFile, targetPath);
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(await readFile(outsideFile, "utf8"), "outside victim\n");
  assert.equal(await readFile(path.join(fixture.targetSkill, "SKILL.md"), "utf8"), "---\nname: hello-hermes\n---\n# Catalog\n");
  await assert.rejects(readlink(path.join(fixture.targetSkill, "SKILL.md")));
});

test("categorized Hermes copy rollback accepts an already removed category", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const initial = await apply({ source: fixture.source, target: "hermes", artifact: fixture.artifactPath });
  assert.equal(initial.ok, true);
  let removed = false;

  const result = await rollback({
    receipt: path.join(fixture.externalRoot, ".skill-suitcase-receipt.json"),
    __test: {
      beforeFileMutation: async () => {
        if (removed) return;
        removed = true;
        await rm(fixture.category, { recursive: true, force: true });
      }
    }
  });

  assert.equal(result.ok, true);
  await assert.rejects(readFile(path.join(fixture.targetSkill, "SKILL.md"), "utf8"), /ENOENT/);
});

test("categorized Hermes copy rollback rejects a symlinked parent before a missing file", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const initial = await apply({ source: fixture.source, target: "hermes", artifact: fixture.artifactPath });
  assert.equal(initial.ok, true);
  const retainedCategory = path.join(fixture.sandbox, "retained-missing-file-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-missing-file-category");
  let swapped = false;

  const result = await rollback({
    receipt: path.join(fixture.externalRoot, ".skill-suitcase-receipt.json"),
    __test: {
      beforeFileMutation: async () => {
        if (swapped) return;
        swapped = true;
        await rename(fixture.category, retainedCategory);
        await mkdir(attackedCategory, { recursive: true });
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "rollback_remove_failed"), true);
  assert.equal(await readFile(path.join(retainedCategory, "hello-hermes", "SKILL.md"), "utf8"), "---\nname: hello-hermes\n---\n# Catalog\n");
  await assert.rejects(readFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "utf8"), /ENOENT/);
});

test("categorized Hermes copy rollback rejects a symlinked parent before removing an empty target", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const initial = await apply({ source: fixture.source, target: "hermes", artifact: fixture.artifactPath });
  assert.equal(initial.ok, true);
  const retainedCategory = path.join(fixture.sandbox, "retained-missing-target-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-missing-target-category");

  const result = await rollback({
    receipt: path.join(fixture.externalRoot, ".skill-suitcase-receipt.json"),
    __test: {
      beforeMissingInstallTargetRemoval: async () => {
        await rename(fixture.category, retainedCategory);
        await mkdir(attackedCategory, { recursive: true });
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "rollback_remove_failed"), true);
  assert.deepEqual(await readdir(path.join(retainedCategory, "hello-hermes")), []);
  await assert.rejects(readFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "utf8"), /ENOENT/);
});

test("categorized Hermes reconcile rollback preserves a backup under a replaced archive", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  await mkdir(fixture.targetSkill, { recursive: true });
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), "old unmanaged target\n");
  const reconciled = await reconcile({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"],
    apply: true
  });
  assert.equal(reconciled.ok, true);
  const backupPath = reconciled.reconciled.backups[0]!.backupPath;
  const archivePath = path.join(fixture.externalRoot, ".archive");
  const retainedArchive = path.join(fixture.sandbox, "retained-archive");
  const attackedArchive = path.join(fixture.sandbox, "attacked-archive");
  const attackedBackup = path.join(attackedArchive, path.basename(backupPath));

  const result = await rollback({
    receipt: path.join(fixture.externalRoot, ".skill-suitcase-receipt.json"),
    __test: {
      beforeReconcileBackupRemoval: async () => {
        await rename(archivePath, retainedArchive);
        await mkdir(attackedBackup, { recursive: true });
        await writeFile(path.join(attackedBackup, "sentinel.txt"), "outside backup\n");
        await symlink(attackedArchive, archivePath);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "rollback_remove_failed"), true);
  assert.equal(await readFile(path.join(attackedBackup, "sentinel.txt"), "utf8"), "outside backup\n");
  assert.equal(await readFile(path.join(retainedArchive, path.basename(backupPath), "SKILL.md"), "utf8"), "old unmanaged target\n");
});

test("categorized Hermes reconcile rollback accepts an already removed archive", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  await mkdir(fixture.targetSkill, { recursive: true });
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), "old unmanaged target\n");
  const reconciled = await reconcile({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"],
    apply: true
  });
  assert.equal(reconciled.ok, true);

  const result = await rollback({
    receipt: path.join(fixture.externalRoot, ".skill-suitcase-receipt.json"),
    __test: {
      beforeReconcileBackupRemoval: async () => {
        await rm(path.join(fixture.externalRoot, ".archive"), { recursive: true, force: true });
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(await readFile(path.join(fixture.targetSkill, "SKILL.md"), "utf8"), "old unmanaged target\n");
});

test("categorized Hermes reconcile rollback rejects a symlinked archive before a missing backup", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  await mkdir(fixture.targetSkill, { recursive: true });
  await writeFile(path.join(fixture.targetSkill, "SKILL.md"), "old unmanaged target\n");
  const reconciled = await reconcile({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"],
    apply: true
  });
  assert.equal(reconciled.ok, true);
  const backupPath = reconciled.reconciled.backups[0]!.backupPath;
  const archivePath = path.join(fixture.externalRoot, ".archive");
  const retainedArchive = path.join(fixture.sandbox, "retained-missing-backup-archive");
  const attackedArchive = path.join(fixture.sandbox, "attacked-missing-backup-archive");

  const result = await rollback({
    receipt: path.join(fixture.externalRoot, ".skill-suitcase-receipt.json"),
    __test: {
      beforeReconcileBackupRemoval: async () => {
        await rename(archivePath, retainedArchive);
        await mkdir(attackedArchive, { recursive: true });
        await symlink(attackedArchive, archivePath);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "rollback_remove_failed"), true);
  assert.equal(await readFile(path.join(retainedArchive, path.basename(backupPath), "SKILL.md"), "utf8"), "old unmanaged target\n");
  await assert.rejects(readFile(path.join(attackedArchive, path.basename(backupPath), "SKILL.md"), "utf8"), /ENOENT/);
});

test("categorized Hermes prune retains quarantine when rollback parent is replaced", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const initial = await apply({ source: fixture.source, target: "hermes", artifact: fixture.artifactPath });
  assert.equal(initial.ok, true);
  await fixture.writeManifest(false);
  const planned = await prune({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"],
    dryRun: true
  });
  assert.ok(planned.plan.id);
  assert.ok(planned.plan.quarantineRoot);
  const retainedCategory = path.join(fixture.sandbox, "retained-prune-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-prune-category");
  await mkdir(path.join(attackedCategory, "hello-hermes"), { recursive: true });
  await writeFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "outside victim\n");

  const result = await prune({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"],
    planId: planned.plan.id,
    apply: true,
    __test: {
      failAfterMutationForSkill: "hello-hermes",
      beforeFailureRecovery: async () => {
        await rename(fixture.category, retainedCategory);
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.message.includes("directory restore")), true);
  assert.equal(await readFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "utf8"), "outside victim\n");
  assert.equal(result.transactionPath !== null, true);
  assert.equal(result.receiptBackupPath !== null, true);
  assert.equal((await readdir(path.join(planned.plan.quarantineRoot, "quarantine"))).includes("hello-hermes"), true);
});

test("categorized Hermes prune revalidates its parent after candidate inspection", async (t) => {
  const fixture = await createCategorizedRecoveryFixture(t);
  const initial = await apply({ source: fixture.source, target: "hermes", artifact: fixture.artifactPath });
  assert.equal(initial.ok, true);
  await fixture.writeManifest(false);
  const planned = await prune({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"],
    dryRun: true
  });
  assert.ok(planned.plan.id);
  const retainedCategory = path.join(fixture.sandbox, "retained-revalidated-prune-category");
  const attackedCategory = path.join(fixture.sandbox, "attacked-revalidated-prune-category");
  await mkdir(path.join(attackedCategory, "hello-hermes"), { recursive: true });
  await writeFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "outside victim\n");

  const result = await prune({
    source: fixture.source,
    target: "hermes",
    skills: ["hello-hermes"],
    planId: planned.plan.id,
    apply: true,
    __test: {
      afterCandidateRevalidation: async () => {
        await rename(fixture.category, retainedCategory);
        await symlink(attackedCategory, fixture.category);
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "prune_apply_failed"), true);
  assert.equal(await readFile(path.join(retainedCategory, "hello-hermes", "SKILL.md"), "utf8"), "---\nname: hello-hermes\n---\n# Catalog\n");
  assert.equal(await readFile(path.join(attackedCategory, "hello-hermes", "SKILL.md"), "utf8"), "outside victim\n");
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
