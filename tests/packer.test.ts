import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pack } from "../src/packer.js";

const fixtureSource = path.join(process.cwd(), "tests", "fixtures", "skills-catalog");

test("dry-run pack reports OpenClaw skill files without an output path", async () => {
  const result = await pack({ source: fixtureSource, target: "openclaw", dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.bundle.outputPath, null);
  assert.deepEqual(
    result.planned.map((item) => item.skill),
    ["office-hours", "skillify", "gnhf-postflight"]
  );
  assert.ok(result.files.length > 3);
  assert.ok(result.summary.bytes > 0);
  assert.ok(result.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(result.files.some((file) => file.bundlePath === "skills/office-hours/SKILL.md"));
});

test("dry-run pack follows target assignment scope", async () => {
  const result = await pack({ source: fixtureSource, target: "codex", dryRun: true });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.planned.map((item) => item.skill),
    ["office-hours"]
  );
  assert.ok(result.files.every((file) => file.skill === "office-hours"));
});

test("dry-run pack accepts assignment path target selectors", async () => {
  const result = await pack({ source: fixtureSource, target: "codex", dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.target, "codex");
  assert.deepEqual(
    result.planned.map((item) => item.skill),
    ["office-hours"]
  );
  assert.ok(result.files.every((file) => file.skill === "office-hours"));
});

test("pack refuses provider-modeled read-only targets before staging artifacts", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-provider-readonly-"));
  const output = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-provider-output-"));
  const reviewedRoot = path.join(source, "reviewed-opencode-skills");
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));

  await mkdir(path.join(source, "skills", "office-hours"), { recursive: true });
  await mkdir(reviewedRoot, { recursive: true });
  await writeFile(path.join(source, "skills", "office-hours", "SKILL.md"), "# Office Hours\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  opencode:
    suitcases:
      - core

assignmentPaths:
  reviewed-opencode:
    kind: opencode-skills-root
    assignment: opencode
    path: ${reviewedRoot}

compatibility:
  office-hours:
    agents:
      - opencode
`
  );

  const dryRun = await pack({ source, target: "opencode", dryRun: true });
  assert.equal(dryRun.ok, false);
  assert.equal(dryRun.summary.files, 0);
  assert.equal(dryRun.files.length, 0);
  assert.equal(dryRun.errors.some((error) => error.code === "read_only_target"), true);

  const staged = await pack({ source, target: "opencode", output });
  assert.equal(staged.ok, false);
  assert.equal(staged.bundle.artifactPath, null);
  assert.equal(staged.summary.files, 0);
  await assert.rejects(() => access(path.join(output, ".skill-suitcase")));
});

test("pack refuses ambiguous provider-modeled read-only target assignments", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-provider-ambiguous-"));
  const output = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-provider-ambiguous-output-"));
  const firstRoot = path.join(source, "reviewed-opencode-skills-a");
  const secondRoot = path.join(source, "reviewed-opencode-skills-b");
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));

  await mkdir(path.join(source, "skills", "office-hours"), { recursive: true });
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  await writeFile(path.join(source, "skills", "office-hours", "SKILL.md"), "# Office Hours\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  opencode:
    suitcases:
      - core

assignmentPaths:
  reviewed-opencode-a:
    kind: opencode-skills-root
    assignment: opencode
    path: ${firstRoot}
  reviewed-opencode-b:
    kind: opencode-skills-root
    assignment: opencode
    path: ${secondRoot}

compatibility:
  office-hours:
    agents:
      - opencode
`
  );

  const dryRun = await pack({ source, target: "opencode", dryRun: true });
  assert.equal(dryRun.ok, false);
  assert.equal(dryRun.summary.files, 0);
  assert.equal(dryRun.files.length, 0);
  assert.equal(dryRun.errors.some((error) => error.code === "read_only_target"), true);

  const staged = await pack({ source, target: "opencode", output });
  assert.equal(staged.ok, false);
  assert.equal(staged.bundle.artifactPath, null);
  assert.equal(staged.summary.files, 0);
  await assert.rejects(() => access(path.join(output, ".skill-suitcase")));
});

