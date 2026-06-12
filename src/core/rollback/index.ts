import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildInstalledFiles,
  RECEIPT_FILE,
  RECEIPT_SCHEMA,
  type Receipt,
  type ReceiptInstallRecord
} from "../receipts/index.js";

type RollbackInput = {
  receipt: string;
};

type RollbackError = {
  code: string;
  message: string;
  skill?: string;
  path?: string;
};

type RollbackResultItem = {
  skill: string;
  targetPath: string | null;
  status: "restored" | "noop" | "refused" | "partial";
  restored: number;
  removed: number;
  failed: number;
};

export type RollbackResult = {
  ok: boolean;
  receipt: string;
  installRoot: string;
  summary: {
    restored: number;
    removed: number;
    noop: number;
    failed: number;
    refused: number;
  };
  rollbacks: RollbackResultItem[];
  errors: RollbackError[];
};

type RollbackState = {
  schema?: unknown;
  status?: unknown;
  targetPath?: unknown;
  files?: unknown;
  appliedFiles?: unknown;
};

type RollbackFileRecord = {
  path: string;
  targetPath: string;
  previous: {
    kind: "file";
    sha256?: string;
    bytes: string;
  } | {
    kind: "missing";
  } | {
    kind: "restore-impossible";
    reason?: string;
  };
};

type InstalledFile = {
  path: string;
  hash: string;
};

type CollectRecordsResult = {
  records: Array<{ skill: string; record: ReceiptInstallRecord }>;
  errors: Array<{ skill: string; message: string }>;
};

type RollbackParseResult = {
  kind: "none";
} | {
  kind: "invalid";
  targetPath: string | null;
  message: string;
} | {
  kind: "valid";
  state: {
    raw: RollbackState;
    status: "available" | "rolled-back";
    targetPath: string;
    files: RollbackFileRecord[];
    appliedFiles: InstalledFile[];
  };
};

export async function rollback({ receipt }: RollbackInput): Promise<RollbackResult> {
  if (!receipt) {
    throw new Error("receipt is required");
  }

  const receiptPath = await resolveReceiptPath(receipt);
  const installRoot = path.dirname(receiptPath);
  const result: RollbackResult = {
    ok: true,
    receipt: receiptPath,
    installRoot,
    summary: {
      restored: 0,
      removed: 0,
      noop: 0,
      failed: 0,
      refused: 0
    },
    rollbacks: [],
    errors: []
  };

  const receiptPayload = await readReceipt(receiptPath);
  const installs = receiptPayload.installs;
  if (!isRecord(installs)) {
    result.ok = false;
    result.errors.push({ code: "invalid_receipt", message: "Receipt installs must be an object." });
    return result;
  }

  let changedReceipt = false;
  const collected = collectRecords(installs);
  for (const error of collected.errors) {
    result.ok = false;
    result.summary.refused += 1;
    result.errors.push({
      code: "invalid_receipt",
      message: `Invalid install record for ${error.skill}: ${error.message}`,
      skill: error.skill
    });
    result.rollbacks.push({
      skill: error.skill,
      targetPath: null,
      status: "refused",
      restored: 0,
      removed: 0,
      failed: 0
    });
  }

  const records = collected.records;
  records.sort((left, right) => left.skill.localeCompare(right.skill));

  for (const { skill, record } of records) {
    const parsedRollback = normalizeRollback(record.rollback, installRoot);
    if (parsedRollback.kind === "none") {
      result.summary.noop += 1;
      result.rollbacks.push({
        skill,
        targetPath: normalizeString(record.targetPath),
        status: "noop",
        restored: 0,
        removed: 0,
        failed: 0
      });
      continue;
    }
    if (parsedRollback.kind === "invalid") {
      result.ok = false;
      result.summary.refused += 1;
      result.errors.push({
        code: "invalid_receipt",
        message: `Invalid rollback state for ${skill}: ${parsedRollback.message}`,
        skill,
        ...(parsedRollback.targetPath === null ? {} : { path: parsedRollback.targetPath })
      });
      result.rollbacks.push({
        skill,
        targetPath: parsedRollback.targetPath,
        status: "refused",
        restored: 0,
        removed: 0,
        failed: 0
      });
      continue;
    }

    const rollbackState = parsedRollback.state;
    const targetPath = rollbackState.targetPath;
    if (rollbackState.status === "rolled-back") {
      result.summary.noop += 1;
      result.rollbacks.push({
        skill,
        targetPath,
        status: "noop",
        restored: 0,
        removed: 0,
        failed: 0
      });
      continue;
    }

    if (!(await targetRootIsRealDirectoryUnderInstallRoot(installRoot, targetPath))
      || !(await rollbackFilePathsStayInRealTarget(targetPath, rollbackState.files))
      || !(await appliedStateMatches(targetPath, rollbackState.appliedFiles))) {
      result.ok = false;
      result.summary.refused += 1;
      result.errors.push({
        code: "target_drift",
        message: `Target ${targetPath} differs from the applied receipt state.`,
        skill,
        path: targetPath
      });
      result.rollbacks.push({
        skill,
        targetPath,
        status: "refused",
        restored: 0,
        removed: 0,
        failed: 0
      });
      continue;
    }

    const item: RollbackResultItem = {
      skill,
      targetPath,
      status: "restored",
      restored: 0,
      removed: 0,
      failed: 0
    };

    for (const file of rollbackState.files) {
      const restored = await restoreRollbackFile(file);
      if (restored.status === "restored") {
        item.restored += 1;
        result.summary.restored += 1;
        continue;
      }
      if (restored.status === "removed") {
        item.removed += 1;
        result.summary.removed += 1;
        continue;
      }
      item.failed += 1;
      result.summary.failed += 1;
      result.errors.push({
        code: restored.code,
        message: restored.message,
        skill,
        path: file.targetPath
      });
    }

    if (item.failed > 0) {
      item.status = item.restored > 0 || item.removed > 0 ? "partial" : "refused";
      result.ok = false;
    } else {
      const restoredMetadata = await buildRestoredInstallMetadata(targetPath, record);
      record.installedFiles = restoredMetadata.installedFiles;
      if (restoredMetadata.sourceHash === null) {
        delete record.sourceHash;
      } else {
        record.sourceHash = restoredMetadata.sourceHash;
      }
      if (restoredMetadata.version === null) {
        delete record.version;
      } else {
        record.version = restoredMetadata.version;
      }
      if (restoredMetadata.sourceCommit === null) {
        delete record.sourceCommit;
      } else {
        record.sourceCommit = restoredMetadata.sourceCommit;
      }
      record.rollback = {
        ...rollbackState.raw,
        status: "rolled-back"
      };
      changedReceipt = true;
    }
    result.rollbacks.push(item);
  }

  if (changedReceipt) {
    await writeFile(receiptPath, `${JSON.stringify(receiptPayload, null, 2)}\n`, "utf8");
  }

  if (result.errors.length > 0) {
    result.ok = false;
  }
  return result;
}

