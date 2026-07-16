import { realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  RECEIPT_FILE,
  RECEIPT_SCHEMA,
  type Receipt,
  type ReceiptInstallRecord
} from "../receipts/index.js";

/**
 * Receipt loading and rollback-record normalization for rollback.
 *
 * Everything in this module treats receipt content as untrusted input: it
 * resolves the receipt file and install root, validates the receipt JSON,
 * collects supported install records, parses copy and symlink rollback state,
 * and resolves receipt-relative paths while rejecting escapes from the install
 * root. It reads the filesystem only to resolve paths and never mutates it.
 * The executor in index.ts consumes the normalized models returned here and
 * must not reinterpret raw receipt JSON.
 */

/**
 * Schema marker apply --mode symlink writes into a symlink receipt's `rollback`
 * field. Rollback only reverses links Suitcase created (created:true); see
 * parseAppliedSymlinkRollback.
 */
const SYMLINK_ROLLBACK_SCHEMA = "calvinnwq.skills.symlink-rollback.v0";

export type AppliedSymlinkRollback =
  | { kind: "apply-created"; targetPath: string; expectedSourcePath: string }
  | { kind: "none" };

export type RollbackState = {
  schema?: unknown;
  status?: unknown;
  targetPath?: unknown;
  backupPath?: unknown;
  files?: unknown;
  appliedFiles?: unknown;
};

export type RollbackFileRecord = {
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

export type InstalledFile = {
  path: string;
  hash: string;
};

export type CollectRecordsResult = {
  records: Array<{ skill: string; record: ReceiptInstallRecord }>;
  errors: Array<{ skill: string; message: string }>;
};

export type RollbackParseResult = {
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
    backupPath: string | null;
    files: RollbackFileRecord[];
    appliedFiles: InstalledFile[];
  };
};

export async function resolveReceiptInstallRoot(receiptDirectory: string): Promise<string> {
  try {
    return await realpath(receiptDirectory);
  } catch {
    return receiptDirectory;
  }
}

export async function resolveReceiptPath(receipt: string): Promise<string> {
  const candidate = path.resolve(receipt);
  const info = await stat(candidate).catch(() => null);
  if (info?.isDirectory()) {
    return path.join(candidate, RECEIPT_FILE);
  }
  return candidate;
}

export async function readReceipt(receiptPath: string): Promise<Receipt> {
  const text = await readFile(receiptPath, "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || parsed.schema !== RECEIPT_SCHEMA) {
    throw new Error(`Receipt ${receiptPath} has an unsupported schema.`);
  }
  return parsed as Receipt;
}

