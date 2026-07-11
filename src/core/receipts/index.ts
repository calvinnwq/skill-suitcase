import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const RECEIPT_SCHEMA = "calvinnwq.skills.receipt.v0";
export const RECEIPT_FILE = ".skill-suitcase-receipt.json";
export const LEGACY_RECEIPT_SCHEMA = "calvinnwq.skills.sync-lock.v0";
export const LEGACY_RECEIPT_FILE = ".skills-sync.json";
export const RECEIPT_LOCK_FILE = ".skill-suitcase-receipt.lock";

const RECEIPT_LOCK_RETRY_MS = 25;
const RECEIPT_LOCK_TIMEOUT_MS = 10_000;
const RECEIPT_LEGACY_LOCK_STALE_MS = 86_400_000;
const RECEIPT_LOCK_TOKEN = Symbol("receipt-lock");
const RECEIPT_LOCK_SCHEMA = "calvinnwq.skills.receipt-lock.v1";
const RECEIPT_FILE_DEFAULT_MODE = 0o600;

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
  variant?: string;
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
  onWritten?: (mutation: ReceiptMutation) => void;
  receiptLock?: ReceiptLock;
};

type ReadReceiptInput = {
  installRoot?: string;
  receiptPath?: string;
};

type WriteReceiptInput = {
  installRoot: string;
  receipt: Receipt;
  receiptPath?: string;
  onWritten?: (mutation: ReceiptMutation) => void;
  receiptLock?: ReceiptLock;
};

type UpdateAndWriteReceiptInput = {
  installRoot: string;
  receiptPath?: string;
  update: (receipt: Receipt) => Receipt | Promise<Receipt>;
  onWritten?: (mutation: ReceiptMutation) => void;
  receiptLock?: ReceiptLock;
};

export type ReceiptLock = {
  installRoot: string;
  active: boolean;
  [RECEIPT_LOCK_TOKEN]: true;
};

export type ReceiptMutation = {
  previousText: string | null;
  writtenText: string;
};

type ReceiptLockOwner = {
  schema: typeof RECEIPT_LOCK_SCHEMA;
  pid: number;
  token: string;
  createdAt: string;
};

type RollbackReceiptMutationsInput = {
  installRoot: string;
  receiptPath?: string;
  mutations: ReceiptMutation[];
  receiptLock?: ReceiptLock;
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
  receiptPath = RECEIPT_FILE,
  onWritten,
  receiptLock
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
  const payload = normalizeReceiptPayload(receipt);
  await withOptionalReceiptLock({ installRoot: path.dirname(outputPath), receiptLock }, async () => {
    const previousText = await readOptionalReceiptTextUnlocked(outputPath);
    const writtenText = await writeReceiptUnlocked(outputPath, payload);
    onWritten?.({ previousText, writtenText });
  });
  return outputPath;
}

export async function readReceipt({
  installRoot,
  receiptPath = RECEIPT_FILE
}: ReadReceiptInput): Promise<Receipt> {
  const normalizedRoot = normalizeInstallRoot(installRoot);
  const normalizedReceiptPath = receiptPath ?? RECEIPT_FILE;
  const outputPath = resolveReceiptPath({
    installRoot: normalizedRoot,
    receiptPath: normalizedReceiptPath
  });
  return readReceiptForUpsert({
    receiptPath: outputPath,
    legacyReceiptPath: path.join(normalizedRoot, LEGACY_RECEIPT_FILE)
  });
}

