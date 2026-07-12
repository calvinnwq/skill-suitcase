import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const sampleCatalog = path.join(process.cwd(), "examples", "sample-catalog");
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

async function listFixtureFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory() ? listFixtureFiles(entryPath) : [entryPath];
  }));
  return paths.flat().sort();
}

test("portable sample catalog exercises the offline lifecycle through the CLI", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-sample-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const source = path.join(sandbox, "catalog");
  const targetRoot = path.join(sandbox, "agent-skills");
  const artifactRoot = path.join(sandbox, "pack");
  await cp(sampleCatalog, source, { recursive: true });
  await mkdir(targetRoot, { recursive: true });

  const sourceArgs = ["--source", source, "--json"];
  const targetArgs = [
    "--source",
    source,
    "--target",
    "agents",
    "--agents-skills",
    targetRoot,
    "--json"
  ];

  const validated = runCli<{
    ok: boolean;
    summary: { referencedSkills: number; upstreamDeclarations: number };
  }>(["validate", ...sourceArgs]);
  assert.equal(validated.ok, true);
  assert.equal(validated.summary.referencedSkills, 1);
  assert.equal(validated.summary.upstreamDeclarations, 0);

  const upstream = runCli<{
    ok: boolean;
    readOnly: boolean;
    summary: { declared: number; packageAvailable: number; failures: number };
    declarations: Array<{ skill: string; provider: string }>;
  }>(["upstream", "check", ...sourceArgs]);
  assert.equal(upstream.ok, true);
  assert.equal(upstream.readOnly, true);
  assert.deepEqual(upstream.summary, {
    declared: 0,
    packageAvailable: 0,
    failures: 0
  });
  assert.deepEqual(upstream.declarations, []);

  const planned = runCli<{ ok: boolean; planned: Array<{ skill: string }> }>([
    "plan",
    "--source",
    source,
    "--target",
    "agents",
    "--json"
  ]);
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.planned.map((item) => item.skill), ["hello-suitcase"]);

  const initialStatus = runCli<{ ok: boolean; summary: { missing: number } }>([
    "status",
    ...targetArgs
  ]);
  assert.equal(initialStatus.ok, true);
  assert.equal(initialStatus.summary.missing, 1);

  const initialDiff = runCli<{ ok: boolean; summary: { create: number } }>([
    "diff",
    ...targetArgs
  ]);
  assert.equal(initialDiff.ok, true);
  assert.ok(initialDiff.summary.create > 0);

  const dryPack = runCli<{ ok: boolean; dryRun: boolean; summary: { skills: number } }>([
    "pack",
    ...targetArgs,
    "--dry-run"
  ]);
  assert.equal(dryPack.ok, true);
  assert.equal(dryPack.dryRun, true);
  assert.equal(dryPack.summary.skills, 1);

  const packed = runCli<{
    ok: boolean;
    bundle: { artifactPath: string | null; manifestPath: string | null };
  }>(["pack", ...targetArgs, "--output", artifactRoot]);
  assert.equal(packed.ok, true);
  assert.ok(packed.bundle.artifactPath?.startsWith(`${artifactRoot}${path.sep}`));
  assert.equal(typeof packed.bundle.manifestPath, "string");

  const applied = runCli<{ ok: boolean; applied: { skills: string[] } }>([
    "apply",
    ...targetArgs,
    "--artifact",
    packed.bundle.artifactPath as string
  ]);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.applied.skills, ["hello-suitcase"]);

  const installedGreeting = path.join(
    targetRoot,
    "hello-suitcase",
    "references",
    "greeting.md"
  );
  const catalogGreeting = await readFile(
    path.join(source, "skills", "hello-suitcase", "references", "greeting.md"),
    "utf8"
  );
  assert.equal(await readFile(installedGreeting, "utf8"), catalogGreeting);

  const settled = runCli<{ ok: boolean; summary: { current: number } }>([
    "status",
    ...targetArgs
  ]);
  assert.equal(settled.ok, true);
  assert.equal(settled.summary.current, 1);

  const localEdit = `${catalogGreeting}\nLocal disposable edit.\n`;
  await writeFile(installedGreeting, localEdit);
  const dirty = runCli<{ ok: boolean; summary: { dirty: number } }>([
    "status",
    ...targetArgs
  ]);
  assert.equal(dirty.ok, true);
  assert.equal(dirty.summary.dirty, 1);

  const repaired = runCli<{ ok: boolean; repaired: { skills: string[] } }>([
    "repair",
    ...targetArgs,
    "--skill",
    "hello-suitcase",
    "--apply"
  ]);
  assert.equal(repaired.ok, true);
  assert.deepEqual(repaired.repaired.skills, ["hello-suitcase"]);
  assert.equal(await readFile(installedGreeting, "utf8"), catalogGreeting);

  const rolledBack = runCli<{ ok: boolean }>([
    "rollback",
    "--receipt",
    path.join(targetRoot, ".skill-suitcase-receipt.json"),
    "--json"
  ]);
  assert.equal(rolledBack.ok, true);
  assert.equal(await readFile(installedGreeting, "utf8"), localEdit);
});

test("portable sample catalog contains placeholders instead of local homes or secrets", async () => {
  const fixtureFiles = await listFixtureFiles(sampleCatalog);
  const fixtureText = (await Promise.all(
    fixtureFiles.map((file) => readFile(file, "utf8"))
  )).join("\n");
  const manifest = await readFile(path.join(sampleCatalog, "skill-suitcase.yaml"), "utf8");

  assert.match(manifest, /path: \/path\/to\/disposable\/agent-skills/);
  assert.doesNotMatch(fixtureText, /\/Users\/|\/home\/[^/\s]+|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
  assert.doesNotMatch(fixtureText, /(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*\S+/i);
});
