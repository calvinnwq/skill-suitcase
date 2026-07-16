import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { assessPlanLock, type PlanLock, PLAN_LOCK_SCHEMA } from "../planning/plan-lock.js";
import { isPathWithinRoot } from "../install-modes.js";
import type { Receipt, ReceiptInstalledFile, ReceiptInstallRecord } from "../receipts/index.js";
import { BUNDLE_SCHEMA, matchesPackArtifactId } from "../packing/artifact-id.js";
import { findReceiptInstallRecord } from "./receipt-install-records.js";

/**
 * Approval-input interpretation for apply: plan-lock and artifact manifest
 * loading and validation, source/target/assignment consistency checks,
 * approved file-hash normalization, and the dirty-behind approval checks.
 * This module reads files only to verify approval hashes; it performs no
 * filesystem mutation, receipt writes, or process output. Apply orchestration
 * and all writes stay in index.ts.
 */

export type ApplyMode = "lock" | "artifact";

export type ApplyFinding = {
  code: string;
  message: string;
};

export type ResolvedApprovalContext = {
  ok: true;
  mode: ApplyMode;
  input: string;
  sourceCommit: string;
  approvedSkills: string[];
  assignmentPath?: string | undefined;
  approvedDestinations?: Map<string, string>;
  approvedFileHashes: Map<string, Map<string, string>> | null;
};

export type ApprovalContextFailure = {
  ok: false;
  mode: ApplyMode;
  input: string;
  errors: ApplyFinding[];
};

export type ApprovalContext = ResolvedApprovalContext | ApprovalContextFailure;

type PlanLockManifest = PlanLock & {
  planId?: string;
};

type ArtifactManifest = {
  schema: string;
  artifactId?: string;
  source: {
    repo: string;
    ref?: string | null;
    commit?: string | null;
  };
  target: string;
  action?: string;
  summary?: unknown;
  planned: Array<{ skill: string; sourcePath?: string; destination?: unknown }>;
  blocked?: Array<{ skill: string }>;
  files?: Array<{
    skill: string;
    relativePath: string;
    bundlePath: string;
    destination?: unknown;
    bytes?: number;
    sha256: string;
  }>;
  fileHashes?: Record<string, Record<string, string>>;
};

type ApprovalDiffEntry = {
  action: "create" | "update" | "unchanged" | "extra" | "missing" | "blocked";
  relativePath: string | null;
  sourcePath: string | null;
  targetPath: string | null;
};

type DirtyBehindStatusItem = {
  skill: string;
  targetPath: string;
  installedHash: string | null;
  currentHash: string | null;
};

const BUNDLE_FILE = "skill-suitcase-bundle.json";

export async function resolveLockContext({ lockPath, source, target }: {
  lockPath: string;
  source: string;
  target: string;
}): Promise<ApprovalContext> {
  const resolved = path.resolve(lockPath);
  const normalizedSource = path.resolve(source);
  const parsed = await readJson(resolved);

  if (!isRecord(parsed) || !isPlanLock(parsed)) {
    return {
      ok: false,
      mode: "lock",
      input: resolved,
      errors: [{ code: "invalid_apply_input", message: `Invalid lockfile at ${resolved}` }]
    };
  }

  const lock = parsed as PlanLockManifest;
  if (lock.target !== target) {
    return {
      ok: false,
      mode: "lock",
      input: resolved,
      errors: [{
        code: "plan_lock_target_mismatch",
        message: `Plan-lock target ${lock.target} does not match apply target ${target}`
      }]
    };
  }

  if (path.resolve(lock.source.repo) !== normalizedSource) {
    return {
      ok: false,
      mode: "lock",
      input: resolved,
      errors: [{
        code: "plan_lock_source_mismatch",
        message: `Plan-lock source ${lock.source.repo} does not match apply source ${source}`
      }]
    };
  }

  const assessed = await assessPlanLock({
    source: normalizedSource,
    target: lock.target,
    assignmentPath: lock.assignmentPath ?? target,
    lock,
    ...(lock.source.commit ? { sourceCommit: lock.source.commit } : {})
  });

  if (!assessed.valid) {
    return {
      ok: false,
      mode: "lock",
      input: resolved,
      errors: assessed.reasons.map((reason) => ({
        code: `plan_lock_${reason}`,
        message: `Plan-lock is stale: ${reason}`
      }))
    };
  }

  return {
    ok: true,
    mode: "lock",
    input: resolved,
    sourceCommit: lock.source.commit ?? "",
    approvedSkills: lock.selectedSkills,
    assignmentPath: lock.assignmentPath ?? target,
    approvedFileHashes: fileHashesToMap(lock.fileHashes)
  };
}

