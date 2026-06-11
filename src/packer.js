import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCatalog } from "./catalog.js";
import { plan } from "./planner.js";

const BUNDLE_SCHEMA = "calvinnwq.skills.pack-bundle.v0";
const BUNDLE_MANIFEST = "skill-suitcase-bundle.json";
const BUNDLE_ROOT = ".skill-suitcase";

export async function pack({ source, target, dryRun = false, output = null }) {
  if (dryRun && output) {
    throw new Error("pack accepts either --dry-run or --output, not both");
  }

  if (!dryRun && !output) {
    throw new Error("pack requires --output unless --dry-run is set");
  }

  const { sourceRoot, manifestPath, manifest } = await loadCatalog(source);
  const planResult = await plan({ source: sourceRoot, target });
  const files = [];

  if (planResult.ok) {
    for (const plannedSkill of planResult.planned) {
      files.push(...(await collectSkillFiles(plannedSkill)));
    }
  }

  const sourceCommit = resolveSourceCommit(sourceRoot);
  const artifact = buildArtifactRecord({
    sourceRoot,
    manifestPath,
    target,
    sourceCommit,
    planned: planResult.planned,
    blocked: planResult.blocked,
    files
  });

  const result = {
    ok: planResult.ok,
    dryRun,
    source: sourceRoot,
    target,
    bundle: {
      action: "pack",
      outputPath: output ? path.resolve(output) : null,
      artifactId: null,
      artifactPath: null,
      manifestPath: null,
      schema: BUNDLE_SCHEMA,
      reason: dryRun ? "dry-run" : "written"
    },
    planned: planResult.planned,
    blocked: planResult.blocked,
    files,
    summary: artifact.summary,
    errors: planResult.errors
  };

  if (output) {
    const artifactPath = path.join(path.resolve(output), BUNDLE_ROOT, "artifacts", artifact.id);
    result.bundle = {
      ...result.bundle,
      artifactId: artifact.id,
      artifactPath,
      manifestPath: path.join(artifactPath, BUNDLE_MANIFEST)
    };
  }

  if (!dryRun && result.ok) {
    await writeBundle({
      outputPath: path.resolve(output),
      sourceRoot,
      manifest,
      artifact,
      manifestPath: result.bundle.manifestPath,
      files
    });
  }

  return result;
}

function buildArtifactRecord({
  sourceRoot,
  manifestPath,
  target,
  sourceCommit,
  planned,
  blocked,
  files
}) {
  const summary = {
    skills: planned.length,
    blocked: blocked.length,
    files: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0)
  };

  const artifact = {
    source: {
      repo: sourceRoot,
      manifestPath,
      commit: sourceCommit,
      ref: sourceCommit
    },
    target,
    action: "pack",
    planned,
    blocked,
    files,
    summary,
    createdAt: new Date().toISOString()
  };

  artifact.id = computeArtifactId(artifact);
  return artifact;
}

function computeArtifactId(artifact) {
  const stableArtifact = {
    source: artifact.source,
    target: artifact.target,
    action: artifact.action,
    planned: artifact.planned.map((item) => ({
      skill: item.skill,
      action: item.action,
      variant: item.variant,
      sourcePath: item.sourcePath,
      evidence: [...item.evidence]
    })),
    blocked: artifact.blocked.map((item) => ({
      skill: item.skill,
      action: item.action,
      target: item.target,
      reason: item.reason,
      variant: item.variant,
      sourcePath: item.sourcePath,
      evidence: [...item.evidence]
    })),
    files: artifact.files.map((item) => ({
      skill: item.skill,
      relativePath: item.relativePath,
      sha256: item.sha256,
      bytes: item.bytes
    })),
    summary: artifact.summary,
    schema: BUNDLE_SCHEMA
  };

  return createHash("sha256").update(JSON.stringify(stableObject(stableArtifact))).digest("hex");
}

