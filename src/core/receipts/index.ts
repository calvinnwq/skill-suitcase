import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const RECEIPT_SCHEMA = "calvinnwq.skills.receipt.v0";
export const RECEIPT_FILE = ".skill-suitcase-receipt.json";
export const LEGACY_RECEIPT_SCHEMA = "calvinnwq.skills.sync-lock.v0";
export const LEGACY_RECEIPT_FILE = ".skills-sync.json";

type UnknownRecord = Record<string, unknown>;

type ReceiptSourceInfo = {
  repo: string;
  ref?: string | null;
  commit?: string | null;
  [key: string]: unknown;
};

export type ReceiptInstalledFile = {
  path: string;
  hash: string;
};

export type ReceiptInstallRecord = {
  [key: string]: unknown;
  skill?: string;
  agent?: string;
  mode?: string;
  source?: string | { path: string } | null;
  sourcePath?: string;
  targetPath?: string;
  target?: string;
  version?: string;
  sourceCommit?: string;
  sourceHash?: string;
  installedFiles?: unknown;
  priorState?: UnknownRecord;
  rollback?: UnknownRecord;
};

export interface Receipt {
  schema?: string;
  source?: ReceiptSourceInfo;
  installs?: Record<string, ReceiptInstallRecord | ReceiptInstallRecord[]>;
  [key: string]: unknown;
}

type UpsertAndWriteReceiptInput = {
  installRoot?: string;
  receipt?: Receipt;
  skillName: string;
  installRecord: ReceiptInstallRecord;
  receiptPath?: string;
};

type WriteReceiptInput = {
  installRoot: string;
  receipt: Receipt;
  receiptPath?: string;
};

type UpsertInstallRecordInput = {
  skillName: string;
  installRecord: ReceiptInstallRecord;
  installRoot?: string;
};

type ReceiptFileReadInput = {
  legacy: boolean;
};

type ReadReceiptFileOutput = {
  found: boolean;
  receipt: Receipt;
};

export async function buildInstalledFiles(
  skillRoot: string,
  { exclude }: { exclude?: Iterable<string> } = {}
): Promise<ReceiptInstalledFile[]> {
  const root = path.resolve(skillRoot);
  const excluded = new Set<string>();
  for (const candidate of exclude ?? []) {
    excluded.add(path.resolve(candidate));
  }
  const files = await collectInstalledFiles(root, root, excluded);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function writeReceipt({
  installRoot,
  receipt,
  receiptPath = RECEIPT_FILE
}: WriteReceiptInput): Promise<string> {
  if (!isRecord(receipt)) {
    throw new Error("Receipt payload must be an object.");
  }

  const normalizedRoot = normalizeInstallRoot(installRoot);
  const normalizedReceiptPath = receiptPath ?? RECEIPT_FILE;
  const outputPath = resolveReceiptPath({
    installRoot: normalizedRoot,
    receiptPath: normalizedReceiptPath
  });
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
}: UpsertAndWriteReceiptInput): Promise<string> {
  const normalizedRoot = normalizeInstallRoot(installRoot);
  const normalizedReceiptPath = receiptPath ?? RECEIPT_FILE;
  const outputPath = resolveReceiptPath({
    installRoot: normalizedRoot,
    receiptPath: normalizedReceiptPath
  });

  if (typeof skillName !== "string" || skillName.trim().length === 0) {
    throw new Error("skillName is required.");
  }

  if (!isRecord(installRecord)) {
    throw new Error("installRecord must be an object.");
  }

  const currentReceipt = receipt === undefined
    ? await readReceiptForUpsert({
      receiptPath: outputPath,
      legacyReceiptPath: path.join(normalizedRoot, LEGACY_RECEIPT_FILE)
    })
    : receipt;
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

  const nextReceipt = upsertInstallRecord(
    {
      ...currentReceipt,
      installs: cloneReceiptInstalls(currentReceipt)
    },
    {
      skillName,
      installRecord: nextInstallRecord,
      installRoot: normalizedRoot
    }
  );

  return writeReceipt({
    installRoot: normalizedRoot,
    receipt: nextReceipt,
    receiptPath: normalizedReceiptPath
  });
}

