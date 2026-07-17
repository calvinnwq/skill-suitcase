import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
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

function runSampleContractTests(source: string): void {
  const result = spawnSync(
    "python3",
    ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
    {
      cwd: source,
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
    }
  );
  assert.equal(result.status, 0, cliFailure(result));
}

async function listFixtureFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory() ? listFixtureFiles(entryPath) : [entryPath];
  }));
  return paths.flat().sort();
}

type TreeSnapshotEntry = {
  path: string;
  kind: "directory" | "file" | "symlink";
  mode: number;
  mtimeMs: number;
  value: string | null;
};

async function snapshotTree(root: string): Promise<TreeSnapshotEntry[]> {
  const snapshot: TreeSnapshotEntry[] = [];

  async function visit(relativePath: string): Promise<void> {
    const entryPath = path.join(root, relativePath);
    const entryStat = await lstat(entryPath);
    const shared = {
      path: relativePath || ".",
      mode: entryStat.mode & 0o777,
      mtimeMs: entryStat.mtimeMs
    };

    if (entryStat.isDirectory()) {
      snapshot.push({ ...shared, kind: "directory", value: null });
      const entries = await readdir(entryPath);
      for (const entry of entries.sort()) {
        await visit(path.join(relativePath, entry));
      }
      return;
    }

    if (entryStat.isFile()) {
      const digest = createHash("sha256").update(await readFile(entryPath)).digest("hex");
      snapshot.push({ ...shared, kind: "file", value: digest });
      return;
    }

    if (entryStat.isSymbolicLink()) {
      snapshot.push({ ...shared, kind: "symlink", value: await readlink(entryPath) });
      return;
    }

    throw new Error(`unsupported filesystem entry in snapshot: ${entryPath}`);
  }

  await visit("");
  return snapshot;
}

test("portable sample catalog exercises the offline lifecycle through the CLI", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-sample-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const source = path.join(sandbox, "catalog");
  const targetRoot = path.join(sandbox, "agent-skills");
  const artifactRoot = path.join(sandbox, "pack");
  await cp(sampleCatalog, source, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  runSampleContractTests(source);

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

  const imported = runCli<{
    ok: boolean;
    summary: { discoveredSkills: number; referencedSkills: number; findings: number };
  }>(["import", ...sourceArgs]);
  assert.equal(imported.ok, true);
  assert.equal(imported.summary.discoveredSkills, 1);
  assert.equal(imported.summary.referencedSkills, 1);
  assert.equal(imported.summary.findings, 0);

  const validated = runCli<{
    ok: boolean;
    summary: {
      referencedSkills: number;
      upstreamDeclarations: number;
      contractsEvaluated: number;
      contractsComplete: number;
      findings: number;
    };
  }>(["validate", "--strict", ...sourceArgs]);
  assert.equal(validated.ok, true);
  assert.equal(validated.summary.referencedSkills, 1);
  assert.equal(validated.summary.upstreamDeclarations, 0);
  assert.equal(validated.summary.contractsEvaluated, 1);
  assert.equal(validated.summary.contractsComplete, 1);
  assert.equal(validated.summary.findings, 0);

  const targets = runCli<{
    ok: boolean;
    targets: Array<{ id: string; kind: string; path: string }>;
  }>(["targets", "--source", source, "--agents-skills", targetRoot, "--json"]);
  assert.equal(targets.ok, true);
  assert.deepEqual(
    targets.targets
      .filter((target) => target.id === "agents")
      .map((target) => ({ id: target.id, kind: target.kind, path: target.path })),
    [{ id: "agents", kind: "agents-skills-root", path: targetRoot }]
  );

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

  const sourceBeforePack = await snapshotTree(source);
  const targetBeforePack = await snapshotTree(targetRoot);
  const dryPackArgs = [
    "pack",
    ...targetArgs,
    "--dry-run"
  ];
  const dryPack = runCli<{ ok: boolean; dryRun: boolean; summary: { skills: number } }>(dryPackArgs);
  const repeatedDryPack = runCli<typeof dryPack>(dryPackArgs);
  assert.deepEqual(repeatedDryPack, dryPack);
  assert.equal(dryPack.ok, true);
  assert.equal(dryPack.dryRun, true);
  assert.equal(dryPack.summary.skills, 1);
  assert.deepEqual(await snapshotTree(source), sourceBeforePack);
  assert.deepEqual(await snapshotTree(targetRoot), targetBeforePack);

  const packed = runCli<{
    ok: boolean;
    bundle: { artifactPath: string | null; manifestPath: string | null };
  }>(["pack", ...targetArgs, "--output", artifactRoot]);
  assert.equal(packed.ok, true);
  assert.ok(packed.bundle.artifactPath?.startsWith(`${artifactRoot}${path.sep}`));
  assert.equal(typeof packed.bundle.manifestPath, "string");
  assert.deepEqual(await snapshotTree(source), sourceBeforePack);
  assert.deepEqual(await snapshotTree(targetRoot), targetBeforePack);

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
  const walkthrough = await readFile(path.join(sampleCatalog, "README.md"), "utf8");

  assert.match(manifest, /path: \/path\/to\/disposable\/agent-skills/);
  assert.match(walkthrough, /SANDBOX=.*mktemp.*\|\| exit 1/);
  assert.match(walkthrough, /test -n "\$SANDBOX" \|\| exit 1/);
  assert.doesNotMatch(fixtureText, /\/Users\/|\/home\/[^/\s]+|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
  assert.doesNotMatch(fixtureText, /(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*\S+/i);
});