export async function upsertAndWriteReceipt({
  installRoot,
  receipt,
  skillName,
  installRecord,
  receiptPath = RECEIPT_FILE,
  onWritten,
  receiptLock
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

  const normalizedTargetPath = normalizeTargetPathForInstallRoot({
    installRoot: normalizedRoot,
    targetPath: installRecord.targetPath
  });
  const nextInstallRecord = normalizedTargetPath
    ? { ...installRecord, targetPath: normalizedTargetPath }
    : installRecord;

  await withOptionalReceiptLock({ installRoot: path.dirname(outputPath), receiptLock }, async () => {
    const previousText = await readOptionalReceiptTextUnlocked(outputPath);
    const currentReceipt = receipt === undefined
      ? await readReceipt({
        installRoot: normalizedRoot,
        receiptPath: normalizedReceiptPath
      })
      : receipt;
    if (!isRecord(currentReceipt)) {
      throw new Error("Receipt payload must be an object.");
    }

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
    const writtenText = await writeReceiptUnlocked(outputPath, normalizeReceiptPayload(nextReceipt));
    onWritten?.({ previousText, writtenText });
  });
  return outputPath;
}

export async function updateAndWriteReceipt({
  installRoot,
  receiptPath = RECEIPT_FILE,
  update,
  onWritten,
  receiptLock
}: UpdateAndWriteReceiptInput): Promise<string> {
  const normalizedRoot = normalizeInstallRoot(installRoot);
  const normalizedReceiptPath = receiptPath ?? RECEIPT_FILE;
  const outputPath = resolveReceiptPath({
    installRoot: normalizedRoot,
    receiptPath: normalizedReceiptPath
  });
  await withOptionalReceiptLock({ installRoot: path.dirname(outputPath), receiptLock }, async () => {
    const previousText = await readOptionalReceiptTextUnlocked(outputPath);
    const currentReceipt = await readReceipt({
      installRoot: normalizedRoot,
      receiptPath: normalizedReceiptPath
    });
    const nextReceipt = await update(currentReceipt);
    const writtenText = await writeReceiptUnlocked(outputPath, normalizeReceiptPayload(nextReceipt));
    onWritten?.({ previousText, writtenText });
  });
  return outputPath;
}

export async function rollbackReceiptMutations({
  installRoot,
  receiptPath = RECEIPT_FILE,
  mutations,
  receiptLock
}: RollbackReceiptMutationsInput): Promise<boolean> {
  if (mutations.length === 0) {
    return true;
  }
  const normalizedRoot = normalizeInstallRoot(installRoot);
  const normalizedReceiptPath = receiptPath ?? RECEIPT_FILE;
  const outputPath = resolveReceiptPath({
    installRoot: normalizedRoot,
    receiptPath: normalizedReceiptPath
  });
  try {
    return await withOptionalReceiptLock({ installRoot: path.dirname(outputPath), receiptLock }, async () => {
      const currentText = await readOptionalReceiptTextUnlocked(outputPath);
      let restoredText = currentText;
      let complete = true;
      for (const mutation of [...mutations].reverse()) {
        const reverted = revertReceiptMutation(restoredText, mutation);
        restoredText = reverted.text;
        complete = complete && reverted.complete;
      }
      if (restoredText !== currentText) {
        await writeReceiptTextUnlocked(outputPath, restoredText);
      }
      return complete;
    });
  } catch {
    return false;
  }
}

export async function withReceiptLock<T>(
  { installRoot, createInstallRoot = true }: { installRoot: string; createInstallRoot?: boolean },
  action: (receiptLock: ReceiptLock) => Promise<T>
): Promise<T> {
  const normalizedRoot = normalizeInstallRoot(installRoot);
  if (createInstallRoot) {
    await mkdir(normalizedRoot, { recursive: true });
  } else {
    const rootInfo = await stat(normalizedRoot);
    if (!rootInfo.isDirectory()) {
      throw new Error(`Receipt lock root is not a directory: ${normalizedRoot}.`);
    }
  }
  const lockPath = path.join(normalizedRoot, RECEIPT_LOCK_FILE);
  const deadline = Date.now() + RECEIPT_LOCK_TIMEOUT_MS;
  const owner: ReceiptLockOwner = {
    schema: RECEIPT_LOCK_SCHEMA,
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString()
  };
  const lockText = `${JSON.stringify(owner)}\n`;
  const pendingPath = `${lockPath}.${owner.token}.pending`;
  const pendingHandle = await open(pendingPath, "wx", RECEIPT_FILE_DEFAULT_MODE);
  try {
    await pendingHandle.writeFile(lockText, "utf8");
    await pendingHandle.sync();
  } finally {
    await pendingHandle.close();
  }
  try {
    while (true) {
      if (!(await receiptLockRecoveryIsClear(lockPath))) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for receipt lock at ${lockPath}.`);
        await new Promise((resolve) => setTimeout(resolve, RECEIPT_LOCK_RETRY_MS));
        continue;
      }
      try {
        await link(pendingPath, lockPath);
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
        if (await removeStaleReceiptLock(lockPath)) continue;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for receipt lock at ${lockPath}.`);
        await new Promise((resolve) => setTimeout(resolve, RECEIPT_LOCK_RETRY_MS));
      }
    }
  } finally {
    await rm(pendingPath, { force: true }).catch(() => undefined);
  }
  const receiptLock: ReceiptLock = {
    installRoot: normalizedRoot,
    active: true,
    [RECEIPT_LOCK_TOKEN]: true
  };
  try {
    return await action(receiptLock);
  } finally {
    receiptLock.active = false;
    try {
      if (await readFile(lockPath, "utf8") === lockText) await rm(lockPath);
    } catch {}
  }
}

