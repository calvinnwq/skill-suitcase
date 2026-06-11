import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pack } from "../src/packer.js";

const fixtureSource = path.join(import.meta.dirname, "fixtures", "skills-catalog");

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
  assert.equal(
    result.bundle.artifactPath,
    path.join(output, ".skill-suitcase", "artifacts", result.bundle.artifactId)
  );
  assert.equal(result.bundle.manifestPath, path.join(result.bundle.artifactPath, "skill-suitcase-bundle.json"));

  const manifest = JSON.parse(await readFile(result.bundle.manifestPath, "utf8"));
  assert.equal(manifest.schema, "calvinnwq.skills.pack-bundle.v0");
  assert.equal(manifest.artifactId, result.bundle.artifactId);
  assert.equal(manifest.source.repo, fixtureSource);
  assert.ok(/^[a-f0-9]{40}$/.test(manifest.source.commit));
  assert.equal(manifest.source.commit, manifest.source.ref);
  assert.equal(manifest.source.manifestPath, path.join(fixtureSource, "skill-suitcase.yaml"));
  assert.ok(Array.isArray(manifest.files));
  assert.ok(manifest.files.length > 0);
  assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.equal(manifest.source.repo, result.source);

  await access(path.join(result.bundle.artifactPath, "skills", "office-hours", "SKILL.md"));
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

test("pack preserves prior artifacts when target differs", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-artifact-retention-"));
  t.after(() => rm(output, { recursive: true, force: true }));

  const codexArtifact = await pack({ source: fixtureSource, target: "codex", output });
  const openclawArtifact = await pack({ source: fixtureSource, target: "openclaw", output });
  const artifactRoot = path.join(output, ".skill-suitcase", "artifacts");

  const artifactDirs = await readdir(artifactRoot);
  assert.equal(artifactDirs.length, 2);
  assert.ok(artifactDirs.includes(codexArtifact.bundle.artifactId));
  assert.ok(artifactDirs.includes(openclawArtifact.bundle.artifactId));
  const openclawManifest = JSON.parse(await readFile(path.join(openclawArtifact.bundle.manifestPath), "utf8"));
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
  assert.equal(result.blocked[0].skill, "gnhf-postflight");
  assert.equal(result.summary.files, 0);
  assert.deepEqual(result.files, []);
});