async function resolveReceiptPath(receipt: string): Promise<string> {
  const candidate = path.resolve(receipt);
  const info = await stat(candidate).catch(() => null);
  if (info?.isDirectory()) {
    return path.join(candidate, RECEIPT_FILE);
  }
  return candidate;
}

async function readReceipt(receiptPath: string): Promise<Receipt> {
  const text = await readFile(receiptPath, "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || parsed.schema !== RECEIPT_SCHEMA) {
    throw new Error(`Receipt ${receiptPath} has an unsupported schema.`);
  }
  return parsed as Receipt;
}

function collectRecords(installs: Record<string, unknown>): CollectRecordsResult {
  const records: Array<{ skill: string; record: ReceiptInstallRecord }> = [];
  const errors: Array<{ skill: string; message: string }> = [];
  for (const [skill, value] of Object.entries(installs)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (isRecord(entry)) {
        records.push({ skill, record: entry as ReceiptInstallRecord });
        continue;
      }
      errors.push({ skill, message: "install entries must be objects." });
    }
  }
  return { records, errors };
}

function normalizeRollback(value: unknown, installRoot: string): RollbackParseResult {
  if (!isRecord(value)) {
    return { kind: "none" };
  }
  const raw = value as RollbackState;
  if (raw.schema !== "calvinnwq.skills.rollback.v0") {
    return { kind: "none" };
  }
  const targetPathValue = normalizeString(raw.targetPath);
  if (targetPathValue === null) {
    return { kind: "invalid", targetPath: null, message: "rollback targetPath must be a non-empty string." };
  }
  const targetPath = resolveReceiptPathUnderRoot(installRoot, targetPathValue);
  if (targetPath === null) {
    return {
      kind: "invalid",
      targetPath: path.resolve(targetPathValue),
      message: "rollback targetPath must stay within the receipt install root."
    };
  }
  if (raw.status !== "available" && raw.status !== "rolled-back") {
    return { kind: "invalid", targetPath, message: "rollback status must be available or rolled-back." };
  }
  if (!Array.isArray(raw.files)) {
    return { kind: "invalid", targetPath, message: "rollback files must be an array." };
  }
  if (!Array.isArray(raw.appliedFiles)) {
    return { kind: "invalid", targetPath, message: "rollback appliedFiles must be an array." };
  }

  const files: RollbackFileRecord[] = [];
  for (const file of raw.files) {
    const normalized = normalizeRollbackFile(file, targetPath);
    if (normalized.kind === "invalid") {
      return { kind: "invalid", targetPath, message: normalized.message };
    }
    files.push(normalized.file);
  }

  const appliedFiles: InstalledFile[] = [];
  for (const file of raw.appliedFiles) {
    const normalized = normalizeInstalledFile(file);
    if (normalized.kind === "invalid") {
      return { kind: "invalid", targetPath, message: normalized.message };
    }
    appliedFiles.push(normalized.file);
  }

  return {
    kind: "valid",
    state: {
      raw,
      status: raw.status,
      targetPath,
      files,
      appliedFiles
    }
  };
}

