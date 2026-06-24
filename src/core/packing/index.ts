import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCatalog, type LoadedCatalog, type TargetOverrides } from "../catalog/index.js";
import {
  findTargetRegistryEntriesByAssignment,
  resolveTargetRegistryEntryFromManifest
} from "../catalog/target-registry.js";
import { plan } from "../planning/index.js";
import { type PlanResult } from "../planning/index.js";
import { checkSelectedSourceHygiene } from "../source-hygiene.js";
import { sourcePolicyDecision } from "../source-policy.js";

const BUNDLE_SCHEMA = "calvinnwq.skills.pack-bundle.v0";
const BUNDLE_MANIFEST = "skill-suitcase-bundle.json";
const BUNDLE_ROOT = ".skill-suitcase";

type PlanLike = PlanResult["planned"][number];
type ErrorLike = PlanResult["errors"][number];

type PackInput = {
  source: string;
  target: string;
  dryRun?: boolean;
  output?: string | null;
  targetOverrides?: TargetOverrides | undefined;
};

type PackResult = {
  ok: boolean;
  dryRun: boolean;
  source: string;
  target: string;
  bundle: PackBundle;
  planned: PlanLike[];
  blocked: PlanLike[];
  files: PackedFile[];
  summary: PackArtifactSummary;
  errors: ErrorLike[];
};

type PackBundle = {
  action: "pack";
  outputPath: string | null;
  artifactId: string | null;
  artifactPath: string | null;
  manifestPath: string | null;
  schema: string;
  reason: "dry-run" | "written";
};

type PackArtifactSummary = {
  skills: number;
  blocked: number;
  files: number;
  bytes: number;
};

type PackedFile = {
  skill: string;
  relativePath: string;
  sourcePath: string;
  bundlePath: string;
  bytes: number;
  sha256: string;
};

type PackArtifact = {
  id: string;
  source: {
    repo: string;
    manifestPath: string;
    commit: string | null;
    ref: string | null;
  };
  target: string;
  action: "pack";
  planned: PlanLike[];
  blocked: PlanLike[];
  files: PackedFile[];
  fileHashes: Record<string, Record<string, string>>;
  summary: PackArtifactSummary;
  createdAt: string;
};

type PackResultManifest = {
  sourceRoot: string;
  manifestPath: string;
  target: string;
  sourceCommit: string | null;
  planned: PlanLike[];
  blocked: PlanLike[];
  files: PackedFile[];
};

type WriteBundleInput = {
  outputPath: string;
  sourceRoot: string;
  manifest: LoadedCatalog["manifest"];
  artifact: PackArtifact;
  manifestPath: string | null;
  files: PackedFile[];
};