async function removeStaleReceiptLock(lockPath: string): Promise<boolean> {
  if (await removeStaleLegacyReceiptLock(lockPath)) return true;
  const initial = await readReceiptLockOwner(lockPath);
  if (initial === null || isProcessAlive(initial.owner.pid)) return false;
  const recoveryPath = `${lockPath}.recover.${process.pid}.${randomUUID()}`;
  try {
    await link(lockPath, recoveryPath);
  } catch {
    return false;
  }
  try {
    const [current, recovery] = await Promise.all([
      readReceiptLockOwner(lockPath),
      readReceiptLockOwner(recoveryPath)
    ]);
    if (
      current === null
      || recovery === null
      || current.text !== initial.text
      || current.info.dev !== initial.info.dev
      || current.info.ino !== initial.info.ino
      || recovery.info.dev !== initial.info.dev
      || recovery.info.ino !== initial.info.ino
      || isProcessAlive(current.owner.pid)
    ) {
      return false;
    }
    await rm(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    await rm(recoveryPath, { force: true }).catch(() => undefined);
  }
}

async function receiptLockRecoveryIsClear(lockPath: string): Promise<boolean> {
  const directory = path.dirname(lockPath);
  const lockName = path.basename(lockPath);
  const recoveryPrefix = `${lockName}.recover.`;
  const legacyPrefix = `${lockName}.`;
  const entries = await readdir(directory);
  const current = await readReceiptLockOwner(lockPath);
  let clear = true;

  for (const entry of entries) {
    if (entry.startsWith(recoveryPrefix)) {
      const parts = entry.slice(recoveryPrefix.length).split(".");
      const pid = Number(parts[0]);
      if (parts.length !== 2 || !Number.isSafeInteger(pid) || pid <= 0 || parts[1]?.length === 0) {
        clear = false;
        continue;
      }
      if (isProcessAlive(pid)) {
        clear = false;
        continue;
      }
      try {
        await rm(path.join(directory, entry));
      } catch {
        clear = false;
      }
      continue;
    }

    if (!entry.startsWith(legacyPrefix) || !entry.endsWith(".recover")) continue;
    const identity = entry.slice(legacyPrefix.length, -".recover".length);
    if (!/^\d+-\d+$/.test(identity)) continue;
    const recoveryPath = path.join(directory, entry);
    try {
      const recoveryInfo = await lstat(recoveryPath);
      if (
        current !== null
        && recoveryInfo.dev === current.info.dev
        && recoveryInfo.ino === current.info.ino
      ) {
        continue;
      }
      await rm(recoveryPath);
    } catch {
      clear = false;
    }
  }

  return clear;
}

async function readReceiptLockOwner(
  lockPath: string
): Promise<{ owner: ReceiptLockOwner; text: string; info: import("node:fs").Stats } | null> {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile()) return null;
    const text = await readFile(lockPath, "utf8");
    const legacyPid = Number(text.trim());
    if (Number.isSafeInteger(legacyPid) && legacyPid > 0) {
      return {
        owner: {
          schema: RECEIPT_LOCK_SCHEMA,
          pid: legacyPid,
          token: `legacy-${info.dev}-${info.ino}`,
          createdAt: info.mtime.toISOString()
        },
        text,
        info
      };
    }
    const value = JSON.parse(text) as Partial<ReceiptLockOwner>;
    if (
      value.schema !== RECEIPT_LOCK_SCHEMA
      || !Number.isSafeInteger(value.pid)
      || (value.pid ?? 0) <= 0
      || typeof value.token !== "string"
      || value.token.length === 0
      || typeof value.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return null;
    }
    return { owner: value as ReceiptLockOwner, text, info };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH";
  }
}

async function withOptionalReceiptLock<T>(
  { installRoot, receiptLock }: { installRoot: string; receiptLock: ReceiptLock | undefined },
  action: () => Promise<T>
): Promise<T> {
  if (
    receiptLock?.[RECEIPT_LOCK_TOKEN] === true
    && receiptLock.active
    && receiptLock.installRoot === normalizeInstallRoot(installRoot)
  ) {
    return action();
  }
  return withReceiptLock({ installRoot }, action);
}

