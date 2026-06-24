import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  checkUpstream,
  fetchUpstreamSkillDryRun,
  importUpstreamSkill,
  type UpstreamFetcher
} from "../src/upstream.js";

test("upstream check reports declared skills without mutating targets", async (t) => {
  const { source, targetRoot } = await createCatalog(t);
  await writeUpstreamLock(source, "old-hash");

  const result = await checkUpstream(source);

  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.summary.declared, 1);
  assert.equal(result.declarations[0]?.skill, "hyperframes");
  assert.equal(result.declarations[0]?.provider, "skills-sh");
  assert.equal(result.declarations[0]?.importedPackageVersion, "1.0.0");
  assert.equal(result.declarations[0]?.importedAt, "2026-06-23T08:30:00.000Z");
  assert.equal(result.declarations[0]?.importedSource, "skills-sh:heygen-com/hyperframes:hyperframes");
  assert.deepEqual(result.declarations[0]?.lineage.upstream, {
    provider: "skills-sh",
    packageName: "skills",
    packageVersion: "1.0.0",
    repo: "heygen-com/hyperframes",
    skill: "hyperframes",
    group: "hyperframes"
  });
  assert.equal(result.declarations[0]?.lineage.imported?.hash, "old-hash");
  assert.equal(result.declarations[0]?.lineage.catalog.drift, "catalog-hash-drift");
  assert.equal(result.declarations[0]?.lineage.target, null);
  assert.equal(await readFile(path.join(targetRoot, "sentinel.txt"), "utf8"), "untouched\n");
});

test("upstream fetch dry-run compares fetched source without catalog or target writes", async (t) => {
  const { source, targetRoot } = await createCatalog(t);
  await writeUpstreamLock(source, null);
  const fetcher: UpstreamFetcher = async ({ workspace }) => ({
    ok: true,
    skillPath: await createFetchedSkill(t, workspace)
  });

  const result = await fetchUpstreamSkillDryRun(source, "hyperframes", { fetcher });

  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.summary, {
    create: 1,
    update: 1,
    delete: 1,
    unchanged: 1
  });
  assert.equal(await readFile(path.join(source, "skills", "hyperframes", "SKILL.md"), "utf8"), "# HyperFrames\nold\n");
  assert.equal(await readFile(path.join(targetRoot, "sentinel.txt"), "utf8"), "untouched\n");
});

test("upstream import applies only catalog diffs and updates metadata", async (t) => {
  const { source, targetRoot } = await createCatalog(t);
  await writeUpstreamLock(source, null);
  await commitCatalog(source);
  const fetcher: UpstreamFetcher = async ({ workspace }) => ({
    ok: true,
    skillPath: await createFetchedSkill(t, workspace)
  });

  const result = await importUpstreamSkill(source, "hyperframes", {
    fetcher,
    now: () => new Date("2026-06-23T08:30:00.000Z")
  });

  assert.equal(result.ok, true);
  assert.equal(result.readOnly, false);
  assert.equal(result.summary.filesWritten, 3);
  assert.equal(await readFile(path.join(source, "skills", "hyperframes", "SKILL.md"), "utf8"), "# HyperFrames\nnew\n");
  await assert.rejects(readFile(path.join(source, "skills", "hyperframes", "old-only.txt"), "utf8"), /ENOENT/);
  assert.equal(await readFile(path.join(source, "skills", "hyperframes", "new-only.txt"), "utf8"), "new\n");
  assert.equal(await readFile(path.join(targetRoot, "sentinel.txt"), "utf8"), "untouched\n");

  const lock = JSON.parse(await readFile(path.join(source, ".skill-suitcase", "upstream-lock.json"), "utf8")) as {
    skills: Record<string, { imported?: { sha256?: string; packageVersion?: string; at?: string; source?: string } }>;
  };
  assert.equal(lock.skills.hyperframes?.imported?.sha256, result.metadata.importedHash);
  assert.equal(lock.skills.hyperframes?.imported?.packageVersion, "1.0.0");
  assert.equal(lock.skills.hyperframes?.imported?.at, "2026-06-23T08:30:00.000Z");
  assert.equal(lock.skills.hyperframes?.imported?.source, "skills-sh:heygen-com/hyperframes:hyperframes");
});

test("upstream import refuses non-git catalog source before fetching", async (t) => {
  const { source, targetRoot } = await createCatalog(t);
  await writeUpstreamLock(source, null);
  let fetched = false;
  const fetcher: UpstreamFetcher = async ({ workspace }) => {
    fetched = true;
    return { ok: true, skillPath: await createFetchedSkill(t, workspace) };
  };

  const result = await importUpstreamSkill(source, "hyperframes", { fetcher });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "source_hygiene_requires_git");
  assert.equal(fetched, false);
  assert.equal(await readFile(path.join(targetRoot, "sentinel.txt"), "utf8"), "untouched\n");
});

test("upstream import refuses dirty catalog source before fetching", async (t) => {
  const { source, targetRoot } = await createCatalog(t);
  await writeUpstreamLock(source, null);
  await commitCatalog(source);
  await writeFile(path.join(source, "skills", "hyperframes", "local-edit.txt"), "dirty\n");
  let fetched = false;
  const fetcher: UpstreamFetcher = async () => {
    fetched = true;
    return { ok: true, skillPath: await createFetchedSkill(t, source) };
  };

  const result = await importUpstreamSkill(source, "hyperframes", { fetcher });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "dirty_catalog_source");
  assert.equal(fetched, false);
  assert.equal(await readFile(path.join(targetRoot, "sentinel.txt"), "utf8"), "untouched\n");
});