function normalizeRollbackFile(value: unknown, targetRoot: string): {
  kind: "valid";
  file: RollbackFileRecord;
} | {
  kind: "invalid";
  message: string;
} {
  if (!isRecord(value)) {
    return { kind: "invalid", message: "rollback files entries must be objects." };
  }
  const relativePath = normalizeRelativePath(value.path);
  if (relativePath === null) {
    return { kind: "invalid", message: "rollback file path must be a relative path within the target." };
  }
  const targetPath = resolveRelativePath(targetRoot, relativePath);
  const recordedTargetPathValue = normalizeString(value.targetPath);
  if (recordedTargetPathValue === null) {
    return { kind: "invalid", message: "rollback file targetPath must be a non-empty string." };
  }
  const recordedTargetPath = resolveReceiptPathUnderRoot(targetRoot, recordedTargetPathValue);
  if (recordedTargetPath === null || recordedTargetPath !== targetPath) {
    return { kind: "invalid", message: `rollback file targetPath for ${relativePath} must match the target-relative path.` };
  }
  if (!isRecord(value.previous)) {
    return { kind: "invalid", message: `rollback file ${relativePath} must include previous state.` };
  }
  const previous = value.previous;
  if (previous.kind === "file" && typeof previous.bytes === "string") {
    return {
      kind: "valid",
      file: {
        path: relativePath,
        targetPath,
        previous: {
          kind: "file",
          bytes: previous.bytes,
          ...(typeof previous.sha256 === "string" ? { sha256: previous.sha256 } : {})
        }
      }
    };
  }
  if (previous.kind === "missing") {
    return {
      kind: "valid",
      file: {
        path: relativePath,
        targetPath,
        previous: { kind: "missing" }
      }
    };
  }
  if (previous.kind === "restore-impossible") {
    return {
      kind: "valid",
      file: {
        path: relativePath,
        targetPath,
        previous: {
          kind: "restore-impossible",
          ...(typeof previous.reason === "string" ? { reason: previous.reason } : {})
        }
      }
    };
  }
  return { kind: "invalid", message: `rollback file ${relativePath} has invalid previous state.` };
}

function normalizeInstalledFile(value: unknown): {
  kind: "valid";
  file: InstalledFile;
} | {
  kind: "invalid";
  message: string;
} {
  if (!isRecord(value)) {
    return { kind: "invalid", message: "rollback appliedFiles entries must be objects." };
  }
  const relativePath = normalizeRelativePath(value.path);
  if (relativePath === null || typeof value.hash !== "string" || value.hash.trim().length === 0) {
    return { kind: "invalid", message: "rollback appliedFiles entries must include relative path and hash strings." };
  }
  return {
    kind: "valid",
    file: {
      path: relativePath,
      hash: value.hash
    }
  };
}

async function appliedStateMatches(targetPath: string, appliedFiles: InstalledFile[]): Promise<boolean> {
  let currentFiles: Array<{ path: string; hash: string }>;
  try {
    currentFiles = await buildInstalledFiles(targetPath);
  } catch {
    return false;
  }
  const current = new Map(currentFiles.map((file) => [file.path, file.hash]));
  const expected = new Map<string, string>();
  for (const file of appliedFiles) {
    if (typeof file.path === "string" && typeof file.hash === "string") {
      expected.set(file.path, file.hash);
    }
  }
  if (current.size !== expected.size) {
    return false;
  }
  for (const [filePath, hash] of expected) {
    if (current.get(filePath) !== hash) {
      return false;
    }
  }
  return true;
}

async function targetRootIsRealDirectoryUnderInstallRoot(installRoot: string, targetPath: string): Promise<boolean> {
  try {
    const targetInfo = await lstat(targetPath);
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
      return false;
    }
    const [resolvedInstallRoot, resolvedTargetPath] = await Promise.all([
      realpath(installRoot),
      realpath(targetPath)
    ]);
    return isPathInsideOrSame(resolvedInstallRoot, resolvedTargetPath);
  } catch {
    return false;
  }
}

async function rollbackFilePathsStayInRealTarget(targetRoot: string, files: RollbackFileRecord[]): Promise<boolean> {
  for (const file of files) {
    if (!isPathInsideOrSame(targetRoot, file.targetPath) || await pathHasSymlinkComponent(targetRoot, file.targetPath)) {
      return false;
    }
  }
  return true;
}

