import path from "node:path";
import type { Receipt, ReceiptInstallRecord } from "../receipts/index.js";

/**
 * Receipt install-record lookup shared by apply's approval-context checks and
 * its symlink receipt refresh. Records may store target/source paths as
 * absolute or install-root-relative strings, so lookups normalize both sides
 * before comparing.
 */
export function findReceiptInstallRecord({
  receipt,
  skillName,
  targetPath,
  installRoot
}: {
  receipt: Receipt;
  skillName: string;
  targetPath: string;
  installRoot: string;
}): ReceiptInstallRecord | null {
  const entry = receipt.installs?.[skillName];
  const records = Array.isArray(entry) ? entry : entry === undefined ? [] : [entry];
  const normalizedTarget = path.resolve(targetPath);
  return records.find((record) => normalizeTargetPathForInstallRoot(record.targetPath, installRoot) === normalizedTarget) ?? null;
}

export function normalizeTargetPathForInstallRoot(value: unknown, installRoot: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(installRoot, value);
}

export function normalizeSymlinkRecordSourcePath(record: ReceiptInstallRecord): string | null {
  if (typeof record.sourcePath === "string" && record.sourcePath.trim().length > 0) {
    return record.sourcePath;
  }
  if (isRecord(record.source) && typeof record.source.path === "string" && record.source.path.trim().length > 0) {
    return record.source.path;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