test("pack refuses non dry-run mode", async () => {
  await assert.rejects(
    () => pack({ source: fixtureSource, target: "openclaw", dryRun: false }),
    /requires --output/
  );
});

test("pack writes an explicit staging bundle under managed artifact storage", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-output-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const output = path.join(parent, "bundle");

  const result = await pack({
    source: fixtureSource,
    target: "codex",
    output
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.bundle.outputPath, output);

  if (result.bundle.artifactId === null) {
    throw new Error("pack with output should set an artifactId");
  }
  if (result.bundle.artifactPath === null) {
    throw new Error("pack with output should set an artifactPath");
  }
  if (result.bundle.manifestPath === null) {
    throw new Error("pack with output should set a manifestPath");
  }

  const { artifactId, artifactPath, manifestPath } = result.bundle;

  assert.equal(
    result.bundle.artifactPath,
    path.join(output, ".skill-suitcase", "artifacts", artifactId)
  );
  assert.equal(result.bundle.manifestPath, path.join(artifactPath, "skill-suitcase-bundle.json"));

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    schema: string;
    artifactId: string;
    source: {
      repo: string;
      commit: string;
      ref: string;
      manifestPath: string;
    };
    files: Array<{ skill: string; relativePath: string; sha256: string }>;
    fileHashes: Record<string, Record<string, string>>;
  };
  assert.equal(manifest.schema, "calvinnwq.skills.pack-bundle.v0");
  assert.equal(manifest.artifactId, result.bundle.artifactId);
  assert.equal(manifest.source.repo, fixtureSource);
  assert.ok(/^[a-f0-9]{40}$/.test(manifest.source.commit));
  assert.equal(manifest.source.commit, manifest.source.ref);
  assert.equal(manifest.source.manifestPath, path.join(fixtureSource, "skill-suitcase.yaml"));
  assert.ok(Array.isArray(manifest.files));
  assert.ok(manifest.files.length > 0);
  assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  const skillFile = manifest.files.find((file) => file.skill === "office-hours" && file.relativePath === "SKILL.md");
  assert.ok(skillFile);
  assert.equal(manifest.fileHashes["office-hours"]?.["SKILL.md"], skillFile.sha256);
  assert.equal(manifest.source.repo, result.source);

  await access(path.join(result.bundle.artifactPath, "skills", "office-hours", "SKILL.md"));
});

test("pack refuses selected source skills with untracked git files", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-untracked-"));
  t.after(() => rm(source, { recursive: true, force: true }));

  const skillRoot = path.join(source, "skills", "office-hours");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "# Office Hours\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core
`
  );
  git(source, "init");
  git(source, "add", "skill-suitcase.yaml", "skills/office-hours/SKILL.md");
  await writeFile(path.join(skillRoot, "new-migration.py"), "print('new')\n");

  const result = await pack({ source, target: "openclaw", dryRun: true });

  assert.equal(result.ok, false);
  assert.equal(result.summary.files, 0);
  assert.equal(result.files.length, 0);
  const hygieneError = result.errors.find((error) => error.code === "source_untracked_files");
  assert.ok(hygieneError);
  assert.equal(hygieneError.skill, "office-hours");
  assert.match(hygieneError.message, /new-migration\.py/);
});

test("pack ignores untracked files outside selected source skills", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-unselected-untracked-"));
  t.after(() => rm(source, { recursive: true, force: true }));

  await mkdir(path.join(source, "skills", "office-hours"), { recursive: true });
  await mkdir(path.join(source, "skills", "skillify"), { recursive: true });
  await writeFile(path.join(source, "skills", "office-hours", "SKILL.md"), "# Office Hours\n");
  await writeFile(path.join(source, "skills", "skillify", "SKILL.md"), "# Skillify\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

  unselected:
    skills:
      - skillify

assignments:
  codex:
    suitcases:
      - core
`
  );
  git(source, "init");
  git(source, "add", "skill-suitcase.yaml", "skills/office-hours/SKILL.md", "skills/skillify/SKILL.md");
  await writeFile(path.join(source, "skills", "skillify", "scratch.md"), "not selected\n");

  const result = await pack({ source, target: "codex", dryRun: true });

  assert.equal(result.ok, true);
  assert.deepEqual(result.planned.map((item) => item.skill), ["office-hours"]);
  assert.equal(result.errors.length, 0);
});

