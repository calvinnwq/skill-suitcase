import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildPlanLock } from "../src/plan-lock.js";
import { apply } from "../src/apply.js";
import { buildInstalledFiles, upsertAndWriteReceipt } from "../src/receipt.js";

type DirEntry = {
  name: string;
};

function isDirEntry(value: unknown): value is DirEntry {
  return value !== null && typeof value === "object" && "name" in value && typeof (value as { name: unknown }).name === "string";
}

async function collectFilePaths(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (!isDirEntry(entry)) {
      continue;
    }

    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      continue;
    }

    const candidate = path.join(root, entry.name);
    if (entry.isDirectory?.() === true) {
      const nested = await collectFilePaths(candidate);
      for (const item of nested) {
        files.push(path.join(entry.name, item));
      }
      continue;
    }

    if (entry.isFile?.() === true) {
      files.push(entry.name);
    }
  }

  return files.sort();
}

async function hashDirectory(root: string): Promise<string> {
  const files = await collectFilePaths(root);
  const digest = createHash("sha256");

  for (const relativePath of files) {
    const filePath = path.join(root, relativePath);
    const bytes = await readFile(filePath);
    digest.update(relativePath);
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }

  return digest.digest("hex");
}

async function writeArtifactManifest(
  artifactRoot: string,
  {
    sourceRoot,
    target,
    plannedSkills,
    blockedSkills = []
  }: {
    sourceRoot: string;
    target: string;
    plannedSkills: string[];
    blockedSkills?: string[];
  }
): Promise<string> {
  await mkdir(artifactRoot, { recursive: true });
  const manifestPath = path.join(artifactRoot, "skill-suitcase-bundle.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      schema: "calvinnwq.skills.pack-bundle.v0",
      source: {
        repo: sourceRoot
      },
      target,
      planned: plannedSkills.map((skill) => ({ skill })),
      blocked: blockedSkills.map((skill) => ({ skill }))
    }, null, 2)}\n`
  );
  return manifestPath;
}

async function writeCatalog(
  sourceRoot: string,
  targetRoot: string,
  skills: string[] = ["office-hours"]
): Promise<void> {
  const skillRows = skills.map((skill) => `      - ${skill}`).join("\n");
  const manifestPath = path.join(sourceRoot, "skill-suitcase.yaml");
  await writeFile(
    manifestPath,
    `suitcases:\n  core:\n    skills:\n${skillRows}\n\nassignments:\n  openclaw:\n    suitcases:\n      - core\n\nassignmentPaths:\n  openclaw:\n    kind: openclaw-skills-root\n    assignment: openclaw\n    path: ${targetRoot}\n`
  );
}

test("apply requires exactly one approval input (lock or artifact)", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-missing-input-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"baseline\");\n");

  const result = await apply({ source: sourceRoot, target: "openclaw" });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length > 0, true);
  assert.equal(result.errors[0]?.code, "missing_apply_input");

  const bothPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-both-input-")), "plan-lock.json");
  t.after(() => rm(path.dirname(bothPath), { recursive: true, force: true }));
  await writeFile(
    bothPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const bothResult = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: bothPath,
    artifact: bothPath
  });

  assert.equal(bothResult.ok, false);
  assert.equal(bothResult.errors[0]?.code, "invalid_apply_input");
});

test("apply refuses artifact mode without a manifest", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-missing-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-missing-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-missing-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: artifactRoot
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "artifact");
  assert.equal(result.errors.some((error) => error.code === "invalid_artifact_manifest"), true);
  assert.equal(result.errors[0]?.code, "invalid_artifact_manifest");
});

test("apply rejects malformed lockfile input", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-malformed-lock-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-malformed-lock-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-malformed-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(lockPath, "not json");

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "lock");
  assert.equal(result.input, path.resolve(lockPath));
  assert.equal(result.errors.some((error) => error.code === "invalid_apply_input"), true);
  assert.equal(result.errors[0]?.code, "invalid_apply_input");
});

test("apply rejects malformed artifact manifest", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-malformed-artifact-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-malformed-artifact-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  const manifestPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-malformed-")), "skill-suitcase-bundle.json");
  t.after(() => rm(path.dirname(manifestPath), { recursive: true, force: true }));
  await writeFile(manifestPath, "not json");

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: manifestPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "artifact");
  assert.equal(result.input, path.resolve(manifestPath));
  assert.equal(result.errors.some((error) => error.code === "invalid_artifact_manifest"), true);
  assert.equal(result.errors[0]?.code, "invalid_artifact_manifest");
});

test("apply rejects artifact manifest with missing source metadata", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-missing-source-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-missing-source-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"missing source\");\n");

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-missing-source-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const artifactManifestPath = path.join(artifactRoot, "skill-suitcase-bundle.json");
  await writeFile(
    artifactManifestPath,
    `${JSON.stringify({
      schema: "calvinnwq.skills.pack-bundle.v0",
      target: "openclaw",
      planned: [{ skill: "office-hours" }]
    }, null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: artifactManifestPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "artifact");
  assert.equal(result.errors.some((error) => error.code === "invalid_artifact_manifest"), true);
  assert.equal(result.errors[0]?.code, "invalid_artifact_manifest");
  assert.equal(result.input, artifactManifestPath);
});

test("apply refuses artifact manifest with non-string source ref", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-source-ref-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-source-ref-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"invalid source ref\");\n");

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-source-ref-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const artifactManifestPath = path.join(artifactRoot, "skill-suitcase-bundle.json");
  await writeFile(
    artifactManifestPath,
    `${JSON.stringify({
      schema: "calvinnwq.skills.pack-bundle.v0",
      source: {
        repo: sourceRoot,
        ref: 1234
      },
      target: "openclaw",
      planned: [{ skill: "office-hours" }]
    }, null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: artifactManifestPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "artifact");
  assert.equal(result.input, artifactManifestPath);
  assert.equal(result.errors.some((error) => error.code === "invalid_artifact_manifest"), true);
  assert.equal(result.errors[0]?.code, "invalid_artifact_manifest");
});

test("apply refuses artifact manifest with non-string source commit", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-source-commit-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-source-commit-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"invalid source commit\");\n");

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-source-commit-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const artifactManifestPath = path.join(artifactRoot, "skill-suitcase-bundle.json");
  await writeFile(
    artifactManifestPath,
    `${JSON.stringify({
      schema: "calvinnwq.skills.pack-bundle.v0",
      source: {
        repo: sourceRoot,
        commit: true
      },
      target: "openclaw",
      planned: [{ skill: "office-hours" }]
    }, null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: artifactManifestPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "artifact");
  assert.equal(result.input, artifactManifestPath);
  assert.equal(result.errors.some((error) => error.code === "invalid_artifact_manifest"), true);
  assert.equal(result.errors[0]?.code, "invalid_artifact_manifest");
});

