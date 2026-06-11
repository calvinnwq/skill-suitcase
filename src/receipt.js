import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const RECEIPT_SCHEMA = "calvinnwq.skills.receipt.v0";
export const RECEIPT_FILE = ".skill-suitcase-receipt.json";
export const LEGACY_RECEIPT_SCHEMA = "calvinnwq.skills.sync-lock.v0";
export const LEGACY_RECEIPT_FILE = ".skills-sync.json";

export async function buildInstalledFiles(skillRoot) {
  const root = path.resolve(skillRoot);
  const files = await collectInstalledFiles(root, root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function writeReceipt({ installRoot, receipt, receiptPath = RECEIPT_FILE }) {
  if (!isRecord(receipt)) {
    throw new Error("Receipt payload must be an object.");
  }

  const normalizedRoot = normalizeInstallRoot(installRoot);
  const outputPath = resolveReceiptPath({ installRoot: normalizedRoot, receiptPath });
  await mkdir(normalizedRoot, { recursive: true });

  const payload = normalizeReceiptPayload(receipt);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outputPath;
}

export async function upsertAndWriteReceipt({
  installRoot,
  receipt,
  skillName,
  installRecord,
  receiptPath = RECEIPT_FILE
}) {
  const normalizedRoot = normalizeInstallRoot(installRoot);
  const outputPath = resolveReceiptPath({ installRoot: normalizedRoot, receiptPath });

  if (typeof skillName !== "string" || skillName.trim().length === 0) {
    throw new Error("skillName is required.");
  }

  if (!isRecord(installRecord)) {
    throw new Error("installRecord must be an object.");
  }

  const currentReceipt = receipt === undefined ? await readReceiptForUpsert(outputPath) : receipt;
  if (!isRecord(currentReceipt)) {
    throw new Error("Receipt payload must be an object.");
  }

  const normalizedTargetPath = normalizeTargetPathForInstallRoot({
    installRoot: normalizedRoot,
    targetPath: installRecord.targetPath
  });
  const nextInstallRecord = normalizedTargetPath
    ? { ...installRecord, targetPath: normalizedTargetPath }
    : installRecord;

  const nextReceipt = upsertInstallRecord({
    ...currentReceipt,
    installs: cloneReceiptInstalls(currentReceipt)
  }, {
    skillName,
    installRecord: nextInstallRecord
  });
  return writeReceipt({ installRoot: normalizedRoot, receipt: nextReceipt, receiptPath });
}

async function readReceiptForUpsert(receiptPath) {
  try {
    const text = await readFile(receiptPath, "utf8");
    const receipt = JSON.parse(text);
    if (!isRecord(receipt)) {
      throw new Error("Receipt payload must be an object.");
    }
    return receipt;
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Receipt ${receiptPath} must be valid JSON.`);
    }
    throw error;
  }
}

function normalizeInstallRoot(installRoot) {
  if (typeof installRoot !== "string" || installRoot.trim().length === 0) {
    throw new Error("installRoot is required.");
  }
  return path.resolve(installRoot);
}

function resolveReceiptPath({ installRoot, receiptPath }) {
  if (typeof receiptPath !== "string" || receiptPath.trim().length === 0) {
    throw new Error("receiptPath must be a non-empty string.");
  }

  const outputPath = path.resolve(installRoot, receiptPath);
  const relativePath = path.relative(installRoot, outputPath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("receiptPath must stay within installRoot.");
  }
  return outputPath;
}

function cloneReceiptInstalls(receipt) {
  if (receipt.installs === undefined) {
    return {};
  }
  if (!isRecord(receipt.installs)) {
    throw new Error("Receipt installs must be an object.");
  }
  return { ...receipt.installs };
}

async function collectInstalledFiles(root, baseRoot) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      continue;
    }

    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectInstalledFiles(entryPath, baseRoot)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const content = await readFile(entryPath);
    files.push({
      path: path.relative(baseRoot, entryPath),
      hash: createHash("sha256").update(content).digest("hex")
    });
  }

  return files;
}

export function buildReceipt({ sourceRoot, sourceCommit = null, sourceRef = null, installs = {} }) {
  return {
    schema: RECEIPT_SCHEMA,
    source: {
      repo: sourceRoot,
      ref: sourceRef,
      commit: sourceCommit
    },
    installs
  };
}

export function buildInstallRecord({
  skill,
  agent,
  mode,
  target,
  source,
  sourcePath,
  targetPath,
  version,
  sourceCommit,
  sourceHash,
  installedFiles,
  priorState
}) {
  const record = {
    agent,
    mode,
    target,
    targetPath,
    version
  };

  if (source !== undefined) {
    record.source = source;
  }

  if (sourcePath !== undefined) {
    record.sourcePath = sourcePath;
  }

  if (skill !== undefined) {
    record.skill = skill;
  }

  if (sourceCommit !== undefined) {
    record.sourceCommit = sourceCommit;
  }

  if (sourceHash !== undefined) {
    record.sourceHash = sourceHash;
  }

  if (Array.isArray(installedFiles)) {
    record.installedFiles = installedFiles;
  }

  if (priorState !== undefined && priorState !== null && typeof priorState === "object") {
    record.priorState = priorState;
  }

  return record;
}

export function upsertInstallRecord(receipt, { skillName, installRecord }) {
  if (typeof skillName !== "string" || skillName.trim().length === 0) {
    throw new Error("skillName is required.");
  }

  assertReceiptInstallRecord(installRecord);

  const existing = receipt?.installs?.[skillName];
  const installs = { ...(receipt?.installs ?? {}) };
  const targetPath = installRecord?.targetPath;
  const normalizedTargetPath = normalizeTargetPath(targetPath);
  const existingArray = Array.isArray(existing) ? existing : existing ? [existing] : [];
  if (existingArray.length === 0) {
    installs[skillName] = installRecord;
    return {
      ...receipt,
      installs
    };
  }

  if (targetPath === undefined) {
    existingArray.push(installRecord);
    installs[skillName] = existingArray;
    return {
      ...receipt,
      installs
    };
  }

  const nextRecords = [...existingArray];
  const matchIndex = nextRecords.findIndex((entry) => normalizeTargetPath(entry?.targetPath) === normalizedTargetPath);
  if (matchIndex === -1) {
    nextRecords.push(installRecord);
  } else {
    nextRecords[matchIndex] = installRecord;
  }

  if (nextRecords.length === 1) {
    installs[skillName] = nextRecords[0];
    return {
      ...receipt,
      installs
    };
  }

  installs[skillName] = nextRecords;

  return {
    ...receipt,
    installs
  };
}

function normalizeTargetPath(targetPath) {
  const value = normalizeValue(targetPath);
  if (value === null) {
    return null;
  }
  return path.resolve(value);
}

function normalizeTargetPathForInstallRoot({ installRoot, targetPath }) {
  const value = normalizeValue(targetPath);
  if (value === null) {
    return null;
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(path.resolve(installRoot), value);
}

function assertReceiptInstallRecord(installRecord) {
  if (!isRecord(installRecord)) {
    throw new Error("installRecord must be an object.");
  }

  const sourcePath = normalizeReceiptSourcePath(installRecord);
  if (!sourcePath) {
    throw new Error("installRecord must include sourcePath or source.path.");
  }

  if (installRecord.source !== undefined) {
    if (typeof installRecord.source === "string") {
      if (!normalizeValue(installRecord.source)) {
        throw new Error("installRecord.source must be a non-empty string when provided.");
      }
    } else if (isRecord(installRecord.source)) {
      if (!normalizeValue(installRecord.source.path)) {
        throw new Error("installRecord.source.path must be a non-empty string when source is an object.");
      }
    } else {
      throw new Error("installRecord.source must be a string or object with a path.");
    }
  }

  const requiredField = ["agent", "mode", "targetPath"].find((field) => {
    const value = installRecord[field];
    return typeof value !== "string" || value.trim().length === 0;
  });
  if (requiredField) {
    throw new Error(`installRecord is missing required field: ${requiredField}.`);
  }

  const hasProvenance = ["version", "sourceCommit", "sourceHash"].some((field) => {
    const value = installRecord[field];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (!hasProvenance) {
    throw new Error("installRecord must include version, sourceCommit, or sourceHash.");
  }

  const invalidScalarField = ["target", "version", "sourceCommit", "sourceHash"].find((field) => {
    const value = installRecord[field];
    if (value === undefined || value === null) {
      return false;
    }
    return typeof value !== "string";
  });
  if (invalidScalarField) {
    throw new Error(`installRecord.${invalidScalarField} must be a string when provided.`);
  }

  if (installRecord.priorState !== undefined && !isRecord(installRecord.priorState)) {
    throw new Error("installRecord.priorState must be an object.");
  }

  if (installRecord.installedFiles !== undefined) {
    if (!validateInstalledFiles(installRecord.installedFiles, { skillName: "unknown" }).isValid) {
      throw new Error("installRecord.installedFiles must be an array of { path, hash } objects.");
    }
  }
}

function normalizeReceiptSourcePath(installRecord) {
  if (normalizeValue(installRecord.sourcePath)) {
    return true;
  }

  if (isRecord(installRecord.source) && normalizeValue(installRecord.source.path)) {
    return true;
  }

  if (typeof installRecord.source === "string" && installRecord.source.trim().length > 0) {
    return true;
  }

  return false;
}

function validateInstalledFiles(installedFiles, { skillName }) {
  if (installedFiles === null || installedFiles === undefined) {
    return { isValid: true };
  }
  if (!Array.isArray(installedFiles)) {
    return { isValid: false };
  }

  for (const file of installedFiles) {
    if (!isRecord(file)) {
      return { isValid: false };
    }
    if (!normalizeValue(file.path)) {
      return { isValid: false };
    }
    if (file.hash !== undefined && !normalizeValue(file.hash)) {
      return { isValid: false };
    }
  }

  return { isValid: true };
}

function normalizeValue(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeReceiptPayload(receipt) {
  const normalizedReceipt = {
    ...receipt,
    schema: receipt.schema ?? RECEIPT_SCHEMA
  };

  if (normalizedReceipt.installs !== undefined && !isRecord(normalizedReceipt.installs)) {
    throw new Error("Receipt installs must be an object.");
  }

  const rawInstalls = normalizedReceipt.installs ?? {};
  const normalizedInstalls = {};

  for (const [skillName, records] of Object.entries(rawInstalls)) {
    const nextRecords = [];
    const value = Array.isArray(records) ? records : [records];
    if (!value.every((record) => isRecord(record))) {
      throw new Error(`install record for ${skillName} in installs mapping must be an object.`);
    }

    for (const installRecord of value) {
      assertReceiptInstallRecord(installRecord);
      nextRecords.push(installRecord);
    }

    normalizedInstalls[skillName] = nextRecords.length === 1 ? nextRecords[0] : nextRecords;
  }

  normalizedReceipt.installs = normalizedInstalls;

  return normalizedReceipt;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