export async function resolveArtifactContext({ artifactPath, source, target }: {
  artifactPath: string;
  source: string;
  target: string;
}): Promise<ApprovalContext> {
  const manifestPath = await resolveArtifactManifestPath(artifactPath);
  if (manifestPath === null) {
    return {
      ok: false,
      mode: "artifact",
      input: artifactPath,
      errors: [{
        code: "invalid_artifact_manifest",
        message: "Cannot locate skill-suitcase-bundle.json"
      }]
    };
  }

  const parsed = await readJson(manifestPath);
  if (!isRecord(parsed)) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      errors: [{
        code: "invalid_artifact_manifest",
        message: `Invalid artifact manifest at ${manifestPath}`
      }]
    };
  }

  const manifest = parsed as ArtifactManifest;
  if (!isRecord(manifest.source) || !isNonEmptyString(manifest.source.repo)) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      errors: [{
        code: "invalid_artifact_manifest",
        message: `Invalid artifact manifest at ${manifestPath}`
      }]
    };
  }

  if (
    manifest.source.ref !== undefined
    && manifest.source.ref !== null
    && typeof manifest.source.ref !== "string"
  ) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      errors: [{
        code: "invalid_artifact_manifest",
        message: `Invalid artifact manifest at ${manifestPath}`
      }]
    };
  }

  if (
    manifest.source.commit !== undefined
    && manifest.source.commit !== null
    && typeof manifest.source.commit !== "string"
  ) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      errors: [{
        code: "invalid_artifact_manifest",
        message: `Invalid artifact manifest at ${manifestPath}`
      }]
    };
  }

  if (manifest.schema !== BUNDLE_SCHEMA) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      errors: [{
        code: "invalid_artifact_manifest",
        message: `Unsupported artifact schema ${manifest.schema}`
      }]
    };
  }

  if (manifest.target !== target) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      errors: [{
        code: "artifact_target_mismatch",
        message: `Artifact target ${manifest.target} does not match apply target ${target}`
      }]
    };
  }

  if (path.resolve(manifest.source.repo) !== path.resolve(source)) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      errors: [{
        code: "artifact_source_mismatch",
        message: `Artifact source ${manifest.source.repo} does not match apply source ${source}`
      }]
    };
  }

  if (Array.isArray(manifest.blocked) && manifest.blocked.length > 0) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      errors: [{
        code: "artifact_blocked",
        message: "Artifact includes blocked plan entries"
      }]
    };
  }

  if (!Array.isArray(manifest.planned) || manifest.planned.length === 0) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      errors: [{
        code: "artifact_missing_planned",
        message: "Artifact contains no planned skills"
      }]
    };
  }

  const approvedDestinations = new Map<string, string>();
  for (const planned of manifest.planned) {
    if (!isNonEmptyString(planned.skill)) {
      continue;
    }
    if (planned.destination !== undefined && !isNonEmptyString(planned.destination)) {
      return {
        ok: false,
        mode: "artifact",
        input: manifestPath,
        errors: [{
          code: "invalid_artifact_manifest",
          message: `Invalid destination metadata for ${planned.skill} in ${manifestPath}`
        }]
      };
    }
    approvedDestinations.set(planned.skill, planned.destination ?? planned.skill);
  }

  return {
    ok: true,
    mode: "artifact",
    input: manifestPath,
    sourceCommit: typeof manifest.source.commit === "string" ? manifest.source.commit : "",
    approvedSkills: manifest.planned
      .map((planned) => planned.skill)
      .filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0),
    approvedDestinations,
    approvedFileHashes: await validatedArtifactFileHashes({ manifest, manifestPath })
  };
}