test("apply refuses artifact manifest with unsupported schema", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-schema-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-schema-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"schema\");\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"current\");\n");

  const sourceHash = await hashDirectory(sourceSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash,
      installedFiles: []
    }
  });

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-schema-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const artifactManifestPath = path.join(artifactRoot, "skill-suitcase-bundle.json");
  await writeFile(
    artifactManifestPath,
    `${JSON.stringify({
      schema: "com.example.bad-schema",
      source: {
        repo: sourceRoot
      },
      target: "openclaw",
      planned: [{ skill: "office-hours" }]
    }, null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: artifactManifestPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "artifact");
  assert.equal(result.input, artifactManifestPath);
  assert.equal(result.errors.some((error) => error.code === "invalid_artifact_manifest"), true);
  assert.equal(result.errors[0]?.code, "invalid_artifact_manifest");
});

test("apply refuses artifact manifest with no planned skills", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-empty-plan-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-empty-plan-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"no planned skills\");\n");

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-empty-plan-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const manifestPath = await writeArtifactManifest(artifactRoot, {
    sourceRoot,
    target: "openclaw",
    plannedSkills: []
  });

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: manifestPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "artifact");
  assert.equal(result.input, manifestPath);
  assert.equal(result.errors.some((error) => error.code === "artifact_missing_planned"), true);
  assert.equal(result.errors[0]?.code, "artifact_missing_planned");
});

test("apply refuses artifact with blocked plan entries", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-blocked-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-blocked-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"blocked\");\n");

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-blocked-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const manifestPath = await writeArtifactManifest(artifactRoot, {
    sourceRoot,
    target: "openclaw",
    plannedSkills: ["office-hours"],
    blockedSkills: ["office-hours"]
  });

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: manifestPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "artifact");
  assert.equal(result.errors.some((error) => error.code === "artifact_blocked"), true);
  assert.equal(result.errors[0]?.code, "artifact_blocked");
});

test("apply refuses artifact installs when selected source has untracked files", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-untracked-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-untracked-target-"));
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-untracked-artifact-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"baseline\");\n");
  git(sourceRoot, "init");
  git(sourceRoot, "add", "skill-suitcase.yaml", "skills/office-hours/SKILL.md", "skills/office-hours/runtime.js");
  await writeFile(path.join(sourceSkill, "untracked.js"), "console.log('not approved');\n");

  const manifestPath = await writeArtifactManifest(artifactRoot, {
    sourceRoot,
    target: "openclaw",
    plannedSkills: ["office-hours"]
  });

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: manifestPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "source_untracked_files");
  assert.match(result.errors[0]?.message ?? "", /untracked\.js/);
  await assert.rejects(() => lstat(path.join(targetRoot, "office-hours", "untracked.js")));
});

test("apply refuses lock installs when selected source becomes untracked after lock creation", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-untracked-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-untracked-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"baseline\");\n");
  git(sourceRoot, "init");
  git(sourceRoot, "add", "skill-suitcase.yaml", "skills/office-hours/SKILL.md", "skills/office-hours/runtime.js");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-untracked-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );
  await writeFile(path.join(sourceSkill, "untracked.js"), "console.log('not approved');\n");

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "plan_lock_current_plan_unavailable");
  assert.match(result.errors[0]?.message ?? "", /current_plan_unavailable/);
  await assert.rejects(() => lstat(path.join(targetRoot, "office-hours", "untracked.js")));
});

test("apply reports blocked canonical variants before mutating Codex targets", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-codex-blocked-src-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-codex-blocked-home-"));
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-codex-blocked-artifact-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));

  const skillsPath = path.join(codexHome, "skills");
  const sourceSkill = path.join(sourceRoot, "skills", "gnhf-postflight");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "# Canonical OpenClaw bundle\n");
  await mkdir(path.join(skillsPath, "gnhf-postflight"), { recursive: true });
  await writeFile(path.join(skillsPath, "gnhf-postflight", "SKILL.md"), "# Slim Codex variant\n");
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
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
    codexHome: ${codexHome}
    skillsPath: ${skillsPath}

compatibility:
  gnhf-postflight:
    agents:
      - openclaw
    variant: canonical
    blockedAgents:
      codex: Codex must use the slimmer platform variant.
`
  );
  const manifestPath = await writeArtifactManifest(artifactRoot, {
    sourceRoot,
    target: "codex",
    plannedSkills: ["gnhf-postflight"]
  });

  const result = await apply({
    source: sourceRoot,
    target: "codex",
    artifact: manifestPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "diff_blocked_skill"), true);
  assert.equal(
    await readFile(path.join(skillsPath, "gnhf-postflight", "SKILL.md"), "utf8"),
    "# Slim Codex variant\n"
  );
});

test("apply writes selected platform variants into receipts", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-codex-variant-src-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-codex-variant-home-"));
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-codex-variant-artifact-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));

  const skillsPath = path.join(codexHome, "skills");
  const sourceSkill = path.join(sourceRoot, "variants", "codex", "gnhf-postflight");
  const targetSkill = path.join(skillsPath, "gnhf-postflight");
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.12-codex\n---\nold\n");
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nversion: 2026.06.12-codex\n---\nold\n");
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
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
    codexHome: ${codexHome}
    skillsPath: ${skillsPath}

compatibility:
  gnhf-postflight:
    agents:
      - openclaw
    variant: canonical
    blockedAgents:
      codex: Codex must use the slimmer platform variant.

variants:
  gnhf-postflight:
    codex:
      source: variants/codex/gnhf-postflight
      agents:
        - codex