test("upstream import checks dirty catalog source through canonical git paths", async (t) => {
  const { source, targetRoot } = await createCatalog(t);
  await writeUpstreamLock(source, null);
  await commitCatalog(source);
  await writeFile(path.join(source, "skills", "hyperframes", "local-edit.txt"), "dirty\n");
  const aliasParent = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upstream-alias-"));
  t.after(() => rm(aliasParent, { recursive: true, force: true }));
  const alias = path.join(aliasParent, "catalog");
  await symlink(source, alias, "dir");
  let fetched = false;
  const fetcher: UpstreamFetcher = async () => {
    fetched = true;
    return { ok: true, skillPath: await createFetchedSkill(t, source) };
  };

  const result = await importUpstreamSkill(alias, "hyperframes", { fetcher });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "dirty_catalog_source");
  assert.equal(fetched, false);
  assert.equal(await readFile(path.join(targetRoot, "sentinel.txt"), "utf8"), "untouched\n");
});

test("upstream fetch refuses fetched paths outside the isolated sandbox", async (t) => {
  const { source, targetRoot } = await createCatalog(t);
  await writeUpstreamLock(source, null);
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upstream-outside-"));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  await writeFile(path.join(outsideRoot, "SKILL.md"), "# Outside\n");
  const fetcher: UpstreamFetcher = async () => ({ ok: true, skillPath: outsideRoot });

  const result = await fetchUpstreamSkillDryRun(source, "hyperframes", { fetcher });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "upstream_fetch_outside_sandbox");
  assert.equal(await readFile(path.join(source, "skills", "hyperframes", "SKILL.md"), "utf8"), "# HyperFrames\nold\n");
  assert.equal(await readFile(path.join(targetRoot, "sentinel.txt"), "utf8"), "untouched\n");
});

test("upstream fetch refuses fetched directories without SKILL.md", async (t) => {
  const { source, targetRoot } = await createCatalog(t);
  await writeUpstreamLock(source, null);
  const fetcher: UpstreamFetcher = async ({ workspace }) => {
    const emptyRoot = await mkdtemp(path.join(workspace, "skill-suitcase-upstream-empty-"));
    await writeFile(path.join(emptyRoot, "README.md"), "# Missing skill file\n");
    return { ok: true, skillPath: emptyRoot };
  };

  const result = await fetchUpstreamSkillDryRun(source, "hyperframes", { fetcher });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "upstream_fetch_missing_skill_file");
  assert.equal(await readFile(path.join(source, "skills", "hyperframes", "SKILL.md"), "utf8"), "# HyperFrames\nold\n");
  assert.equal(await readFile(path.join(targetRoot, "sentinel.txt"), "utf8"), "untouched\n");
});

test("upstream import refuses unpinned package versions", async (t) => {
  const { source, targetRoot } = await createCatalog(t);
  await writeUpstreamLock(source, null, "latest");
  await commitCatalog(source);
  let fetched = false;
  const fetcher: UpstreamFetcher = async ({ workspace }) => {
    fetched = true;
    return { ok: true, skillPath: await createFetchedSkill(t, workspace) };
  };

  const result = await importUpstreamSkill(source, "hyperframes", { fetcher });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "invalid_upstream_package_version");
  assert.equal(fetched, false);
  assert.equal(await readFile(path.join(targetRoot, "sentinel.txt"), "utf8"), "untouched\n");
});

async function createCatalog(t: TestContext): Promise<{ source: string; targetRoot: string }> {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upstream-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upstream-target-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  await mkdir(path.join(source, "skills", "hyperframes"), { recursive: true });
  await mkdir(path.join(source, ".skill-suitcase"), { recursive: true });
  await writeFile(path.join(source, "skills", "hyperframes", "SKILL.md"), "# HyperFrames\nold\n");
  await writeFile(path.join(source, "skills", "hyperframes", "same.txt"), "same\n");
  await writeFile(path.join(source, "skills", "hyperframes", "old-only.txt"), "old\n");
  await writeFile(path.join(targetRoot, "sentinel.txt"), "untouched\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - hyperframes

assignments:
  codex:
    suitcases:
      - core

assignmentPaths:
  codex:
    kind: codex-skills-root
    assignment: codex
    skillsPath: ${targetRoot}
`
  );
  return { source, targetRoot };
}

async function writeUpstreamLock(source: string, importedHash: string | null, packageVersion = "1.0.0"): Promise<void> {
  const declaration = {
    provider: "skills-sh",
    packageVersion,
    upstream: {
      repo: "heygen-com/hyperframes",
      skill: "hyperframes"
    },
    group: "hyperframes"
  };
  const imported = importedHash === null ? {} : {
    imported: {
      sha256: importedHash,
      packageVersion,
      at: "2026-06-23T08:30:00.000Z",
      source: "skills-sh:heygen-com/hyperframes:hyperframes"
    }
  };
  await writeFile(
    path.join(source, ".skill-suitcase", "upstream-lock.json"),
    `${JSON.stringify({
      schema: "calvinnwq.skills.upstream-lock.v0",
      skills: {
        hyperframes: {
          ...declaration,
          ...imported
        }
      }
    }, null, 2)}\n`
  );
}

async function createFetchedSkill(t: TestContext, parent: string): Promise<string> {
  const root = await mkdtemp(path.join(parent, "skill-suitcase-upstream-fetched-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "SKILL.md"), "# HyperFrames\nnew\n");
  await writeFile(path.join(root, "same.txt"), "same\n");
  await writeFile(path.join(root, "new-only.txt"), "new\n");
  return root;
}

async function commitCatalog(source: string): Promise<void> {
  await git(source, ["init"]);
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "seed"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Skill Suitcase Test",
      GIT_AUTHOR_EMAIL: "skill-suitcase@example.test",
      GIT_COMMITTER_NAME: "Skill Suitcase Test",
      GIT_COMMITTER_EMAIL: "skill-suitcase@example.test"
    }
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}