async function readReceiptForUpsert({ receiptPath, legacyReceiptPath }: {
  receiptPath: string;
  legacyReceiptPath: string;
}): Promise<Receipt> {
  const modernReceipt = await readReceiptFileForUpsert(receiptPath, { legacy: false });
  if (modernReceipt.found) {
    return modernReceipt.receipt;
  }

  const legacyReceipt = await readReceiptFileForUpsert(legacyReceiptPath, { legacy: true });
  if (legacyReceipt.found) {
    return legacyReceipt.receipt;
  }

  return {};
}

async function readReceiptFileForUpsert(
  receiptPath: string,
  { legacy }: ReceiptFileReadInput
): Promise<ReadReceiptFileOutput> {
  try {
    const text = await readFile(receiptPath, "utf8");
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) {
      throw new Error("Receipt payload must be an object.");
    }

    const receipt = parsed as Receipt;
    const expectedSchema = legacy ? LEGACY_RECEIPT_SCHEMA : RECEIPT_SCHEMA;
    if (receipt.schema !== expectedSchema) {
      throw new Error(`Receipt ${receiptPath} has an unsupported schema.`);
    }

    return {
      found: true,
      receipt: legacy
        ? {
          ...receipt,
          schema: RECEIPT_SCHEMA
        }
        : receipt
    };
  } catch (error) {
    const maybeFsError = error as { code?: string };
    if (maybeFsError.code === "ENOENT") {
      return { found: false, receipt: {} };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Receipt ${receiptPath} must be valid JSON.`);
    }
    throw error;
  }
}

function normalizeInstallRoot(installRoot?: string): string {
  if (typeof installRoot !== "string" || installRoot.trim().length === 0) {
    throw new Error("installRoot is required.");
  }
  return path.resolve(installRoot);
}

function resolveReceiptPath({ installRoot, receiptPath }: {
  installRoot: string;
  receiptPath: string;
}): string {
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

function cloneReceiptInstalls(receipt: Receipt): Record<string, ReceiptInstallRecord | ReceiptInstallRecord[]> {
  if (receipt.installs === undefined) {
    return {};
  }
  if (!isRecord(receipt.installs)) {
    throw new Error("Receipt installs must be an object.");
  }
  return { ...receipt.installs };
}

async function collectInstalledFiles(
  root: string,
  baseRoot: string,
  excluded: Set<string>
): Promise<ReceiptInstalledFile[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: ReceiptInstalledFile[] = [];

  for (const entry of entries) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      continue;
    }

    const entryPath = path.join(root, entry.name);
    if (excluded.has(path.resolve(entryPath))) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectInstalledFiles(entryPath, baseRoot, excluded)));
      continue;
    }
    if (entry.isFile()) {
      const content = await readFile(entryPath);
      files.push({
        path: path.relative(baseRoot, entryPath),
        hash: createHash("sha256").update(content).digest("hex")
      });
    }
  }

  return files;
}

export function buildReceipt({
  sourceRoot,
  sourceCommit = null,
  sourceRef = null,
  installs = {}
}: {
  sourceRoot: string;
  sourceCommit?: string | null;
  sourceRef?: string | null;
  installs?: Record<string, ReceiptInstallRecord | ReceiptInstallRecord[]>;
}): Receipt {
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

export function buildInstallRecord(
  installRecord: UnknownRecord
): ReceiptInstallRecord {
  const {
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
    priorState,
    rollback
  } = installRecord;

  const record: ReceiptInstallRecord = {};

  if (agent !== undefined) {
    record.agent = agent as string;
  }
  if (mode !== undefined) {
    record.mode = mode as string;
  }
  if (target !== undefined) {
    record.target = target as string;
  }
  if (targetPath !== undefined) {
    record.targetPath = targetPath as string;
  }
  if (version !== undefined) {
    record.version = version as string;
  }
  if (sourceCommit !== undefined) {
    record.sourceCommit = sourceCommit as string;
  }
  if (sourceHash !== undefined) {
    record.sourceHash = sourceHash as string;
  }
  if (source !== undefined) {
    record.source = source as Exclude<ReceiptInstallRecord["source"], undefined>;
  }
  if (sourcePath !== undefined) {
    record.sourcePath = sourcePath as string;
  }
  if (skill !== undefined) {
    record.skill = skill as string;
  }
  if (installedFiles !== undefined) {
    record.installedFiles = installedFiles;
  }
  if (priorState !== undefined && priorState !== null && typeof priorState === "object") {
    record.priorState = priorState as UnknownRecord;
  }
  if (rollback !== undefined && rollback !== null && typeof rollback === "object") {
    record.rollback = rollback as UnknownRecord;
  }

  return record;
}

export function upsertInstallRecord(
  receipt: Receipt,
  { skillName, installRecord, installRoot }: UpsertInstallRecordInput
): Receipt {
  if (typeof skillName !== "string" || skillName.trim().length === 0) {
    throw new Error("skillName is required.");
  }

  assertReceiptInstallRecord(installRecord);

  const existing = receipt.installs?.[skillName];
  const installs: Receipt["installs"] = {
    ...(receipt.installs ?? {})
  };
  const targetPath = installRecord.targetPath;
  const normalizedTargetPath = normalizeTargetPathForInstallRoot({
    installRoot,
    targetPath
  });
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
  const matchIndex = nextRecords.findIndex(
    (entry) =>
      normalizeTargetPathForInstallRoot({
        installRoot,
        targetPath: (entry as ReceiptInstallRecord).targetPath
      }) === normalizedTargetPath
  );

  if (matchIndex === -1) {
    nextRecords.push(installRecord);
  } else {
    nextRecords[matchIndex] = installRecord;
  }

  if (nextRecords.length === 1) {
    const only = nextRecords[0];
    if (only !== undefined) {
      installs[skillName] = only;
      return {
        ...receipt,
        installs
      };
    }
  }

  if (nextRecords.length > 1) {
    installs[skillName] = nextRecords;
  }

  return {
    ...receipt,
    installs
  };
}

function normalizeTargetPath(targetPath: string | null | undefined): string | null {
  const value = normalizeValue(targetPath);
  if (value === null) {
    return null;
  }
  return path.resolve(value);
}

function normalizeTargetPathForInstallRoot({
  installRoot,
  targetPath
}: {
  installRoot?: string | undefined;
  targetPath?: unknown;
}): string | null {
  const value = normalizeValue(targetPath);
  if (value === null) {
    return null;
  }

  const normalizedInstallRoot = normalizeValue(installRoot);
  if (normalizedInstallRoot === null) {
    return normalizeTargetPath(value);
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(path.resolve(normalizedInstallRoot), value);
}

function assertReceiptInstallRecord(installRecord: unknown): asserts installRecord is ReceiptInstallRecord {
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

function normalizeReceiptSourcePath(installRecord: ReceiptInstallRecord): boolean {
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

function validateInstalledFiles(
  installedFiles: unknown,
  { skillName }: { skillName: string }
): { isValid: boolean } {
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

function normalizeReceiptPayload(receipt: Receipt): Receipt {
  if (
    receipt.schema !== undefined &&
    receipt.schema !== RECEIPT_SCHEMA &&
    receipt.schema !== LEGACY_RECEIPT_SCHEMA
  ) {
    throw new Error("Receipt schema is unsupported.");
  }

  const normalizedReceipt: Receipt = {
    ...receipt,
    schema: RECEIPT_SCHEMA
  };

  if (normalizedReceipt.installs !== undefined && !isRecord(normalizedReceipt.installs)) {
    throw new Error("Receipt installs must be an object.");
  }

  const rawInstalls = normalizedReceipt.installs ?? {};
  const normalizedInstalls: Record<string, ReceiptInstallRecord | ReceiptInstallRecord[]> = {};

  for (const [skillName, records] of Object.entries(rawInstalls)) {
    const nextRecords: ReceiptInstallRecord[] = [];
    const value = Array.isArray(records) ? records : [records];
    if (!value.every((record) => isRecord(record))) {
      throw new Error(`install record for ${skillName} in installs mapping must be an object.`);
    }

    for (const installRecord of value) {
      assertReceiptInstallRecord(installRecord);
      nextRecords.push(installRecord);
    }

    if (nextRecords.length === 0) {
      continue;
    }

    normalizedInstalls[skillName] = nextRecords.length === 1
      ? nextRecords[0]!
      : nextRecords;
  }

  normalizedReceipt.installs = normalizedInstalls;

  return normalizedReceipt;
}

function normalizeValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