async function writeBundle({ outputPath, sourceRoot, manifest, artifact, manifestPath, files }) {
  assertOutputIsNotInstallRoot(outputPath, manifest);
  await ensureOutputDirectory(outputPath);

  const artifactRoot = path.join(outputPath, BUNDLE_ROOT, "artifacts", artifact.id);
  if (await pathExists(artifactRoot)) {
    throw new Error(`Refusing to overwrite existing artifact id: ${artifact.id}`);
  }

  for (const file of files) {
    const bundleFile = path.join(artifactRoot, file.bundlePath);
    await mkdir(path.dirname(bundleFile), { recursive: true });
    await copyFile(file.sourcePath, bundleFile);
  }

  const storedManifest = buildStoredManifest(artifact, sourceRoot);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(storedManifest, null, 2)}\n`, "utf8");
}

function buildStoredManifest(artifact, sourceRoot) {
  return {
    schema: BUNDLE_SCHEMA,
    artifactId: artifact.id,
    source: artifact.source,
    target: artifact.target,
    action: artifact.action,
    createdAt: artifact.createdAt,
    summary: artifact.summary,
    files: artifact.files.map((item) => ({
      skill: item.skill,
      relativePath: item.relativePath,
      bundlePath: item.bundlePath,
      sourcePath: path.relative(sourceRoot, item.sourcePath),
      bytes: item.bytes,
      sha256: item.sha256
    })),
    planned: artifact.planned.map((item) => ({
      skill: item.skill,
      action: item.action,
      variant: item.variant,
      sourcePath: path.relative(sourceRoot, item.sourcePath),
      evidence: item.evidence
    })),
    blocked: artifact.blocked.map((item) => ({
      skill: item.skill,
      action: item.action,
      target: item.target,
      reason: item.reason,
      variant: item.variant,
      sourcePath: path.relative(sourceRoot, item.sourcePath),
      evidence: item.evidence
    }))
  };
}

function resolveSourceCommit(sourceRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    cwd: sourceRoot,
    stdio: ["ignore", "pipe", "ignore"]
  });

  if (result.status === 0 && typeof result.stdout === "string") {
    const commit = result.stdout.trim();
    if (commit) {
      return commit;
    }
  }

  return null;
}

function stableObject(value) {
  if (!isRecord(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stableObject(item));
  }

  const ordered = {};
  for (const key of Object.keys(value).sort()) {
    ordered[key] = stableObject(value[key]);
  }
  return ordered;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function ensureOutputDirectory(outputPath) {
  try {
    const candidate = await stat(outputPath);
    if (!candidate.isDirectory()) {
      throw new Error(`pack output path must be a directory: ${outputPath}`);
    }
    return;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(outputPath, { recursive: false });
}

async function pathExists(candidatePath) {
  try {
    await stat(candidatePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertOutputIsNotInstallRoot(outputPath, manifest) {
  const installRoots = [];

  for (const assignmentPath of Object.values(manifest.assignmentPaths)) {
    for (const key of ["path", "skillsPath"]) {
      if (assignmentPath[key]) {
        installRoots.push(path.resolve(assignmentPath[key]));
      }
    }
  }

  for (const installRoot of installRoots) {
    if (isInsideOrEqual(outputPath, installRoot)) {
      throw new Error(`Refusing to pack into install target path: ${installRoot}`);
    }
  }
}

function isInsideOrEqual(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function collectSkillFiles(plannedSkill) {
  const sourceRoot = plannedSkill.sourcePath;
  const filePaths = await listFiles(sourceRoot);
  const files = [];

  for (const filePath of filePaths) {
    const bytes = await readFile(filePath);
    files.push({
      skill: plannedSkill.skill,
      relativePath: path.relative(sourceRoot, filePath),
      sourcePath: filePath,
      bundlePath: path.join("skills", plannedSkill.skill, path.relative(sourceRoot, filePath)),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }

  files.sort((left, right) => left.bundlePath.localeCompare(right.bundlePath));
  return files;
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      const info = await stat(entryPath);
      if (info.isFile()) {
        files.push(entryPath);
      }
    }
  }

  return files.sort();
}