async function pathHasSymlinkComponent(root: string, targetPath: string): Promise<boolean> {
  const relativePath = path.relative(path.resolve(root), path.resolve(targetPath));
  if (relativePath === "") {
    return false;
  }

  const parts = relativePath.split(path.sep).filter((part) => part.length > 0);
  let currentPath = path.resolve(root);
  for (const part of parts) {
    currentPath = path.join(currentPath, part);
    try {
      if ((await lstat(currentPath)).isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        continue;
      }
      return true;
    }
  }
  return false;
}

async function buildRestoredInstallMetadata(
  targetPath: string,
  record: ReceiptInstallRecord
): Promise<{ installedFiles: InstalledFile[]; sourceHash: string | null; version: string | null; sourceCommit: string | null }> {
  const installedFiles = await buildInstalledFiles(targetPath).catch(() => []);
  return {
    installedFiles,
    sourceHash: await hashDirectory(targetPath).catch(() => null),
    version: await restoredVersion(targetPath, record),
    sourceCommit: restoredStringFromPriorState(record.priorState, "installedCommit")
  };
}

async function restoredVersion(targetPath: string, record: ReceiptInstallRecord): Promise<string | null> {
  const version = await readSkillVersion(targetPath).catch(() => null);
  return version ?? restoredStringFromPriorState(record.priorState, "installedVersion");
}

async function readSkillVersion(targetPath: string): Promise<string | null> {
  const text = await readFile(path.join(targetPath, "SKILL.md"), "utf8");
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    return null;
  }
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "---") {
      break;
    }
    if (trimmed.startsWith("version:")) {
      const version = trimmed.slice("version:".length).trim();
      return version.length > 0 ? version : null;
    }
  }
  return null;
}

function restoredStringFromPriorState(priorState: unknown, key: string): string | null {
  if (!isRecord(priorState)) {
    return null;
  }
  const value = priorState[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

async function hashDirectory(root: string): Promise<string> {
  const files = await listFiles(root);
  const digest = createHash("sha256");
  for (const relativePath of files) {
    const bytes = await readFile(path.join(root, relativePath));
    digest.update(relativePath);
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      continue;
    }
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)).map((item) => path.join(entry.name, item)));
      continue;
    }
    if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files.sort();
}

async function restoreRollbackFile(file: RollbackFileRecord): Promise<
  | { status: "restored" }
  | { status: "removed" }
  | { status: "failed"; code: string; message: string }
> {
  if (file.previous.kind === "restore-impossible") {
    return {
      status: "failed",
      code: "restore_impossible",
      message: file.previous.reason ?? "Previous target state cannot be restored."
    };
  }

  if (file.previous.kind === "missing") {
    return removeRollbackTarget(file);
  }

  const bytes = Buffer.from(file.previous.bytes, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (file.previous.sha256 !== undefined && sha256 !== file.previous.sha256) {
    return {
      status: "failed",
      code: "rollback_record_invalid",
      message: `Stored rollback bytes for ${file.path} do not match their digest.`
    };
  }
  try {
    await mkdir(path.dirname(file.targetPath), { recursive: true });
    await writeFile(file.targetPath, bytes);
  } catch (error) {
    return {
      status: "failed",
      code: "restore_write_failed",
      message: `Failed to restore ${file.path}: ${errorMessage(error)}`
    };
  }
  return { status: "restored" };
}

async function removeRollbackTarget(file: RollbackFileRecord): Promise<
  | { status: "removed" }
  | { status: "failed"; code: string; message: string }
> {
  try {
    await unlink(file.targetPath);
    return { status: "removed" };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { status: "removed" };
    }
    if (isNodeError(error) && error.code === "EISDIR") {
      try {
        await rm(file.targetPath, { recursive: true, force: true });
        return { status: "removed" };
      } catch (rmError) {
        return {
          status: "failed",
          code: "rollback_remove_failed",
          message: `Failed to remove ${file.path}: ${errorMessage(rmError)}`
        };
      }
    }
    return {
      status: "failed",
      code: "rollback_remove_failed",
      message: `Failed to remove ${file.path}: ${errorMessage(error)}`
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") ? value : null;
}

function normalizeRelativePath(value: unknown): string | null {
  const candidate = normalizeString(value);
  if (candidate === null || path.isAbsolute(candidate)) {
    return null;
  }
  const normalized = path.normalize(candidate);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function resolveReceiptPathUnderRoot(root: string, candidate: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(resolvedRoot, candidate);
  return isPathInsideOrSame(resolvedRoot, resolvedCandidate) ? resolvedCandidate : null;
}

function resolveRelativePath(root: string, relativePath: string): string {
  return path.resolve(path.resolve(root), relativePath);
}

function isPathInsideOrSame(root: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