export async function isApprovedDirtyBehindUpdate({
  statusItem,
  skillsWithWrites,
  diffEntriesBySkill,
  approvedSkills,
  approvedFileHashes,
  receipt,
  installRoot
}: {
  statusItem: DirtyBehindStatusItem;
  skillsWithWrites: Set<string>;
  diffEntriesBySkill: Map<string, ApprovalDiffEntry[]>;
  approvedSkills: Set<string>;
  approvedFileHashes: Map<string, Map<string, string>> | null;
  receipt: Receipt;
  installRoot: string;
}): Promise<boolean> {
  const installRecord = findReceiptInstallRecord({
    receipt,
    skillName: statusItem.skill,
    targetPath: statusItem.targetPath,
    installRoot
  });
  if (
    installRecord?.mode !== "copy"
    || statusItem.installedHash === null
    || statusItem.currentHash === null
    || statusItem.installedHash === statusItem.currentHash
    || !skillsWithWrites.has(statusItem.skill)
    || !approvedSkills.has(statusItem.skill)
    || approvedFileHashes === null
    || !(await isPathWithinRoot({ candidatePath: statusItem.targetPath, rootPath: installRoot }))
    || !(await isRealDirectory(statusItem.targetPath))
  ) {
    return false;
  }

  const skillEntries = diffEntriesBySkill.get(statusItem.skill) ?? [];
  return skillEntries.length > 0
    && skillEntries.every((entry) => entry.action === "create" || entry.action === "update" || entry.action === "unchanged")
    && skillEntries.some((entry) => entry.action === "create" || entry.action === "update")
    && await targetEntriesAreSafeForDirtyBehind({
      entries: skillEntries,
      installRecord,
      targetRoot: statusItem.targetPath,
      approvedFileHashes: approvedFileHashes.get(statusItem.skill) ?? null
    });
}