async function removeStaleLegacyReceiptLock(lockPath: string): Promise<boolean> {
  const info = await lstatSafe(lockPath);
  if (
    info === null
    || !info.isDirectory()
    || info.mtimeMs > Date.now() - RECEIPT_LEGACY_LOCK_STALE_MS
  ) {
    return false;
  }
  try {
    if ((await readdir(lockPath)).length > 0) return false;
    const current = await lstat(lockPath);
    if (current.dev !== info.dev || current.ino !== info.ino) return false;
    await rmdir(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function lstatSafe(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await lstat(filePath);
  } catch {
    return null;
  }
}

async function writeReceiptUnlocked(outputPath: string, receipt: Receipt): Promise<string> {
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeReceiptTextUnlocked(outputPath, text);
  return text;
}

async function writeReceiptTextUnlocked(outputPath: string, text: string | null): Promise<void> {
  if (text === null) {
    await rm(outputPath, { force: true });
    return;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  const current = await lstatSafe(outputPath);
  const mode = current?.isFile()
    ? current.mode & 0o777
    : RECEIPT_FILE_DEFAULT_MODE;
  try {
    await writeFile(tempPath, text, { encoding: "utf8", flag: "wx", mode });
    await chmod(tempPath, mode);
    await rename(tempPath, outputPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readOptionalReceiptTextUnlocked(receiptPath: string): Promise<string | null> {
  try {
    return await readFile(receiptPath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function revertReceiptMutation(
  currentText: string | null,
  mutation: ReceiptMutation
): { text: string | null; complete: boolean } {
  if (currentText === mutation.writtenText) {
    return { text: mutation.previousText, complete: true };
  }
  const current = parseReceiptText(currentText);
  const previous = parseReceiptText(mutation.previousText);
  const written = parseReceiptText(mutation.writtenText);
  if (current === null || previous === null || written === null) {
    return { text: currentText, complete: false };
  }

  const reverted = { ...current };
  let complete = true;
  for (const key of new Set([...Object.keys(previous), ...Object.keys(written)])) {
    if (key === "installs") {
      const result = revertReceiptInstalls(current.installs, previous.installs, written.installs);
      if (result.value === undefined) delete reverted.installs;
      else reverted.installs = result.value;
      complete = complete && result.complete;
      continue;
    }
    const currentValue = current[key];
    const previousValue = previous[key];
    const writtenValue = written[key];
    if (stableEqual(previousValue, writtenValue)) continue;
    if (!stableEqual(currentValue, writtenValue)) {
      complete = false;
      continue;
    }
    if (previousValue === undefined) delete reverted[key];
    else reverted[key] = previousValue;
  }
  if (isRecord(reverted.installs) && Object.keys(reverted.installs).length > 0) {
    reverted.schema = RECEIPT_SCHEMA;
  }
  return { text: `${JSON.stringify(reverted, null, 2)}\n`, complete };
}

function revertReceiptInstalls(
  currentValue: unknown,
  previousValue: unknown,
  writtenValue: unknown
): { value: Receipt["installs"]; complete: boolean } {
  const current = (isRecord(currentValue) ? { ...currentValue } : {}) as NonNullable<Receipt["installs"]>;
  const previous = (isRecord(previousValue) ? previousValue : {}) as NonNullable<Receipt["installs"]>;
  const written = (isRecord(writtenValue) ? writtenValue : {}) as NonNullable<Receipt["installs"]>;
  let complete = true;
  for (const skill of new Set([...Object.keys(previous), ...Object.keys(written)])) {
    if (stableEqual(previous[skill], written[skill])) continue;
    if (!stableEqual(current[skill], written[skill])) {
      complete = false;
      continue;
    }
    if (previous[skill] === undefined) delete current[skill];
    else current[skill] = previous[skill];
  }
  return {
    value: Object.keys(current).length === 0 && previousValue === undefined ? undefined : current,
    complete
  };
}

function parseReceiptText(text: string | null): Receipt | null {
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stableEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
    variant,
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
  if (variant !== undefined) {
    record.variant = variant as string;
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

  const invalidScalarField = ["target", "version", "variant", "sourceCommit", "sourceHash"].find((field) => {
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