test("pack allows ignored untracked files in selected source skills", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-ignored-untracked-"));
  t.after(() => rm(source, { recursive: true, force: true }));

  const skillRoot = path.join(source, "skills", "office-hours");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "# Office Hours\n");
  await writeFile(path.join(source, ".gitignore"), "*.tmp\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core
`
  );
  git(source, "init");
  git(source, "add", ".gitignore", "skill-suitcase.yaml", "skills/office-hours/SKILL.md");
  await writeFile(path.join(skillRoot, "ignored.tmp"), "ignored by git\n");

  const result = await pack({ source, target: "openclaw", dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test("pack excludes manifest sourcePolicy paths without materializing them", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-source-policy-exclude-"));

  const skillRoot = path.join(source, "skills", "office-hours");
  const cacheRoot = path.join(skillRoot, ".cache");
  t.after(async () => {
    await chmod(cacheRoot, 0o700).catch(() => undefined);
    await rm(source, { recursive: true, force: true });
  });
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "# Office Hours\n");
  await writeFile(path.join(cacheRoot, "generated.json"), "{}\n");
  await chmod(cacheRoot, 0o000);
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

sourcePolicy:
  exclude:
    - "**/.cache/**"
`
  );
  git(source, "init");
  git(source, "add", "skill-suitcase.yaml", "skills/office-hours/SKILL.md");

  const result = await pack({ source, target: "openclaw", dryRun: true });

  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((file) => file.relativePath), ["SKILL.md"]);
});