async function isRealDirectory(targetPath: string): Promise<boolean> {
  try {
    const info = await lstat(targetPath);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function targetEntriesAreSafeForDirtyBehind({
  entries,
  installRecord,
  targetRoot,
  approvedFileHashes
}: {
  entries: ApprovalDiffEntry[];
  installRecord: ReceiptInstallRecord;
  targetRoot: string;
  approvedFileHashes: Map<string, string> | null;
}): Promise<boolean> {
  const installedFiles = receiptInstalledFileHashes(installRecord.installedFiles);
  if (installedFiles === null || approvedFileHashes === null) {
    return false;
  }

  if (!(await receiptOwnedFilesStillMatch({ targetRoot, installedFiles }))) {
    return false;
  }

  for (const entry of entries) {
    const relativePath = typeof entry.relativePath === "string" ? entry.relativePath : null;
    const targetPath = typeof entry.targetPath === "string" ? entry.targetPath : null;

    if (relativePath === null || targetPath === null) {
      return false;
    }

    const expectedHash = installedFiles.get(relativePath);
    if (entry.action === "unchanged") {
      if (expectedHash === undefined) {
        return false;
      }
      continue;
    }

    if (!(await plannedWriteStaysInRealTarget({ targetRoot, targetPath }))) {
      return false;
    }

    const approvedHash = approvedFileHashes.get(relativePath);
    if (approvedHash === undefined) {
      return false;
    }
    const sourcePath = typeof entry.sourcePath === "string" ? entry.sourcePath : null;
    if (sourcePath === null || !(await sourceFileMatchesApprovedHash({ sourcePath, approvedHash }))) {
      return false;
    }

    if (entry.action === "create") {
      if (expectedHash !== undefined) {
        return false;
      }
      continue;
    }

    if (expectedHash === undefined) {
      return false;
    }

    let targetHash: string;
    try {
      targetHash = createHash("sha256").update(await readFile(targetPath)).digest("hex");
    } catch {
      return false;
    }

    if (targetHash !== expectedHash) {
      return false;
    }
  }

  return true;
}

async function plannedWriteStaysInRealTarget({
  targetRoot,
  targetPath
}: {
  targetRoot: string;
  targetPath: string;
}): Promise<boolean> {
  const resolvedTargetRoot = path.resolve(targetRoot);
  const resolvedTargetPath = path.resolve(targetPath);
  const relativePath = path.relative(resolvedTargetRoot, resolvedTargetPath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return false;
  }

  let candidatePath = resolvedTargetPath;
  while (true) {
    try {
      const info = await lstat(candidatePath);
      if (info.isSymbolicLink()) {
        return false;
      }
      return isPathWithinRoot({ candidatePath, rootPath: targetRoot });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        return false;
      }
    }

    const parentPath = path.dirname(candidatePath);
    if (parentPath === candidatePath) {
      return false;
    }
    candidatePath = parentPath;
  }
}

function receiptInstalledFileHashes(installedFiles: unknown): Map<string, string> | null {
  if (!Array.isArray(installedFiles) || installedFiles.length === 0) {
    return null;
  }

  const hashes = new Map<string, string>();
  for (const file of installedFiles) {
    if (!isReceiptInstalledFile(file)) {
      return null;
    }
    hashes.set(file.path, file.hash);
  }
  return hashes;
}

function fileHashesToMap(fileHashes: unknown): Map<string, Map<string, string>> | null {
  if (!isRecord(fileHashes)) {
    return null;
  }

  const result = new Map<string, Map<string, string>>();
  for (const [skill, hashes] of Object.entries(fileHashes)) {
    if (!isRecord(hashes)) {
      return null;
    }

    const skillHashes = new Map<string, string>();
    for (const [relativePath, hash] of Object.entries(hashes)) {
      if (typeof hash !== "string" || hash.trim().length === 0) {
        return null;
      }
      skillHashes.set(relativePath, hash);
    }
    result.set(skill, skillHashes);
  }
  return result;
}

async function validatedArtifactFileHashes({
  manifest,
  manifestPath
}: {
  manifest: ArtifactManifest;
  manifestPath: string;
}): Promise<Map<string, Map<string, string>> | null> {
  if (
    typeof manifest.artifactId !== "string"
    || manifest.artifactId.trim().length === 0
    || manifest.action !== "pack"
    || !Array.isArray(manifest.files)
  ) {
    return null;
  }

  const artifactRoot = path.dirname(manifestPath);
  if (path.basename(artifactRoot) !== manifest.artifactId) {
    return null;
  }

  const approvedHashes = fileHashesToMap(manifest.fileHashes);
  if (approvedHashes === null) {
    return null;
  }

  if (!matchesPackArtifactId(manifest.artifactId, {
    source: manifest.source,
    target: manifest.target,
    action: manifest.action,
    planned: manifest.planned,
    blocked: manifest.blocked ?? [],
    files: manifest.files,
    fileHashes: manifest.fileHashes,
    summary: manifest.summary
  })) {
    return null;
  }

  const filesSeen = new Set<string>();
  for (const file of manifest.files) {
    if (!isArtifactFileRecord(file)) {
      return null;
    }

    const skillHashes = approvedHashes.get(file.skill);
    if (skillHashes?.get(file.relativePath) !== file.sha256) {
      return null;
    }

    const bundlePath = path.join(artifactRoot, file.bundlePath);
    if (!(await isPathWithinRoot({ candidatePath: bundlePath, rootPath: artifactRoot }))) {
      return null;
    }

    let bundleHash: string;
    try {
      bundleHash = createHash("sha256").update(await readFile(bundlePath)).digest("hex");
    } catch {
      return null;
    }
    if (bundleHash !== file.sha256) {
      return null;
    }
    filesSeen.add(`${file.skill}\0${file.relativePath}`);
  }

  for (const [skill, hashes] of approvedHashes) {
    for (const relativePath of hashes.keys()) {
      if (!filesSeen.has(`${skill}\0${relativePath}`)) {
        return null;
      }
    }
  }

  return approvedHashes;
}

async function sourceFileMatchesApprovedHash({
  sourcePath,
  approvedHash
}: {
  sourcePath: string;
  approvedHash: string;
}): Promise<boolean> {
  try {
    const sourceHash = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    return sourceHash === approvedHash;
  } catch {
    return false;
  }
}

async function receiptOwnedFilesStillMatch({
  targetRoot,
  installedFiles
}: {
  targetRoot: string;
  installedFiles: Map<string, string>;
}): Promise<boolean> {
  for (const [relativePath, expectedHash] of installedFiles) {
    const targetPath = path.join(targetRoot, relativePath);
    if (!(await plannedWriteStaysInRealTarget({ targetRoot, targetPath }))) {
      return false;
    }

    let info;
    try {
      info = await lstat(targetPath);
    } catch {
      return false;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      return false;
    }

    let targetHash: string;
    try {
      targetHash = createHash("sha256").update(await readFile(targetPath)).digest("hex");
    } catch {
      return false;
    }
    if (targetHash !== expectedHash) {
      return false;
    }
  }
  return true;
}

function isReceiptInstalledFile(file: unknown): file is ReceiptInstalledFile {
  return file !== null
    && typeof file === "object"
    && typeof (file as { path?: unknown }).path === "string"
    && typeof (file as { hash?: unknown }).hash === "string";
}

function isArtifactFileRecord(file: unknown): file is NonNullable<ArtifactManifest["files"]>[number] {
  return file !== null
    && typeof file === "object"
    && typeof (file as { skill?: unknown }).skill === "string"
    && typeof (file as { relativePath?: unknown }).relativePath === "string"
    && typeof (file as { bundlePath?: unknown }).bundlePath === "string"
    && typeof (file as { sha256?: unknown }).sha256 === "string";
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function resolveArtifactManifestPath(candidate: string | null): Promise<string | null> {
  if (!hasText(candidate)) {
    return null;
  }

  const asPath = path.resolve(candidate);
  if ((await statSafe(asPath))?.isFile() && path.basename(asPath) === BUNDLE_FILE) {
    return asPath;
  }

  const inArtifacts = path.join(asPath, ".skill-suitcase", "artifacts", BUNDLE_FILE);
  if ((await statSafe(inArtifacts))?.isFile()) {
    return inArtifacts;
  }

  const plainManifest = path.join(asPath, BUNDLE_FILE);
  if ((await statSafe(plainManifest))?.isFile()) {
    return plainManifest;
  }

  return null;
}

function isPlanLock(value: unknown): value is PlanLockManifest {
  if (!isRecord(value)) {
    return false;
  }

  if (value.schema !== PLAN_LOCK_SCHEMA) {
    return false;
  }

  if (!isNonEmptyString(value.target)) {
    return false;
  }

  const source = value.source;
  if (!isRecord(source)) {
    return false;
  }

  if (!isNonEmptyString(source.repo)) {
    return false;
  }

  if (!Array.isArray(value.selectedSkills)) {
    return false;
  }

  if (source.commit !== null && source.commit !== undefined && !isString(source.commit)) {
    return false;
  }

  if (source.ref !== null && source.ref !== undefined && !isString(source.ref)) {
    return false;
  }

  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: string | null | undefined): value is string {
  return isNonEmptyString(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

async function statSafe(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await stat(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}
