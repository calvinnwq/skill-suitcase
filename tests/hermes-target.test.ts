import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const cliPath = path.join(process.cwd(), "dist", "src", "cli.js");

function runCli<T>(args: string[]): T {
  const result = spawnSync("node", [cliPath, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, cliFailure(result));
  assert.equal(result.stderr, "");
  assert.notEqual(result.stdout.trim(), "");
  return JSON.parse(result.stdout) as T;
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