export async function pack({
  source,
  target,
  dryRun = false,
  output = null,
  targetOverrides
}: PackInput): Promise<PackResult> {
  if (dryRun && output) {
    throw new Error("pack accepts either --dry-run or --output, not both");
  }

  if (!dryRun && !output) {
    throw new Error("pack requires --output unless --dry-run is set");
  }

  const { sourceRoot, manifestPath, manifest } = await loadCatalog(source, { targetOverrides });
  if (isReadOnlyPackTarget(manifest, target, targetOverrides)) {
    const sourceCommit = resolveSourceCommit(sourceRoot);
    const errors: ErrorLike[] = [{
      code: "read_only_target",
      message: `Target ${target} is modeled read-only and cannot be packed.`
    }];
    const artifact = buildArtifactRecord({
      sourceRoot,
      manifestPath,
      target,
      sourceCommit,
      planned: [],
      blocked: [],
      files: []
    });

    return {
      ok: false,
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
      planned: [],
      blocked: [],
      files: [],
      summary: artifact.summary,
      errors
    };
  }
  const planTarget = resolvePlanTarget(manifest, target);
  const planResult: PlanResult = await plan({ source: sourceRoot, target: planTarget });
  const files: PackedFile[] = [];
  const errors: ErrorLike[] = [...planResult.errors];

  if (planResult.ok) {
    const hygiene = checkSelectedSourceHygiene({
      sourceRoot,
      plannedSkills: planResult.planned,
      sourcePolicy: manifest.sourcePolicy
    });
    if (!hygiene.ok) {
      errors.push(...hygiene.errors);
    } else {
      for (const plannedSkill of planResult.planned) {
        const collected = await collectSkillFiles(plannedSkill, manifest.sourcePolicy);
        errors.push(...collected.errors);
        files.push(...collected.files);
      }
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

  const result: PackResult = {
    ok: planResult.ok && errors.length === 0,
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
    errors
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

  if (!dryRun && output && result.ok) {
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

function isReadOnlyPackTarget(
  manifest: LoadedCatalog["manifest"],
  target: string,
  targetOverrides?: TargetOverrides | undefined
): boolean {
  const targetEntry = resolveTargetRegistryEntryFromManifest(manifest, target, targetOverrides);
  if (targetEntry?.readOnly === true) {
    return true;
  }

  return findTargetRegistryEntriesByAssignment(manifest, target, targetOverrides)
    .some((entry) => entry.readOnly === true);
}

function buildArtifactRecord({
  sourceRoot,
  manifestPath,
  target,
  sourceCommit,
  planned,
  blocked,
  files
}: PackResultManifest): PackArtifact {
  const summary: PackArtifactSummary = {
    skills: planned.length,
    blocked: blocked.length,
    files: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0)
  };

  const artifact: Omit<PackArtifact, "id"> = {
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
    fileHashes: buildFileHashes(files),
    summary,
    createdAt: new Date().toISOString()
  };

  return {
    ...artifact,
    id: computeArtifactId(artifact)
  };
}

function computeArtifactId(artifact: Omit<PackArtifact, "id">): string {
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
    fileHashes: artifact.fileHashes,
    summary: artifact.summary,
    schema: BUNDLE_SCHEMA
  };

  return createHash("sha256").update(JSON.stringify(stableObject(stableArtifact))).digest("hex");
}

async function writeBundle({ outputPath, sourceRoot, manifest, artifact, manifestPath, files }: WriteBundleInput): Promise<void> {
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
  if (manifestPath === null) {
    throw new Error("manifestPath must be available before writing bundle.");
  }
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(storedManifest, null, 2)}\n`, "utf8");
}

function buildStoredManifest(artifact: PackArtifact, sourceRoot: string) {
  return {
    schema: BUNDLE_SCHEMA,
    artifactId: artifact.id,
    source: artifact.source,
    target: artifact.target,
    action: artifact.action,
    createdAt: artifact.createdAt,
    summary: artifact.summary,
    fileHashes: artifact.fileHashes,
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

function buildFileHashes(files: PackedFile[]): Record<string, Record<string, string>> {
  const bySkill = new Map<string, Record<string, string>>();
  for (const file of files) {
    const current = bySkill.get(file.skill) ?? {};
    current[file.relativePath] = file.sha256;
    bySkill.set(file.skill, current);
  }

  const result: Record<string, Record<string, string>> = {};
  for (const [skill, hashes] of [...bySkill.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    result[skill] = stableObject(hashes) as Record<string, string>;
  }
  return result;
}

function resolvePlanTarget(manifest: LoadedCatalog["manifest"], target: string): string {
  if (manifest.assignments[target]) {
    return target;
  }

  const assignmentPath = manifest.assignmentPaths[target];
  if (isRecord(assignmentPath) && typeof assignmentPath.assignment === "string") {
    const assignment = assignmentPath.assignment.trim();
    if (assignment.length > 0) {
      return assignment;
    }
  }

  return target;
}

function resolveSourceCommit(sourceRoot: string): string | null {
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

function stableObject(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stableObject(item));
  }

  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    ordered[key] = stableObject(value[key]);
  }
  return ordered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function ensureOutputDirectory(outputPath: string): Promise<void> {
  try {
    const candidate = await stat(outputPath);
    if (!candidate.isDirectory()) {
      throw new Error(`pack output path must be a directory: ${outputPath}`);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    await mkdir(outputPath, { recursive: false });
  }
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await stat(candidatePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertOutputIsNotInstallRoot(outputPath: string, manifest: LoadedCatalog["manifest"]): void {
  const installRoots: string[] = [];

  for (const assignmentPath of Object.values(manifest.assignmentPaths)) {
    for (const key of ["path", "skillsPath"] as const) {
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

function isInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function collectSkillFiles(
  plannedSkill: PlanLike,
  sourcePolicy: LoadedCatalog["manifest"]["sourcePolicy"]
): Promise<{ files: PackedFile[]; errors: ErrorLike[] }> {
  const sourceRoot = plannedSkill.sourcePath;
  const filePaths = await listFiles(sourceRoot);
  const files: PackedFile[] = [];
  const errors: ErrorLike[] = [];

  for (const filePath of filePaths) {
    const relativePath = path.relative(sourceRoot, filePath);
    const policyDecision = sourcePolicyDecision(relativePath, sourcePolicy);
    if (policyDecision.action === "deny") {
      errors.push({
        code: "source_denied_path",
        message: `Refusing to materialize ${plannedSkill.skill}: source policy denies path ${relativePath}.`,
        skill: plannedSkill.skill
      });
      continue;
    }
    if (policyDecision.action === "exclude") {
      continue;
    }

    const bytes = await readFile(filePath);
    files.push({
      skill: plannedSkill.skill,
      relativePath,
      sourcePath: filePath,
      bundlePath: path.join("skills", plannedSkill.skill, relativePath),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }

  files.sort((left, right) => left.bundlePath.localeCompare(right.bundlePath));
  return { files, errors };
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

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