test("pack refuses manifest-denied source paths", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-source-policy-deny-"));
  t.after(() => rm(source, { recursive: true, force: true }));

  const skillRoot = path.join(source, "skills", "office-hours");
  await mkdir(path.join(skillRoot, "secrets"), { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "# Office Hours\n");
  await writeFile(path.join(skillRoot, "secrets", "token.txt"), "secret\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

sourcePolicy:
  deny:
    - "**/secrets/**"
`
  );
  git(source, "init");
  git(source, "add", "skill-suitcase.yaml", "skills/office-hours/SKILL.md", "skills/office-hours/secrets/token.txt");

  const result = await pack({ source, target: "openclaw", dryRun: true });

  assert.equal(result.ok, false);
  assert.equal(result.summary.files, 1);
  const denied = result.errors.find((error) => error.code === "source_denied_path");
  assert.ok(denied);
  assert.equal(denied.skill, "office-hours");
  assert.match(denied.message, /secrets\/token\.txt/);
});

test("pack allows existing output directories and refuses artifact-id overwrite", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-existing-output-"));
  await mkdir(path.join(output, "seed"), { recursive: true });
  await writeFile(path.join(output, "seed", "note.txt"), "keep this file");
  t.after(() => rm(output, { recursive: true, force: true }));

  const first = await pack({ source: fixtureSource, target: "codex", output });
  assert.equal(first.ok, true);

  await assert.rejects(
    () => pack({ source: fixtureSource, target: "codex", output }),
    /existing artifact id/
  );
});

test("pack rejects an output path that is an existing file", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-output-file-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const output = path.join(parent, "bundle");
  await writeFile(output, "not a directory");

  await assert.rejects(
    () => pack({ source: fixtureSource, target: "codex", output }),
    /pack output path must be a directory/
  );
});

test("pack preserves prior artifacts when target differs", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-artifact-retention-"));
  t.after(() => rm(output, { recursive: true, force: true }));

  const codexArtifact = await pack({ source: fixtureSource, target: "codex", output });
  const openclawArtifact = await pack({ source: fixtureSource, target: "openclaw", output });
  const artifactRoot = path.join(output, ".skill-suitcase", "artifacts");

  const artifactDirs = await readdir(artifactRoot);
  assert.equal(artifactDirs.length, 2);

  if (codexArtifact.bundle.artifactId === null) {
    throw new Error("codex pack with output should set an artifactId");
  }
  if (openclawArtifact.bundle.artifactId === null) {
    throw new Error("openclaw pack with output should set an artifactId");
  }

  assert.ok(artifactDirs.includes(codexArtifact.bundle.artifactId));
  assert.ok(artifactDirs.includes(openclawArtifact.bundle.artifactId));

  assert.ok(openclawArtifact.bundle.manifestPath);
  const openclawManifestPath = openclawArtifact.bundle.manifestPath;
  const openclawManifest = JSON.parse(await readFile(openclawManifestPath, "utf8")) as {
    artifactId: string;
  };
  assert.equal(openclawManifest.artifactId, openclawArtifact.bundle.artifactId);
});

test("pack refuses manifest-declared install roots", async () => {
  await assert.rejects(
    () => pack({ source: fixtureSource, target: "codex", output: "/tmp/codex/skills/staged" }),
    /install target path/
  );
});

test("pack accepts either dry-run or output, not both", async () => {
  await assert.rejects(
    () =>
      pack({
        source: fixtureSource,
        target: "codex",
        dryRun: true,
        output: "/tmp/unused"
      }),
    /either --dry-run or --output/
  );
});

test("dry-run pack surfaces blocked plans without file enumeration", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-blocked-"));
  await mkdir(path.join(source, "skills", "gnhf-postflight"), { recursive: true });
  await writeFile(path.join(source, "skills", "gnhf-postflight", "SKILL.md"), "# GNHF\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  openclaw-builder:
    skills:
      - gnhf-postflight

assignments:
  codex:
    suitcases:
      - openclaw-builder

compatibility:
  gnhf-postflight:
    agents:
      - openclaw
    blockedAgents:
      codex: Codex must use the slimmer platform variant.
`
  );

  const result = await pack({ source, target: "codex", dryRun: true });

  assert.equal(result.ok, false);
  assert.ok(result.blocked[0], "blocked list should include first item");
  assert.equal(result.blocked[0].skill, "gnhf-postflight");
  assert.equal(result.summary.files, 0);
  assert.deepEqual(result.files, []);
});

test("dry-run pack enumerates files from a selected platform variant", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-pack-variant-"));
  const canonical = path.join(source, "skills", "gnhf-postflight");
  const codex = path.join(source, "variants", "codex", "gnhf-postflight");
  await mkdir(canonical, { recursive: true });
  await mkdir(codex, { recursive: true });
  await writeFile(path.join(canonical, "SKILL.md"), "# Canonical\n");
  await writeFile(path.join(codex, "SKILL.md"), "# Codex slim\n");
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  builder:
    skills:
      - gnhf-postflight

assignments:
  codex:
    suitcases:
      - builder

assignmentPaths:
  codex:
    kind: codex-home
    assignment: codex
    codexHome: ${path.join(source, "codex")}
    skillsPath: ${path.join(source, "codex", "skills")}

compatibility:
  gnhf-postflight:
    agents:
      - openclaw
    variant: canonical
    blockedAgents:
      codex: Codex must use the slimmer platform variant.

variants:
  gnhf-postflight:
    canonical:
      source: skills/gnhf-postflight
      agents:
        - openclaw
    codex:
      source: variants/codex/gnhf-postflight
      agents:
        - codex
`
  );

  const result = await pack({ source, target: "codex", dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.planned[0]?.variant, "codex");
  assert.equal(result.planned[0]?.sourcePath, codex);
  assert.equal(result.files[0]?.sourcePath, path.join(codex, "SKILL.md"));
  assert.equal(result.files[0]?.bundlePath, "skills/gnhf-postflight/SKILL.md");
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.status, 0, result.stderr);
}