`
  );
  await upsertAndWriteReceipt({
    installRoot: skillsPath,
    skillName: "gnhf-postflight",
    installRecord: {
      skill: "gnhf-postflight",
      agent: "codex",
      target: "codex",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.12-codex",
      variant: "codex",
      sourceHash: await hashDirectory(sourceSkill),
      installedFiles: []
    }
  });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.13-codex\n---\nnew\n");
  const manifestPath = await writeArtifactManifest(artifactRoot, {
    sourceRoot,
    target: "codex",
    plannedSkills: ["gnhf-postflight"]
  });

  const result = await apply({
    source: sourceRoot,
    target: "codex",
    artifact: manifestPath
  });

  assert.equal(result.ok, true);
  assert.equal(await readFile(path.join(targetSkill, "SKILL.md"), "utf8"), "---\nversion: 2026.06.13-codex\n---\nnew\n");

  const receipt = JSON.parse(await readFile(path.join(skillsPath, ".skill-suitcase-receipt.json"), "utf8")) as {
    installs?: Record<string, { variant?: string; sourcePath?: string } | Array<{ variant?: string; sourcePath?: string }>>;
  };
  const install = receipt.installs?.["gnhf-postflight"];
  const record = Array.isArray(install) ? install[0] : install;
  assert.equal(record?.variant, "codex");
  assert.equal(record?.sourcePath, sourceSkill);
});

test("apply refuses artifact with mismatched source", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-source-mismatch-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-source-mismatch-target-"));
  const mismatchSourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-source-mismatch-alt-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  t.after(() => rm(mismatchSourceRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"mismatch\");\n");

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-source-mismatch-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const manifestPath = await writeArtifactManifest(artifactRoot, {
    sourceRoot: mismatchSourceRoot,
    target: "openclaw",
    plannedSkills: ["office-hours"]
  });

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: manifestPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "artifact");
  assert.equal(result.input, manifestPath);
  assert.equal(result.errors.some((error) => error.code === "artifact_source_mismatch"), true);
  assert.equal(result.errors[0]?.code, "artifact_source_mismatch");
});

test("apply refuses artifact with mismatched target", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-target-mismatch-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-target-mismatch-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"mismatch target\");\n");

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-target-mismatch-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const manifestPath = await writeArtifactManifest(artifactRoot, {
    sourceRoot,
    target: "other-agent",
    plannedSkills: ["office-hours"]
  });

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: manifestPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "artifact");
  assert.equal(result.input, manifestPath);
  assert.equal(result.errors.some((error) => error.code === "artifact_target_mismatch"), true);
  assert.equal(result.errors[0]?.code, "artifact_target_mismatch");
});

test("apply rejects a lock file with mismatched target", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-target-mismatch-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-target-mismatch-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"target-mismatch\");\n");

  const lockPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-mismatch-")),
    "plan-lock.json"
  );
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  const lock = await buildPlanLock({
    source: sourceRoot,
    target: "openclaw",
    assignmentPath: "openclaw",
    sourceCommit: "deadbeef"
  });
  lock.target = "other-agent";
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "lock");
  assert.equal(result.errors.some((error) => error.code === "plan_lock_target_mismatch"), true);
  assert.equal(result.errors[0]?.code, "plan_lock_target_mismatch");
});

test("apply rejects missing lock file path", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-missing-lock-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-missing-lock-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"missing lock\");\n");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-missing-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "lock");
  assert.equal(result.errors.some((error) => error.code === "invalid_apply_input"), true);
  assert.equal(result.errors[0]?.code, "invalid_apply_input");
});

test("apply rejects a lock file with mismatched source", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-source-mismatch-src-"));
  const mismatchSourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-source-mismatch-alt-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-source-mismatch-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(mismatchSourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"source mismatch\");\n");

  const lockPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-source-mismatch-")),
    "plan-lock.json"
  );
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  const lock = await buildPlanLock({
    source: sourceRoot,
    target: "openclaw",
    assignmentPath: "openclaw",
    sourceCommit: "deadbeef"
  });
  lock.source.repo = mismatchSourceRoot;
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "lock");
  assert.equal(result.errors.some((error) => error.code === "plan_lock_source_mismatch"), true);
  assert.equal(result.errors[0]?.code, "plan_lock_source_mismatch");
});

test("apply refuses dirty target state by default", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"clean\");\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await cp(sourceSkill, targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"dirty\");\n");

  const currentHash = await hashDirectory(sourceSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: currentHash
    }
  });

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_state"), true);
});

test("apply does not mutate a dirty target on refusal", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-immutable-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-immutable-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"clean\");\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"dirty\");\n");
  await writeFile(path.join(targetSkill, "notes.md"), "keep me\n");
  const beforeRuntime = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  const beforeNotes = await readFile(path.join(targetSkill, "notes.md"), "utf8");
  const sourceHash = await hashDirectory(sourceSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash,
      installedFiles: []
    }
  });
  const beforeReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-immutable-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_state"), true);
  assert.equal(result.postApplyStatus, null);

  const afterRuntime = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  const afterNotes = await readFile(path.join(targetSkill, "notes.md"), "utf8");
  assert.equal(afterRuntime, beforeRuntime);
  assert.equal(afterNotes, beforeNotes);

  const afterReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");
  assert.equal(afterReceipt, beforeReceipt ?? null);
});

test("apply updates a dirty target when the receipt is behind the approved catalog diff", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"old catalog\");\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await cp(sourceSkill, targetSkill, { recursive: true });
  const oldHash = await hashDirectory(sourceSkill);
  const installedFiles = await buildInstalledFiles(targetSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: oldHash,
      installedFiles
    }
  });

  await writeFile(path.join(sourceSkill, "guide.md"), "source and target match, but receipt is stale\n");
  await writeFile(path.join(targetSkill, "guide.md"), "source and target match, but receipt is stale\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"new catalog\");\n");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, true);
  assert.equal(result.preApplyStatus.summary.dirty, 1);
  assert.equal(result.applied.skills.includes("office-hours"), true);
  assert.equal(result.postApplyStatus?.summary.current, 1);
  assert.equal(result.postApplyStatus?.summary.dirty, 0);
  assert.equal(await readFile(path.join(targetSkill, "runtime.js"), "utf8"), "console.log(\"new catalog\");\n");

  const receiptText = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");
  const receipt = JSON.parse(receiptText) as {
    installs?: Record<string, { priorState?: { status?: string }; rollback?: { files?: Array<{ previous?: { kind?: string; bytes?: string } }> } }>;
  };
  const record = receipt.installs?.["office-hours"];
  assert.equal(record?.priorState?.status, "dirty");
  assert.equal(record?.rollback?.files?.[0]?.previous?.kind, "file");
});

test("apply refuses dirty-behind symlink installs before writing copy entries", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-symlink-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-symlink-target-"));
  const staleRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-symlink-stale-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  t.after(() => rm(staleRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"old catalog\");\n");

  const staleSkill = path.join(staleRoot, "office-hours");
  await mkdir(staleSkill, { recursive: true });
  await cp(sourceSkill, staleSkill, { recursive: true });
  const oldHash = await hashDirectory(sourceSkill);
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"new catalog\");\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await symlink(staleSkill, targetSkill, "dir");
  const beforeStaleRuntime = await readFile(path.join(staleSkill, "runtime.js"), "utf8");
  const beforeLinkTarget = await readlink(targetSkill);

  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "symlink",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: oldHash,
      installedFiles: []
    }
  });
  const beforeReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-symlink-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_state"), true);
  assert.equal(result.postApplyStatus, null);
  assert.equal(await readFile(path.join(staleSkill, "runtime.js"), "utf8"), beforeStaleRuntime);
  assert.equal((await lstat(targetSkill)).isSymbolicLink(), true);
  assert.equal(await readlink(targetSkill), beforeLinkTarget);
  assert.equal(await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8"), beforeReceipt);
});

test("apply refuses dirty-behind copy receipts when the target path is now a symlink", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-copy-symlink-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-copy-symlink-target-"));
  const staleRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-copy-symlink-stale-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  t.after(() => rm(staleRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"old catalog\");\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await cp(sourceSkill, targetSkill, { recursive: true });
  const oldHash = await hashDirectory(sourceSkill);
  const installedFiles = await buildInstalledFiles(targetSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: oldHash,
      installedFiles
    }
  });

  const staleSkill = path.join(staleRoot, "office-hours");
  await mkdir(staleSkill, { recursive: true });
  await writeFile(path.join(staleSkill, "runtime.js"), "console.log(\"stale external target\");\n");
  await rm(targetSkill, { recursive: true, force: true });
  await symlink(staleSkill, targetSkill, "dir");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"new catalog\");\n");
  const beforeStaleRuntime = await readFile(path.join(staleSkill, "runtime.js"), "utf8");
  const beforeReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-copy-symlink-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_state"), true);
  assert.equal(result.postApplyStatus, null);
  assert.equal(await readFile(path.join(staleSkill, "runtime.js"), "utf8"), beforeStaleRuntime);
  assert.equal((await lstat(targetSkill)).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8"), beforeReceipt);
});

test("apply refuses dirty-behind updates that would preserve unrelated target extras", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-extra-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-extra-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"old catalog\");\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await cp(sourceSkill, targetSkill, { recursive: true });
  const oldHash = await hashDirectory(sourceSkill);
  const installedFiles = await buildInstalledFiles(targetSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: oldHash,
      installedFiles
    }
  });

  await writeFile(path.join(targetSkill, "notes.md"), "unrelated local edit\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"new catalog\");\n");
  const beforeRuntime = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  const beforeNotes = await readFile(path.join(targetSkill, "notes.md"), "utf8");
  const beforeReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-extra-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_state"), true);
  assert.equal(result.postApplyStatus, null);
  assert.equal(await readFile(path.join(targetSkill, "runtime.js"), "utf8"), beforeRuntime);
  assert.equal(await readFile(path.join(targetSkill, "notes.md"), "utf8"), beforeNotes);
  assert.equal(await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8"), beforeReceipt);
});

test("apply refuses dirty-behind updates that would overwrite tracked local edits", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-tracked-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-tracked-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"old catalog\");\n");
  await writeFile(path.join(sourceSkill, "notes.md"), "catalog notes\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await cp(sourceSkill, targetSkill, { recursive: true });
  const oldHash = await hashDirectory(sourceSkill);
  const installedFiles = await buildInstalledFiles(targetSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: oldHash,
      installedFiles
    }
  });

  await writeFile(path.join(targetSkill, "notes.md"), "local target edit\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"new catalog\");\n");
  const beforeRuntime = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  const beforeNotes = await readFile(path.join(targetSkill, "notes.md"), "utf8");
  const beforeReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-behind-tracked-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_state"), true);
  assert.equal(result.postApplyStatus, null);
  assert.equal(await readFile(path.join(targetSkill, "runtime.js"), "utf8"), beforeRuntime);
  assert.equal(await readFile(path.join(targetSkill, "notes.md"), "utf8"), beforeNotes);
  assert.equal(await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8"), beforeReceipt);
});

test("apply refuses unknown target state by default", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-unknown-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-unknown-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"current\");\n");

  const sourceHash = await hashDirectory(sourceSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash,
      installedFiles: []
    }
  });

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-unknown-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_state"), true);
  assert.equal(result.preApplyStatus.summary.unknown, 1);
});

test("apply refuses pre-apply status errors before mutating target", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-precheck-error-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-precheck-error-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"target out of date\");\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"target current\");\n");

  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: await hashDirectory(sourceSkill),
      installedFiles: []
    }
  });

  const malformedReceiptPath = path.join(targetRoot, ".skill-suitcase-receipt.json");
  await writeFile(malformedReceiptPath, "{invalid-json");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-precheck-error-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const beforeRuntime = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  const beforeReceipt = await readFile(malformedReceiptPath, "utf8");

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "lock");
  assert.equal(result.postApplyStatus, null);
  assert.equal(result.errors.some((error) => error.code === "status_invalid_receipt"), true);
  assert.equal(result.preApplyStatus.summary.unknown, 1);

  const afterRuntime = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  const afterReceipt = await readFile(malformedReceiptPath, "utf8");
  assert.equal(afterRuntime, beforeRuntime);
  assert.equal(afterReceipt, beforeReceipt);
});

test("apply refuses all writes when a multi-skill plan has an unknown status", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-multi-unknown-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-multi-unknown-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot, ["office-hours", "time-tracker"]);

  const sourceOffice = path.join(sourceRoot, "skills", "office-hours");
  const sourceTracker = path.join(sourceRoot, "skills", "time-tracker");
  const targetOffice = path.join(targetRoot, "office-hours");
  const targetTracker = path.join(targetRoot, "time-tracker");

  await mkdir(sourceOffice, { recursive: true });
  await mkdir(sourceTracker, { recursive: true });
  await mkdir(targetOffice, { recursive: true });
  await mkdir(targetTracker, { recursive: true });

  await writeFile(path.join(sourceOffice, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceOffice, "runtime.js"), "console.log(\"office old\");\n");
  await writeFile(path.join(sourceTracker, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceTracker, "runtime.js"), "console.log(\"tracker old\");\n");

  await writeFile(path.join(targetOffice, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetOffice, "runtime.js"), "console.log(\"office old\");\n");
  await writeFile(path.join(targetTracker, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetTracker, "runtime.js"), "console.log(\"tracker old\");\n");

  const officeHash = await hashDirectory(sourceOffice);
  const trackerHash = await hashDirectory(sourceTracker);

  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceOffice
      },
      sourcePath: sourceOffice,
      targetPath: targetOffice,
      version: "2026.06.11",
      sourceHash: officeHash,
      installedFiles: []
    }
  });

  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "time-tracker",
    installRecord: {
      skill: "time-tracker",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceTracker
      },
      sourcePath: sourceTracker,
      targetPath: targetTracker,
      version: "2026.06.11",
      sourceHash: trackerHash,
      installedFiles: []
    }
  });

  const beforeOfficeRuntime = await readFile(path.join(targetOffice, "runtime.js"), "utf8");
  const beforeTrackerRuntime = await readFile(path.join(targetTracker, "runtime.js"), "utf8");
  const beforeReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");

  await rm(path.join(sourceTracker, "SKILL.md"));
  await writeFile(path.join(sourceOffice, "runtime.js"), "console.log(\"office new\");\n");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-multi-unknown-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_state"), true);
  assert.equal(result.postApplyStatus, null);
  assert.equal(result.preApplyStatus.summary.unknown, 1);

  const afterOfficeRuntime = await readFile(path.join(targetOffice, "runtime.js"), "utf8");
  const afterTrackerRuntime = await readFile(path.join(targetTracker, "runtime.js"), "utf8");
  assert.equal(afterOfficeRuntime, beforeOfficeRuntime);
  assert.equal(afterTrackerRuntime, beforeTrackerRuntime);

  const afterReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");
  assert.equal(afterReceipt, beforeReceipt);
});

test("apply refuses dirty target state by default in artifact mode", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-artifact-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-artifact-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"clean\");\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await cp(sourceSkill, targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"dirty\");\n");
  await writeFile(path.join(targetSkill, "notes.md"), "keep me\n");
  const beforeRuntime = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  const beforeNotes = await readFile(path.join(targetSkill, "notes.md"), "utf8");

  const sourceHash = await hashDirectory(sourceSkill);
  const receiptPath = path.join(targetRoot, ".skill-suitcase-receipt.json");
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash,
      installedFiles: []
    }
  });
  const beforeReceipt = await readFile(receiptPath, "utf8");

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-dirty-artifact-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const manifestPath = await writeArtifactManifest(artifactRoot, {
    sourceRoot,
    target: "openclaw",
    plannedSkills: ["office-hours"]
  });

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: manifestPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "artifact");
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_state"), true);
  assert.equal(result.postApplyStatus, null);

  const afterRuntime = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  const afterNotes = await readFile(path.join(targetSkill, "notes.md"), "utf8");
  assert.equal(afterRuntime, beforeRuntime);
  assert.equal(afterNotes, beforeNotes);

  const afterReceipt = await readFile(receiptPath, "utf8");
  assert.equal(afterReceipt, beforeReceipt);
});

test("apply refuses unmanaged target path by default", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-unmanaged-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-unmanaged-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  const manifest = await readFile(path.join(sourceRoot, "skill-suitcase.yaml"), "utf8");
  const lines = manifest.split("\n");
  const assignmentPathsIndex = lines.findIndex((line) => line.startsWith("assignmentPaths:"));
  await rm(path.join(sourceRoot, "skill-suitcase.yaml"), { force: true });
  const filteredManifest = lines
    .slice(0, assignmentPathsIndex)
    .concat("assignmentPaths: {}\n")
    .join("\n");
  await writeFile(path.join(sourceRoot, "skill-suitcase.yaml"), filteredManifest);

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-unmanaged-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "diff_missing_install_root"), true);
  assert.equal(result.preApplyStatus.statuses.length, 0);
});

test("apply refuses unmanaged target path by default in artifact mode", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-unmanaged-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-unmanaged-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  const manifest = await readFile(path.join(sourceRoot, "skill-suitcase.yaml"), "utf8");
  const lines = manifest.split("\n");
  const assignmentPathsIndex = lines.findIndex((line) => line.startsWith("assignmentPaths:"));
  await rm(path.join(sourceRoot, "skill-suitcase.yaml"), { force: true });
  const filteredManifest = lines
    .slice(0, assignmentPathsIndex)
    .concat("assignmentPaths: {}\n")
    .join("\n");
  await writeFile(path.join(sourceRoot, "skill-suitcase.yaml"), filteredManifest);

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-unmanaged-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const artifactManifestPath = await writeArtifactManifest(artifactRoot, {
    sourceRoot,
    target: "openclaw",
    plannedSkills: ["office-hours"]
  });

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: artifactManifestPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "artifact");
  assert.equal(result.errors.some((error) => error.code === "diff_missing_install_root"), true);
  assert.equal(result.preApplyStatus.statuses.length, 0);
  assert.equal(result.postApplyStatus, null);
});

test("apply refuses pre-apply status errors in artifact mode", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-precheck-error-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-precheck-error-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"artifact precheck\");\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"artifact current\");\n");
  await writeFile(path.join(targetSkill, "notes.md"), "keep me\n");

  const sourceHash = await hashDirectory(sourceSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash,
      installedFiles: []
    }
  });

  const malformedReceiptPath = path.join(targetRoot, ".skill-suitcase-receipt.json");
  await writeFile(malformedReceiptPath, "{invalid-json");

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-precheck-error-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const artifactManifestPath = await writeArtifactManifest(artifactRoot, {
    sourceRoot,
    target: "openclaw",
    plannedSkills: ["office-hours"]
  });

  const beforeRuntime = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  const beforeNotes = await readFile(path.join(targetSkill, "notes.md"), "utf8");
  const beforeReceipt = await readFile(malformedReceiptPath, "utf8");

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: artifactRoot
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "artifact");
  assert.equal(result.input, artifactManifestPath);
  assert.equal(result.postApplyStatus, null);
  assert.equal(result.errors.some((error) => error.code === "status_invalid_receipt"), true);
  assert.equal(result.preApplyStatus.summary.unknown, 1);

  const afterRuntime = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  const afterNotes = await readFile(path.join(targetSkill, "notes.md"), "utf8");
  assert.equal(afterRuntime, beforeRuntime);
  assert.equal(afterNotes, beforeNotes);

  const afterReceipt = await readFile(malformedReceiptPath, "utf8");
  assert.equal(afterReceipt, beforeReceipt);
});

test("apply refuses all writes when a multi-skill plan has any dirty status", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-multi-dirty-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-multi-dirty-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot, ["office-hours", "time-tracker"]);

  const sourceOffice = path.join(sourceRoot, "skills", "office-hours");
  const sourceTracker = path.join(sourceRoot, "skills", "time-tracker");
  const targetOffice = path.join(targetRoot, "office-hours");
  const targetTracker = path.join(targetRoot, "time-tracker");

  await mkdir(sourceOffice, { recursive: true });
  await mkdir(sourceTracker, { recursive: true });
  await mkdir(targetOffice, { recursive: true });
  await mkdir(targetTracker, { recursive: true });

  await writeFile(path.join(sourceOffice, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceOffice, "runtime.js"), "console.log(\"office old\");\n");
  await writeFile(path.join(sourceTracker, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceTracker, "runtime.js"), "console.log(\"tracker old\");\n");

  await writeFile(path.join(targetOffice, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetOffice, "runtime.js"), "console.log(\"office old\");\n");
  await writeFile(path.join(targetTracker, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetTracker, "runtime.js"), "console.log(\"tracker old\");\n");

  const officeHash = await hashDirectory(sourceOffice);
  const trackerHash = await hashDirectory(sourceTracker);

  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceOffice
      },
      sourcePath: sourceOffice,
      targetPath: targetOffice,
      version: "2026.06.11",
      sourceHash: officeHash,
      installedFiles: []
    }
  });
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "time-tracker",
    installRecord: {
      skill: "time-tracker",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceTracker
      },
      sourcePath: sourceTracker,
      targetPath: targetTracker,
      version: "2026.06.11",
      sourceHash: trackerHash,
      installedFiles: []
    }
  });

  await writeFile(path.join(sourceTracker, "runtime.js"), "console.log(\"tracker new\");\n");
  await writeFile(path.join(targetOffice, "runtime.js"), "console.log(\"office dirty\");\n");

  const beforeReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-multi-dirty-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsafe_target_state"), true);
  assert.equal(result.postApplyStatus, null);

  const officeAfter = await readFile(path.join(targetOffice, "runtime.js"), "utf8");
  const trackerAfter = await readFile(path.join(targetTracker, "runtime.js"), "utf8");
  assert.equal(officeAfter, "console.log(\"office dirty\");\n");
  assert.equal(trackerAfter, "console.log(\"tracker old\");\n");

  const afterReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");
  assert.equal(afterReceipt, beforeReceipt);
});

test("apply writes files, emits receipt, and preserves extras", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-success-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-success-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");
  await writeFile(path.join(sourceSkill, "guide.md"), "keep me\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"current\");\n");
  await writeFile(path.join(targetSkill, "guide.md"), "keep me\n");

  const oldHash = await hashDirectory(sourceSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: oldHash,
      installedFiles: []
    }
  });

  await rm(path.join(sourceSkill, "guide.md"));
  await writeFile(path.join(sourceSkill, "notes.md"), "apply me\n");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-lock-success-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied.files > 0, true);
  assert.equal(result.postApplyStatus !== null, true);
  assert.equal(result.postApplyStatus?.ok, true);
  assert.equal(result.preApplyStatus.summary.behind, 1);

  const officeStatus = result.postApplyStatus?.statuses.find((item) => item.skill === "office-hours");
  assert.equal(officeStatus?.status, "current");
  assert.equal(result.postApplyStatus?.summary.dirty, 0);

  const createdNotes = await readFile(path.join(targetSkill, "notes.md"), "utf8");
  assert.equal(createdNotes, "apply me\n");

  const preservedGuide = await readFile(path.join(targetSkill, "guide.md"), "utf8");
  assert.equal(preservedGuide, "keep me\n");

  const receiptText = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");
  const receipt = JSON.parse(receiptText) as {
    schema: string;
    installs?: Record<string, { sourceHash?: string; targetPath?: string } | Array<Record<string, unknown>>>
  };

  const entry = receipt.installs?.["office-hours"];
  assert.ok(entry);

  const receivedRecord = Array.isArray(entry) ? entry[0] : entry;
  assert.ok(receivedRecord !== undefined);
  if (receivedRecord === undefined) {
    return;
  }

  assert.ok(receivedRecord.targetPath !== undefined);
  assert.equal(typeof receivedRecord.sourceHash, "string");
  const newSourceHash = await hashDirectory(sourceSkill);
  assert.equal(receivedRecord.sourceHash, newSourceHash);

  const finalInstalledFiles = await readdir(targetSkill);
  assert.ok(finalInstalledFiles.includes("guide.md"));
});

test("apply can be re-run after preserving an extra without a dirty deadlock", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-reapply-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-reapply-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");
  await writeFile(path.join(sourceSkill, "guide.md"), "keep me\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"current\");\n");
  await writeFile(path.join(targetSkill, "guide.md"), "keep me\n");

  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: { path: sourceSkill },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: await hashDirectory(sourceSkill),
      installedFiles: []
    }
  });

  await rm(path.join(sourceSkill, "guide.md"));
  await writeFile(path.join(sourceSkill, "notes.md"), "apply me\n");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-reapply-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const firstResult = await apply({ source: sourceRoot, target: "openclaw", lock: lockPath });
  assert.equal(firstResult.ok, true);

  const secondResult = await apply({ source: sourceRoot, target: "openclaw", lock: lockPath });
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.errors.some((error) => error.code === "unsafe_target_state"), false);

  const secondOfficeStatus = secondResult.preApplyStatus.statuses.find((item) => item.skill === "office-hours");
  assert.equal(secondOfficeStatus?.status, "current");

  const stillPreservedGuide = await readFile(path.join(targetSkill, "guide.md"), "utf8");
  assert.equal(stillPreservedGuide, "keep me\n");
});

test("apply refreshes the receipt for a skill whose only source change is a deletion", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-pure-deletion-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-pure-deletion-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");
  await writeFile(path.join(sourceSkill, "guide.md"), "keep me\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"current\");\n");
  await writeFile(path.join(targetSkill, "guide.md"), "keep me\n");

  const oldHash = await hashDirectory(sourceSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: { path: sourceSkill },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: oldHash,
      installedFiles: []
    }
  });

  await rm(path.join(sourceSkill, "guide.md"));

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-pure-deletion-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, true);
  assert.equal(result.preApplyStatus.summary.behind, 1);
  assert.equal(result.applied.files, 0);

  const officeStatus = result.postApplyStatus?.statuses.find((item) => item.skill === "office-hours");
  assert.equal(officeStatus?.status, "current");
  assert.equal(result.postApplyStatus?.summary.behind, 0);
  assert.equal(result.postApplyStatus?.summary.dirty, 0);

  const preservedGuide = await readFile(path.join(targetSkill, "guide.md"), "utf8");
  assert.equal(preservedGuide, "keep me\n");

  const receiptText = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");
  const receipt = JSON.parse(receiptText) as {
    installs?: Record<string, { sourceHash?: string } | Array<Record<string, unknown>>>;
  };
  const entry = receipt.installs?.["office-hours"];
  assert.ok(entry);
  const receivedRecord = Array.isArray(entry) ? entry[0] : entry;
  assert.ok(receivedRecord !== undefined);
  if (receivedRecord === undefined) {
    return;
  }
  const newSourceHash = await hashDirectory(sourceSkill);
  assert.equal(receivedRecord.sourceHash, newSourceHash);
  assert.notEqual(receivedRecord.sourceHash, oldHash);
});

test("apply creates missing skills when in plan and applies updates atomically", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-create-success-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-create-success-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot, ["office-hours", "time-tracker"]);

  const sourceOffice = path.join(sourceRoot, "skills", "office-hours");
  const sourceTracker = path.join(sourceRoot, "skills", "time-tracker");
  const targetOffice = path.join(targetRoot, "office-hours");
  const targetTracker = path.join(targetRoot, "time-tracker");

  await mkdir(sourceOffice, { recursive: true });
  await mkdir(sourceTracker, { recursive: true });
  await mkdir(targetOffice, { recursive: true });

  await writeFile(path.join(sourceOffice, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceOffice, "runtime.js"), "console.log(\"office old\");\n");
  await writeFile(path.join(sourceOffice, "guide.md"), "keep me\n");
  await writeFile(path.join(sourceTracker, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceTracker, "runtime.js"), "console.log(\"tracker old\");\n");

  await writeFile(path.join(targetOffice, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetOffice, "runtime.js"), "console.log(\"office old\");\n");
  await writeFile(path.join(targetOffice, "guide.md"), "keep me\n");

  const officeHash = await hashDirectory(sourceOffice);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceOffice
      },
      sourcePath: sourceOffice,
      targetPath: targetOffice,
      version: "2026.06.11",
      sourceHash: officeHash,
      installedFiles: []
    }
  });

  await writeFile(path.join(sourceOffice, "runtime.js"), "console.log(\"office new\");\n");
  await writeFile(path.join(sourceTracker, "runtime.js"), "console.log(\"tracker new\");\n");
  await writeFile(path.join(sourceTracker, "notes.md"), "tracker added\n");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-create-success-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied.skills.includes("office-hours"), true);
  assert.equal(result.applied.skills.includes("time-tracker"), true);
  assert.equal(result.applied.files > 0, true);
  assert.equal(result.postApplyStatus !== null, true);
  assert.equal(result.postApplyStatus?.ok, true);

  assert.equal(await readFile(path.join(targetOffice, "runtime.js"), "utf8"), "console.log(\"office new\");\n");
  assert.equal(await readFile(path.join(targetOffice, "guide.md"), "utf8"), "keep me\n");

  const createdTrackerRuntime = await readFile(path.join(targetTracker, "runtime.js"), "utf8");
  assert.equal(createdTrackerRuntime, "console.log(\"tracker new\");\n");
  const createdTrackerNotes = await readFile(path.join(targetTracker, "notes.md"), "utf8");
  assert.equal(createdTrackerNotes, "tracker added\n");

  const receipt = JSON.parse(await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8")) as {
    installs?: Record<string, { sourceHash?: string; targetPath?: string } | Array<Record<string, unknown>>>;
  };
  const officeEntry = receipt.installs?.["office-hours"];
  const trackerEntry = receipt.installs?.["time-tracker"];
  assert.ok(officeEntry);
  assert.ok(trackerEntry);
  const officeRecord = Array.isArray(officeEntry) ? officeEntry[0] : officeEntry;
  const trackerRecord = Array.isArray(trackerEntry) ? trackerEntry[0] : trackerEntry;
  assert.ok(officeRecord !== undefined && trackerRecord !== undefined);
  if (officeRecord === undefined || trackerRecord === undefined) {
    return;
  }
  assert.equal(typeof officeRecord.sourceHash, "string");
  assert.equal(typeof trackerRecord.sourceHash, "string");
  const expectedOfficeHash = await hashDirectory(sourceOffice);
  const expectedTrackerHash = await hashDirectory(sourceTracker);
  assert.equal(officeRecord.sourceHash, expectedOfficeHash);
  assert.equal(trackerRecord.sourceHash, expectedTrackerHash);
});

test("apply rolls back writes for a skill when a write fails mid-skill", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-rollback-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-rollback-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"baseline\");\n");
  await writeFile(path.join(sourceSkill, "notes.md"), "old note\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"baseline\");\n");
  await writeFile(path.join(targetSkill, "notes.md"), "old note\n");

  const oldHash = await hashDirectory(sourceSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: oldHash,
      installedFiles: []
    }
  });

  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"changed\");\n");
  await writeFile(path.join(sourceSkill, "notes.md"), "new note\n");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-rollback-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath,
    __test: {
      failAfterSuccessfulWrites: 1
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "write_error"), true);

  const runtimeAfter = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  const notesAfter = await readFile(path.join(targetSkill, "notes.md"), "utf8");
  assert.equal(runtimeAfter, "console.log(\"baseline\");\n");
  assert.equal(notesAfter, "old note\n");
});

test("apply rolls back a newly created skill when create entries fail mid-skill", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-create-rollback-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-create-rollback-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"baseline\");\n");
  await writeFile(path.join(sourceSkill, "notes.md"), "planned note\n");

  const targetSkill = path.join(targetRoot, "office-hours");

  const oldHash = await hashDirectory(sourceSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: oldHash,
      installedFiles: []
    }
  });

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-create-rollback-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  await rm(targetSkill, { recursive: true, force: true });
  await writeFile(path.join(targetRoot, "orphan.txt"), "keep me\n");

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath,
    __test: {
      failAfterSuccessfulWrites: 1
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "write_error"), true);

  const createdRuntime = await readFile(path.join(targetSkill, "runtime.js"), "utf8").catch(() => null);
  const createdNotes = await readFile(path.join(targetSkill, "notes.md"), "utf8").catch(() => null);
  assert.equal(createdRuntime, null);
  assert.equal(createdNotes, null);

  const orphanAfter = await readFile(path.join(targetRoot, "orphan.txt"), "utf8");
  assert.equal(orphanAfter, "keep me\n");

  const receiptText = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");
  const receipt = JSON.parse(receiptText) as {
    schema: string;
    installs?: Record<string, { sourceHash?: string; targetPath?: string } | Array<Record<string, unknown>>>
  };

  const receiptEntry = receipt.installs?.["office-hours"];
  assert.ok(receiptEntry);
  const receivedRecord = Array.isArray(receiptEntry) ? receiptEntry[0] : receiptEntry;
  assert.ok(receivedRecord !== undefined);
  if (receivedRecord === undefined) {
    return;
  }

  assert.equal(receivedRecord.sourceHash, oldHash);
});

test("apply rolls back writes when receipt persistence fails", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-receipt-rollback-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-receipt-rollback-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"before\");\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"before\");\n");

  const sourceHash = await hashDirectory(sourceSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash,
      installedFiles: []
    }
  });

  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"after\");\n");
  const beforeRuntime = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  const beforeReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-receipt-rollback-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath,
    __test: {
      failAfterReceiptWrites: 1
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "write_error"), true);
  assert.equal(result.postApplyStatus, null);

  const afterRuntime = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  assert.equal(afterRuntime, beforeRuntime);

  const afterReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");
  assert.equal(afterReceipt, beforeReceipt);
});

test("apply rolls back all skill writes when receipt persistence fails", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-receipt-rollback-multi-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-receipt-rollback-multi-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot, ["office-hours", "time-tracker"]);

  const sourceOffice = path.join(sourceRoot, "skills", "office-hours");
  const sourceTracker = path.join(sourceRoot, "skills", "time-tracker");
  await mkdir(sourceOffice, { recursive: true });
  await mkdir(sourceTracker, { recursive: true });
  await writeFile(path.join(sourceOffice, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceOffice, "runtime.js"), "console.log(\"office old\");\n");
  await writeFile(path.join(sourceTracker, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceTracker, "runtime.js"), "console.log(\"tracker old\");\n");

  const targetOffice = path.join(targetRoot, "office-hours");
  const targetTracker = path.join(targetRoot, "time-tracker");
  await mkdir(targetOffice, { recursive: true });
  await mkdir(targetTracker, { recursive: true });
  await writeFile(path.join(targetOffice, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetOffice, "runtime.js"), "console.log(\"office old\");\n");
  await writeFile(path.join(targetTracker, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetTracker, "runtime.js"), "console.log(\"tracker old\");\n");

  const oldOfficeHash = await hashDirectory(sourceOffice);
  const oldTrackerHash = await hashDirectory(sourceTracker);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceOffice
      },
      sourcePath: sourceOffice,
      targetPath: targetOffice,
      version: "2026.06.11",
      sourceHash: oldOfficeHash,
      installedFiles: []
    }
  });
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "time-tracker",
    installRecord: {
      skill: "time-tracker",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceTracker
      },
      sourcePath: sourceTracker,
      targetPath: targetTracker,
      version: "2026.06.11",
      sourceHash: oldTrackerHash,
      installedFiles: []
    }
  });

  await writeFile(path.join(sourceOffice, "runtime.js"), "console.log(\"office new\");\n");
  await writeFile(path.join(sourceTracker, "runtime.js"), "console.log(\"tracker new\");\n");

  const beforeOfficeRuntime = await readFile(path.join(targetOffice, "runtime.js"), "utf8");
  const beforeTrackerRuntime = await readFile(path.join(targetTracker, "runtime.js"), "utf8");
  const beforeReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-receipt-rollback-multi-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath,
    __test: {
      failAfterReceiptWrites: 1
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "write_error"), true);
  assert.equal(result.postApplyStatus, null);

  const afterOfficeRuntime = await readFile(path.join(targetOffice, "runtime.js"), "utf8");
  const afterTrackerRuntime = await readFile(path.join(targetTracker, "runtime.js"), "utf8");
  assert.equal(afterOfficeRuntime, beforeOfficeRuntime);
  assert.equal(afterTrackerRuntime, beforeTrackerRuntime);

  const afterReceipt = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");
  assert.equal(afterReceipt, beforeReceipt);
});

test("apply rolls back all skill writes when a later skill write fails", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-multi-rollback-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-multi-rollback-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot, ["office-hours", "time-tracker"]);

  const sourceOffice = path.join(sourceRoot, "skills", "office-hours");
  const sourceTracker = path.join(sourceRoot, "skills", "time-tracker");
  await mkdir(sourceOffice, { recursive: true });
  await mkdir(sourceTracker, { recursive: true });

  await writeFile(path.join(sourceOffice, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceOffice, "runtime.js"), "console.log(\"office old\");\n");
  await writeFile(path.join(sourceTracker, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceTracker, "runtime.js"), "console.log(\"tracker old\");\n");

  const targetOffice = path.join(targetRoot, "office-hours");
  const targetTracker = path.join(targetRoot, "time-tracker");
  await mkdir(targetOffice, { recursive: true });
  await mkdir(targetTracker, { recursive: true });
  await writeFile(path.join(targetOffice, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetOffice, "runtime.js"), "console.log(\"office old\");\n");
  await writeFile(path.join(targetTracker, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetTracker, "runtime.js"), "console.log(\"tracker old\");\n");

  const oldOfficeHash = await hashDirectory(sourceOffice);
  const oldTrackerHash = await hashDirectory(sourceTracker);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceOffice
      },
      sourcePath: sourceOffice,
      targetPath: targetOffice,
      version: "2026.06.11",
      sourceHash: oldOfficeHash,
      installedFiles: []
    }
  });
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "time-tracker",
    installRecord: {
      skill: "time-tracker",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceTracker
      },
      sourcePath: sourceTracker,
      targetPath: targetTracker,
      version: "2026.06.11",
      sourceHash: oldTrackerHash,
      installedFiles: []
    }
  });

  await writeFile(path.join(sourceOffice, "runtime.js"), "console.log(\"office new\");\n");
  await writeFile(path.join(sourceTracker, "runtime.js"), "console.log(\"tracker new\");\n");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-multi-rollback-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath,
    __test: {
      failAfterSuccessfulWrites: 2
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "write_error"), true);

  const officeRuntimeAfter = await readFile(path.join(targetOffice, "runtime.js"), "utf8");
  const trackerRuntimeAfter = await readFile(path.join(targetTracker, "runtime.js"), "utf8");
  assert.equal(officeRuntimeAfter, "console.log(\"office old\");\n");
  assert.equal(trackerRuntimeAfter, "console.log(\"tracker old\");\n");

  const receiptText = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");
  const receipt = JSON.parse(receiptText) as {
    schema: string;
    installs?: Record<string, { sourceHash?: string; targetPath?: string } | Array<Record<string, unknown>>>
  };

  const officeReceiptEntry = receipt.installs?.["office-hours"];
  const trackerReceiptEntry = receipt.installs?.["time-tracker"];
  assert.ok(officeReceiptEntry);
  assert.ok(trackerReceiptEntry);

  const officeRecord = Array.isArray(officeReceiptEntry) ? officeReceiptEntry[0] : officeReceiptEntry;
  const trackerRecord = Array.isArray(trackerReceiptEntry) ? trackerReceiptEntry[0] : trackerReceiptEntry;
  assert.ok(officeRecord !== undefined);
  assert.ok(trackerRecord !== undefined);
  if (officeRecord === undefined || trackerRecord === undefined) {
    return;
  }

  assert.equal(officeRecord.sourceHash, oldOfficeHash);
  assert.equal(trackerRecord.sourceHash, oldTrackerHash);
});

test("apply accepts artifact input and applies planned updates", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");
  await writeFile(path.join(sourceSkill, "guide.md"), "keep me\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"current\");\n");
  await writeFile(path.join(targetSkill, "guide.md"), "keep me\n");

  const oldHash = await hashDirectory(sourceSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: oldHash,
      installedFiles: []
    }
  });

  await rm(path.join(sourceSkill, "guide.md"));
  await writeFile(path.join(sourceSkill, "notes.md"), "apply me\n");

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const artifactManifestPath = await writeArtifactManifest(artifactRoot, {
    sourceRoot,
    target: "openclaw",
    plannedSkills: ["office-hours"]
  });

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: artifactRoot
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "artifact");
  assert.equal(result.input, artifactManifestPath);
  assert.equal(result.postApplyStatus !== null, true);
  assert.equal(result.postApplyStatus?.ok, true);
  assert.equal(result.applied.files > 0, true);

  const officeStatus = result.postApplyStatus?.statuses.find((item) => item.skill === "office-hours");
  assert.equal(officeStatus?.status, "current");
  assert.equal(result.postApplyStatus?.summary.dirty, 0);

  const createdNotes = await readFile(path.join(targetSkill, "notes.md"), "utf8");
  assert.equal(createdNotes, "apply me\n");

  const preservedGuide = await readFile(path.join(targetSkill, "guide.md"), "utf8");
  assert.equal(preservedGuide, "keep me\n");

  const receiptText = await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8");
  const receipt = JSON.parse(receiptText) as {
    schema: string;
    installs?: Record<string, { sourceHash?: string; targetPath?: string } | Array<Record<string, unknown>>>;
  };

  const receiptEntry = receipt.installs?.["office-hours"];
  assert.ok(receiptEntry);

  const receivedRecord = Array.isArray(receiptEntry) ? receiptEntry[0] : receiptEntry;
  assert.ok(receivedRecord !== undefined);
  if (receivedRecord === undefined) {
    return;
  }

  assert.ok(receivedRecord.targetPath !== undefined);
  assert.equal(typeof receivedRecord.sourceHash, "string");
  const newSourceHash = await hashDirectory(sourceSkill);
  assert.equal(receivedRecord.sourceHash, newSourceHash);
});

test("apply resolves artifact manifest from .skill-suitcase/artifacts", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-nested-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-nested-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");
  await writeFile(path.join(sourceSkill, "guide.md"), "keep me\n");

  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"current\");\n");
  await writeFile(path.join(targetSkill, "guide.md"), "keep me\n");

  const oldHash = await hashDirectory(sourceSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceSkill
      },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash: oldHash,
      installedFiles: []
    }
  });

  await rm(path.join(sourceSkill, "guide.md"));
  await writeFile(path.join(sourceSkill, "notes.md"), "apply me\n");

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-nested-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const artifactBundleRoot = path.join(artifactRoot, ".skill-suitcase", "artifacts");
  await mkdir(artifactBundleRoot, { recursive: true });
  const artifactManifestPath = await writeArtifactManifest(artifactBundleRoot, {
    sourceRoot,
    target: "openclaw",
    plannedSkills: ["office-hours"]
  });

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: artifactRoot
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "artifact");
  assert.equal(result.input, artifactManifestPath);
  assert.equal(result.postApplyStatus !== null, true);
  assert.equal(result.postApplyStatus?.ok, true);
  assert.equal(result.applied.files > 0, true);

  assert.equal(await readFile(path.join(targetSkill, "notes.md"), "utf8"), "apply me\n");
  assert.equal(await readFile(path.join(targetSkill, "guide.md"), "utf8"), "keep me\n");
});

test("apply applies artifact-mode multi-skill plans", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-multi-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-multi-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot, ["office-hours", "time-tracker"]);

  const sourceOffice = path.join(sourceRoot, "skills", "office-hours");
  const sourceTracker = path.join(sourceRoot, "skills", "time-tracker");
  const targetOffice = path.join(targetRoot, "office-hours");
  const targetTracker = path.join(targetRoot, "time-tracker");

  await mkdir(sourceOffice, { recursive: true });
  await mkdir(sourceTracker, { recursive: true });
  await mkdir(targetOffice, { recursive: true });
  await mkdir(targetTracker, { recursive: true });

  await writeFile(path.join(sourceOffice, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceOffice, "runtime.js"), "console.log(\"office old\");\n");
  await writeFile(path.join(sourceOffice, "guide.md"), "keep source me\n");
  await writeFile(path.join(sourceTracker, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceTracker, "runtime.js"), "console.log(\"tracker old\");\n");
  await writeFile(path.join(sourceTracker, "tracker-extra.txt"), "keep me\n");

  await writeFile(path.join(targetOffice, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetOffice, "runtime.js"), "console.log(\"office old\");\n");
  await writeFile(path.join(targetOffice, "guide.md"), "keep source me\n");
  await writeFile(path.join(targetTracker, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetTracker, "runtime.js"), "console.log(\"tracker old\");\n");
  await writeFile(path.join(targetTracker, "tracker-extra.txt"), "keep me\n");

  const sourceOfficeHash = await hashDirectory(sourceOffice);
  const sourceTrackerHash = await hashDirectory(sourceTracker);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceOffice
      },
      sourcePath: sourceOffice,
      targetPath: targetOffice,
      version: "2026.06.11",
      sourceHash: sourceOfficeHash,
      installedFiles: []
    }
  });
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "time-tracker",
    installRecord: {
      skill: "time-tracker",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: {
        path: sourceTracker
      },
      sourcePath: sourceTracker,
      targetPath: targetTracker,
      version: "2026.06.11",
      sourceHash: sourceTrackerHash,
      installedFiles: []
    }
  });

  await writeFile(path.join(sourceOffice, "runtime.js"), "console.log(\"office new\");\n");
  await writeFile(path.join(sourceOffice, "notes.md"), "office added\n");
  await writeFile(path.join(sourceTracker, "runtime.js"), "console.log(\"tracker new\");\n");
  await writeFile(path.join(sourceTracker, "notes.md"), "tracker added\n");

  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-artifact-multi-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const artifactManifestPath = await writeArtifactManifest(artifactRoot, {
    sourceRoot,
    target: "openclaw",
    plannedSkills: ["office-hours", "time-tracker"]
  });

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    artifact: artifactRoot
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "artifact");
  assert.equal(result.input, artifactManifestPath);
  assert.equal(result.applied.files > 0, true);
  assert.equal(result.applied.skills.length, 2);
  assert.equal(result.postApplyStatus !== null, true);
  assert.equal(result.postApplyStatus?.ok, true);

  assert.equal(await readFile(path.join(targetOffice, "notes.md"), "utf8"), "office added\n");
  assert.equal(await readFile(path.join(targetOffice, "guide.md"), "utf8"), "keep source me\n");
  assert.equal(await readFile(path.join(targetTracker, "runtime.js"), "utf8"), "console.log(\"tracker new\");\n");
  assert.equal(await readFile(path.join(targetTracker, "notes.md"), "utf8"), "tracker added\n");
  assert.equal(await readFile(path.join(targetTracker, "tracker-extra.txt"), "utf8"), "keep me\n");

  const receipt = JSON.parse(await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8")) as {
    installs?: Record<string, { sourceHash?: string; targetPath?: string } | Array<Record<string, unknown>>>;
  };
  const officeEntry = receipt.installs?.["office-hours"];
  const trackerEntry = receipt.installs?.["time-tracker"];
  assert.ok(officeEntry);
  assert.ok(trackerEntry);

  const officeRecord = Array.isArray(officeEntry) ? officeEntry[0] : officeEntry;
  const trackerRecord = Array.isArray(trackerEntry) ? trackerEntry[0] : trackerEntry;
  assert.ok(officeRecord !== undefined && trackerRecord !== undefined);
  if (officeRecord === undefined || trackerRecord === undefined) {
    return;
  }

  const expectedOfficeHash = await hashDirectory(sourceOffice);
  const expectedTrackerHash = await hashDirectory(sourceTracker);
  assert.equal(officeRecord.sourceHash, expectedOfficeHash);
  assert.equal(trackerRecord.sourceHash, expectedTrackerHash);
});

test("apply --mode symlink installs a missing skill as a symlink into the target root", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-symlink-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-symlink-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-symlink-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath,
    mode: "symlink"
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied.skills.includes("office-hours"), true);

  const targetSkill = path.join(targetRoot, "office-hours");
  const linkInfo = await lstat(targetSkill);
  assert.equal(linkInfo.isSymbolicLink(), true);
  const rawLink = await readlink(targetSkill);
  assert.equal(path.resolve(path.dirname(targetSkill), rawLink), path.resolve(sourceSkill));

  const receipt = JSON.parse(await readFile(path.join(targetRoot, ".skill-suitcase-receipt.json"), "utf8")) as {
    installs: Record<string, unknown>;
  };
  const installEntry = receipt.installs["office-hours"];
  const installRecord = Array.isArray(installEntry) ? installEntry[0] : installEntry;
  assert.equal((installRecord as { mode?: string }).mode, "symlink");
  assert.equal((installRecord as { sourceHash?: string }).sourceHash, await hashDirectory(sourceSkill));

  const officeStatus = result.postApplyStatus?.statuses.find((item) => item.skill === "office-hours");
  assert.equal(officeStatus?.status, "current");
  assert.equal(result.postApplyStatus?.summary.dirty, 0);
});

test("apply --mode symlink refuses to convert a managed real directory without approval", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-symlink-conflict-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-symlink-conflict-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  // A real, copy-installed directory already exists and is recorded as current.
  const targetSkill = path.join(targetRoot, "office-hours");
  await mkdir(targetSkill, { recursive: true });
  await writeFile(path.join(targetSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await writeFile(path.join(targetSkill, "runtime.js"), "console.log(\"current\");\n");

  const sourceHash = await hashDirectory(sourceSkill);
  await upsertAndWriteReceipt({
    installRoot: targetRoot,
    skillName: "office-hours",
    installRecord: {
      skill: "office-hours",
      agent: "openclaw",
      target: "openclaw",
      mode: "copy",
      source: { path: sourceSkill },
      sourcePath: sourceSkill,
      targetPath: targetSkill,
      version: "2026.06.11",
      sourceHash,
      installedFiles: []
    }
  });

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-symlink-conflict-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath,
    mode: "symlink"
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "symlink_target_conflict"), true);

  // The pre-existing real directory must be left intact (never clobbered).
  const info = await lstat(targetSkill);
  assert.equal(info.isDirectory(), true);
  assert.equal(info.isSymbolicLink(), false);
  const preserved = await readFile(path.join(targetSkill, "runtime.js"), "utf8");
  assert.equal(preserved, "console.log(\"current\");\n");
});

test("apply --mode symlink rejects source paths whose realpath escapes the source root", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-symlink-realpath-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-symlink-realpath-target-"));
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-symlink-realpath-external-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));

  await writeCatalog(sourceRoot, targetRoot);

  const externalSkill = path.join(externalRoot, "office-hours");
  await mkdir(externalSkill, { recursive: true });
  await writeFile(path.join(externalSkill, "SKILL.md"), "---\nversion: 2026.06.11\n---\n");
  await mkdir(path.join(sourceRoot, "skills"), { recursive: true });
  await symlink(externalSkill, path.join(sourceRoot, "skills", "office-hours"), "dir");

  const lockPath = path.join(await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-apply-symlink-realpath-lock-")), "plan-lock.json");
  t.after(() => rm(path.dirname(lockPath), { recursive: true, force: true }));
  await writeFile(
    lockPath,
    `${JSON.stringify(await buildPlanLock({
      source: sourceRoot,
      target: "openclaw",
      assignmentPath: "openclaw",
      sourceCommit: "deadbeef"
    }), null, 2)}\n`
  );

  const result = await apply({
    source: sourceRoot,
    target: "openclaw",
    lock: lockPath,
    mode: "symlink"
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "symlink_source_escape"), true);
  await assert.rejects(lstat(path.join(targetRoot, "office-hours")));
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.status, 0, result.stderr);
}