export function collectRecords(installs: Record<string, unknown>): CollectRecordsResult {
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

/**
 * Recognize the symlink-rollback state apply --mode symlink writes for a link it
 * created. Returns "apply-created" only when the receipt explicitly records a
 * Suitcase-created link that has not already been rolled back. Track-adopted
 * links (no rollback field), apply-refreshed links (created:false), and
 * already-rolled-back links all return "none" so rollback leaves them alone.
 */
export function parseAppliedSymlinkRollback(
  record: ReceiptInstallRecord,
  installRoot: string,
  receiptDirectory: string
): AppliedSymlinkRollback {
  const rollback = record.rollback;
  if (!isRecord(rollback) || rollback.schema !== SYMLINK_ROLLBACK_SCHEMA) {
    return { kind: "none" };
  }
  if (rollback.status !== "available" || rollback.created !== true) {
    return { kind: "none" };
  }
  const targetPathValue = normalizeString(rollback.targetPath) ?? normalizeString(record.targetPath);
  if (targetPathValue === null) {
    return { kind: "none" };
  }
  const targetPath = resolveReceiptPathUnderRoot(installRoot, targetPathValue, receiptDirectory);
  if (targetPath === null) {
    return { kind: "none" };
  }
  const expectedSourcePath = symlinkRecordSourcePath(record);
  if (expectedSourcePath === null) {
    return { kind: "none" };
  }
  return { kind: "apply-created", targetPath, expectedSourcePath };
}

function symlinkRecordSourcePath(record: ReceiptInstallRecord): string | null {
  const direct = normalizeString(record.sourcePath);
  if (direct !== null) {
    return direct;
  }
  const source = record.source;
  if (isRecord(source)) {
    return normalizeString(source.path);
  }
  return null;
}

/**
 * Parse the copy-mode rollback state on an install record. A record without a
 * rollback field has nothing to reverse and parses as "none"; a present value
 * is normalized by normalizeRollback.
 */
export function parseCopyRollback(
  record: ReceiptInstallRecord,
  installRoot: string,
  receiptDirectory: string
): RollbackParseResult {
  if (!hasOwn(record, "rollback")) {
    return { kind: "none" };
  }
  return normalizeRollback(record.rollback, installRoot, receiptDirectory);
}

function normalizeRollback(value: unknown, installRoot: string, receiptDirectory: string): RollbackParseResult {
  if (!isRecord(value)) {
    return { kind: "invalid", targetPath: null, message: "rollback state must be an object." };
  }
  const raw = value as RollbackState;
  if (raw.schema !== "calvinnwq.skills.rollback.v0") {
    return { kind: "none" };
  }
  const targetPathValue = normalizeString(raw.targetPath);
  if (targetPathValue === null) {
    return { kind: "invalid", targetPath: null, message: "rollback targetPath must be a non-empty string." };
  }
  const targetPath = resolveReceiptPathUnderRoot(installRoot, targetPathValue, receiptDirectory);
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
  let backupPath: string | null = null;
  if (raw.backupPath !== undefined) {
    const backupPathValue = normalizeString(raw.backupPath);
    if (backupPathValue === null) {
      return { kind: "invalid", targetPath, message: "rollback backupPath must be a non-empty string." };
    }
    backupPath = resolveReceiptPathUnderRoot(installRoot, backupPathValue, receiptDirectory);
    if (backupPath === null || path.resolve(backupPath) === path.resolve(installRoot)) {
      return { kind: "invalid", targetPath, message: "rollback backupPath must stay within the receipt install root." };
    }
  }

  const files: RollbackFileRecord[] = [];
  const targetAliasRoot = path.isAbsolute(targetPathValue)
    ? path.resolve(targetPathValue)
    : path.resolve(receiptDirectory, targetPathValue);
  for (const file of raw.files) {
    const normalized = normalizeRollbackFile(file, targetPath, targetAliasRoot);
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
      backupPath,
      files,
      appliedFiles
    }
  };
}

function normalizeRollbackFile(value: unknown, targetRoot: string, targetAliasRoot: string): {
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
  const recordedTargetPath = resolveReceiptPathUnderRoot(targetRoot, recordedTargetPathValue, targetAliasRoot);
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizeString(value: unknown): string | null {
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

function resolveReceiptPathUnderRoot(root: string, candidate: string, aliasRoot: string = root): string | null {
  const resolvedRoot = path.resolve(root);
  const resolvedAliasRoot = path.resolve(aliasRoot);
  const resolvedCandidate = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(resolvedAliasRoot, candidate);
  if (isPathInsideOrSame(resolvedRoot, resolvedCandidate)) {
    return resolvedCandidate;
  }
  if (isPathInsideOrSame(resolvedAliasRoot, resolvedCandidate)) {
    return path.resolve(resolvedRoot, path.relative(resolvedAliasRoot, resolvedCandidate));
  }
  try {
    const canonicalParent = realpathSync(path.dirname(resolvedCandidate));
    const canonicalCandidate = path.join(canonicalParent, path.basename(resolvedCandidate));
    if (isPathInsideOrSame(resolvedRoot, canonicalCandidate)) {
      return canonicalCandidate;
    }
  } catch {
  }
  return null;
}

function resolveRelativePath(root: string, relativePath: string): string {
  return path.resolve(path.resolve(root), relativePath);
}

export function isPathInsideOrSame(root: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
