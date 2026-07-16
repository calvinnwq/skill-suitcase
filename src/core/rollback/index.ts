import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";
import { classifySymlinkInstall, SYMLINK_MODE } from "../install-modes.js";
import {
  buildInstalledFiles,
  updateAndWriteReceipt,
  withReceiptLock,
  type Receipt,
  type ReceiptInstallRecord
} from "../receipts/index.js";
import {
  collectRecords,
  isPathInsideOrSame,
  isRecord,
  normalizeString,
  parseAppliedSymlinkRollback,
  parseCopyRollback,
  readReceipt,
  resolveReceiptInstallRoot,
  resolveReceiptPath,
  type InstalledFile,
  type RollbackFileRecord
} from "./receipt-state.js";

type RollbackInput = {
  receipt: string;
  __test?: {
    beforeFileMutation?: (targetPath: string) => Promise<void> | void;
    beforeReconcileBackupRemoval?: (backupPath: string) => Promise<void> | void;
    afterAppliedSymlinkClassification?: (targetPath: string) => Promise<void> | void;
    beforeMissingInstallTargetRemoval?: (targetPath: string) => Promise<void> | void;
    beforeFileOwnershipChange?: (targetPath: string) => Promise<void> | void;
  };
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

export async function rollback({ receipt, __test }: RollbackInput): Promise<RollbackResult> {
  if (!receipt) {
    throw new Error("receipt is required");
  }

  const receiptPath = await resolveReceiptPath(receipt);
  const receiptDirectory = path.dirname(receiptPath);
  const installRoot = await resolveReceiptInstallRoot(receiptDirectory);
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

  try {
    await readReceipt(receiptPath);
  } catch (error) {
    result.ok = false;
    result.errors.push({
      code: "invalid_receipt",
      message: `Invalid receipt ${receiptPath}: ${errorMessage(error)}`,
      path: receiptPath
    });
    return result;
  }

  try {
    return await withReceiptLock({ installRoot, createInstallRoot: false }, async (receiptLock) => {
  let receiptPayload: Receipt;
  try {
    receiptPayload = await readReceipt(receiptPath);
  } catch (error) {
    result.ok = false;
    result.errors.push({
      code: "invalid_receipt",
      message: `Invalid receipt ${receiptPath}: ${errorMessage(error)}`,
      path: receiptPath
    });
    return result;
  }
  const installs = receiptPayload.installs;
  if (!isRecord(installs)) {
    result.ok = false;
    result.errors.push({ code: "invalid_receipt", message: "Receipt installs must be an object." });
    return result;
  }
  const originalInstalls = structuredClone(installs);

  let changedReceipt = false;
  const receiptChangedSkills = new Set<string>();
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
    if (record.mode === SYMLINK_MODE) {
      // A symlink install is a live link from the agent home into the catalog
      // source (agent skill path -> repo source path). Skill Suitcase never owns
      // copies of the source files for these installs, so rollback must never
      // restore copy-style file bytes here: doing so would write through the
      // link and mutate the catalog source.
      //
      // apply --mode symlink records explicit symlink-rollback state with
      // created:true for links it created. Rollback reverses those by removing
      // the Suitcase-created link (the link only, never the source it points
      // at), per ARCHITECTURE.md. Adopted (track) links carry no rollback state
      // and apply-refreshed links record created:false; in both cases Suitcase
      // did not create the link, so there is nothing to reverse and rollback is
      // a safe no-op that leaves the link and its source untouched.
      const appliedSymlink = parseAppliedSymlinkRollback(record, installRoot, receiptDirectory);
      if (appliedSymlink.kind === "apply-created") {
        const removal = await removeAppliedSymlink(
          appliedSymlink,
          installRoot,
          __test?.afterAppliedSymlinkClassification
        );
        if (removal.kind === "removed") {
          result.summary.removed += 1;
          removeReceiptInstallRecord(installs, skill, record);
          changedReceipt = true;
          receiptChangedSkills.add(skill);
          result.rollbacks.push({
            skill,
            targetPath: appliedSymlink.targetPath,
            status: "restored",
            restored: 0,
            removed: 1,
            failed: 0
          });
          continue;
        }
        result.ok = false;
        if (removal.kind === "refused") {
          result.summary.refused += 1;
          result.errors.push({
            code: "target_drift",
            message: removal.message,
            skill,
            path: appliedSymlink.targetPath
          });
          result.rollbacks.push({
            skill,
            targetPath: appliedSymlink.targetPath,
            status: "refused",
            restored: 0,
            removed: 0,
            failed: 0
          });
          continue;
        }
        result.summary.failed += 1;
        result.errors.push({
          code: "rollback_remove_failed",
          message: removal.message,
          skill,
          path: appliedSymlink.targetPath
        });
        result.rollbacks.push({
          skill,
          targetPath: appliedSymlink.targetPath,
          status: "refused",
          restored: 0,
          removed: 0,
          failed: 1
        });
        continue;
      }

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

    const parsedRollback = parseCopyRollback(record, installRoot, receiptDirectory);
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

    const reconcileBackupValidation = installWasPreviouslyUnmanagedReconcile(record)
      ? validateReconcileBackupPath({
        skill,
        targetPath,
        backupPath: rollbackState.backupPath
      })
      : { ok: true as const };
    if (!reconcileBackupValidation.ok) {
      result.ok = false;
      result.summary.refused += 1;
      result.errors.push({
        code: reconcileBackupValidation.code,
        message: reconcileBackupValidation.message,
        skill,
        path: reconcileBackupValidation.path
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
      const restored = await restoreRollbackFile(
        file,
        installRoot,
        __test?.beforeFileMutation,
        __test?.beforeFileOwnershipChange
      );
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
      if (installWasPreviouslyMissing(record)) {
        await __test?.beforeMissingInstallTargetRemoval?.(targetPath);
        const removedTarget = await removeMissingInstallTarget(targetPath, installRoot);
        if (removedTarget.status === "failed") {
          item.failed += 1;
          result.summary.failed += 1;
          item.status = item.restored > 0 || item.removed > 0 ? "partial" : "refused";
          result.ok = false;
          result.errors.push({
            code: removedTarget.code,
            message: removedTarget.message,
            skill,
            path: targetPath
          });
          result.rollbacks.push(item);
          continue;
        }
        removeReceiptInstallRecord(installs, skill, record);
        changedReceipt = true;
        receiptChangedSkills.add(skill);
        result.rollbacks.push(item);
        continue;
      }

      if (installWasPreviouslyUnmanagedReconcile(record)) {
        const removedBackup = await removeReconcileBackup({
          skill,
          targetPath,
          backupPath: rollbackState.backupPath,
          installRoot,
          beforeRemoval: __test?.beforeReconcileBackupRemoval
        });
        if (removedBackup.status === "failed") {
          item.failed += 1;
          result.summary.failed += 1;
          item.status = item.restored > 0 || item.removed > 0 ? "partial" : "refused";
          result.ok = false;
          result.errors.push({
            code: removedBackup.code,
            message: removedBackup.message,
            skill,
            path: removedBackup.path
          });
          result.rollbacks.push(item);
          continue;
        }
        removeReceiptInstallRecord(installs, skill, record);
        changedReceipt = true;
        receiptChangedSkills.add(skill);
        result.rollbacks.push(item);
        continue;
      }

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
      receiptChangedSkills.add(skill);
    }
    result.rollbacks.push(item);
  }

  if (changedReceipt) {
    try {
      await access(receiptPath, constants.W_OK);
      await updateAndWriteReceipt({
        installRoot,
        receiptPath: path.basename(receiptPath),
        receiptLock,
        update: (currentReceipt) => {
          const currentInstalls = isRecord(currentReceipt.installs)
            ? { ...currentReceipt.installs }
            : {};
          for (const skill of receiptChangedSkills) {
            if (JSON.stringify(currentInstalls[skill]) !== JSON.stringify(originalInstalls[skill])) {
              throw new Error(`Receipt record for ${skill} changed during rollback.`);
            }
            if (installs[skill] === undefined) delete currentInstalls[skill];
            else currentInstalls[skill] = installs[skill] as ReceiptInstallRecord | ReceiptInstallRecord[];
          }
          return { ...currentReceipt, installs: currentInstalls };
        }
      });
    } catch (error) {
      result.ok = false;
      let affectedItems = 0;
      for (const item of result.rollbacks) {
        if (item.status === "restored" && receiptChangedSkills.has(item.skill)) {
          item.status = item.restored > 0 || item.removed > 0 ? "partial" : "refused";
          item.failed += 1;
          affectedItems += 1;
        }
      }
      result.summary.failed += Math.max(affectedItems, 1);
      result.errors.push({
        code: "receipt_write_failed",
        message: `Failed to write rollback receipt ${receiptPath}: ${errorMessage(error)}`,
        path: receiptPath
      });
    }
  }

  if (result.errors.length > 0) {
    result.ok = false;
  }
  return result;
    });
  } catch (error) {
    result.ok = false;
    result.errors.push({
      code: "receipt_lock_failed",
      message: errorMessage(error),
      path: receiptPath
    });
    return result;
  }
}

function removeReceiptInstallRecord(
  installs: Record<string, unknown>,
  skill: string,
  record: ReceiptInstallRecord
): void {
  const existing = installs[skill];
  if (Array.isArray(existing)) {
    const nextRecords = existing.filter((entry) => entry !== record);
    if (nextRecords.length === 0) {
      delete installs[skill];
      return;
    }
    installs[skill] = nextRecords.length === 1 ? nextRecords[0] : nextRecords;
    return;
  }
  if (existing === record) {
    delete installs[skill];
  }
}

/**
 * Remove a Suitcase-created symlink as part of rollback. Only a link that still
 * points exactly at the recorded source (classification "correct") is removed,
 * and only the link itself is unlinked — never the source it points at. Any
 * other on-disk shape (a real directory where the link was, a retargeted or
 * broken link, a missing target) is refused as drift so rollback can never
 * delete a real directory it did not capture as rollback state.
 */
async function removeAppliedSymlink(
  rollback: { targetPath: string; expectedSourcePath: string },
  installRoot: string,
  afterClassification?: ((targetPath: string) => Promise<void> | void) | undefined
): Promise<
  | { kind: "removed" }
  | { kind: "refused"; message: string }
  | { kind: "failed"; message: string }
> {
  if (!(await symlinkParentIsRealDirectoryUnderInstallRoot(installRoot, rollback.targetPath))) {
    return {
      kind: "refused",
      message: `Refusing to remove ${rollback.targetPath}: its parent is not a real directory under ${installRoot}.`
    };
  }
  const classification = await classifySymlinkInstall({
    targetPath: rollback.targetPath,
    expectedSourcePath: rollback.expectedSourcePath
  });
  if (classification.state !== "correct") {
    return {
      kind: "refused",
      message: `Refusing to remove ${rollback.targetPath}: expected a symlink to ${rollback.expectedSourcePath} but found ${classification.state}.`
    };
  }
  await afterClassification?.(rollback.targetPath);
  if (!(await symlinkParentIsRealDirectoryUnderInstallRoot(installRoot, rollback.targetPath))) {
    return {
      kind: "refused",
      message: `Refusing to remove ${rollback.targetPath}: its parent is not a real directory under ${installRoot}.`
    };
  }
  const finalClassification = await classifySymlinkInstall({
    targetPath: rollback.targetPath,
    expectedSourcePath: rollback.expectedSourcePath
  });
  if (finalClassification.state !== "correct") {
    return {
      kind: "refused",
      message: `Refusing to remove ${rollback.targetPath}: expected a symlink to ${rollback.expectedSourcePath} but found ${finalClassification.state}.`
    };
  }
  try {
    await unlink(rollback.targetPath);
    return { kind: "removed" };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { kind: "removed" };
    }
    return {
      kind: "failed",
      message: `Failed to remove symlink ${rollback.targetPath}: ${errorMessage(error)}`
    };
  }
}

async function symlinkParentIsRealDirectoryUnderInstallRoot(
  installRoot: string,
  targetPath: string
): Promise<boolean> {
  const parentPath = path.dirname(targetPath);
  if (!isPathInsideOrSame(installRoot, parentPath)) {
    return false;
  }
  try {
    if (path.resolve(parentPath) !== path.resolve(installRoot)) {
      const parentInfo = await lstat(parentPath);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
        return false;
      }
      if (await pathHasSymlinkComponent(installRoot, parentPath)) {
        return false;
      }
    }
    const [resolvedInstallRoot, resolvedParentPath] = await Promise.all([
      realpath(installRoot),
      realpath(parentPath)
    ]);
    return isPathInsideOrSame(resolvedInstallRoot, resolvedParentPath);
  } catch {
    return false;
  }
}

async function rollbackMutationParentIsSafe(
  installRoot: string,
  targetPath: string,
  allowMissing: boolean
): Promise<boolean> {
  const parentPath = path.dirname(targetPath);
  if (!isPathInsideOrSame(installRoot, parentPath) || await pathHasSymlinkComponent(installRoot, parentPath)) {
    return false;
  }
  if (!allowMissing) {
    return symlinkParentIsRealDirectoryUnderInstallRoot(installRoot, targetPath);
  }
  try {
    const resolvedInstallRoot = await realpath(installRoot);
    let existingParent = parentPath;
    while (true) {
      try {
        return isPathInsideOrSame(resolvedInstallRoot, await realpath(existingParent));
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") return false;
        const nextParent = path.dirname(existingParent);
        if (nextParent === existingParent) return false;
        existingParent = nextParent;
      }
    }
  } catch {
    return false;
  }
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
    if (await pathHasSymlinkComponent(installRoot, targetPath)) {
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
    sourceHash: restoredStringFromPriorState(record.priorState, "installedHash")
      ?? await hashDirectory(targetPath).catch(() => null),
    version: await restoredVersion(targetPath, record),
    sourceCommit: restoredStringFromPriorState(record.priorState, "installedCommit")
  };
}

function installWasPreviouslyMissing(record: ReceiptInstallRecord): boolean {
  return isRecord(record.priorState) && record.priorState.status === "missing";
}

function installWasPreviouslyUnmanagedReconcile(record: ReceiptInstallRecord): boolean {
  return record.mode === "reconcile" && isRecord(record.priorState) && record.priorState.status === "unknown";
}

async function removeMissingInstallTarget(targetPath: string, installRoot: string): Promise<
  | { status: "removed" }
  | { status: "failed"; code: string; message: string }
> {
  try {
    if (!(await rollbackMutationParentIsSafe(installRoot, targetPath, true))) {
      throw new Error(`Refusing to remove ${targetPath}: its parent is not safely contained under ${installRoot}.`);
    }
    if (await rollbackTargetIsMissing(targetPath)) {
      if (!(await rollbackMutationParentIsSafe(installRoot, targetPath, true))) {
        throw new Error(`Refusing to accept missing target ${targetPath}: its parent is not safely contained under ${installRoot}.`);
      }
      return { status: "removed" };
    }
    if (!(await symlinkParentIsRealDirectoryUnderInstallRoot(installRoot, targetPath))) {
      throw new Error(`Refusing to remove ${targetPath}: its parent is not a real directory under ${installRoot}.`);
    }
    await rm(targetPath, { recursive: true, force: true });
    return { status: "removed" };
  } catch (error) {
    return {
      status: "failed",
      code: "rollback_remove_failed",
      message: `Failed to remove ${targetPath}: ${errorMessage(error)}`
    };
  }
}

async function removeReconcileBackup({
  skill,
  targetPath,
  backupPath,
  installRoot,
  beforeRemoval
}: {
  skill: string;
  targetPath: string;
  backupPath: string | null;
  installRoot: string;
  beforeRemoval?: ((backupPath: string) => Promise<void> | void) | undefined;
}): Promise<
  | { status: "removed" | "skipped" }
  | { status: "failed"; code: string; message: string; path: string }
> {
  if (backupPath === null) {
    return { status: "skipped" };
  }
  const validation = validateReconcileBackupPath({ skill, targetPath, backupPath });
  if (!validation.ok) {
    return {
      status: "failed",
      code: validation.code,
      message: validation.message,
      path: validation.path
    };
  }
  try {
    await beforeRemoval?.(backupPath);
    if (!(await rollbackMutationParentIsSafe(installRoot, backupPath, true))) {
      throw new Error(`Refusing to remove ${backupPath}: its parent is not safely contained under the receipt install root.`);
    }
    if (await rollbackTargetIsMissing(backupPath)) {
      if (!(await rollbackMutationParentIsSafe(installRoot, backupPath, true))) {
        throw new Error(`Refusing to accept missing backup ${backupPath}: its parent is not safely contained under the receipt install root.`);
      }
      return { status: "removed" };
    }
    if (!(await symlinkParentIsRealDirectoryUnderInstallRoot(installRoot, backupPath))) {
      throw new Error(`Refusing to remove ${backupPath}: its parent is not a real directory under the receipt install root.`);
    }
    await rm(backupPath, { recursive: true, force: true });
    return { status: "removed" };
  } catch (error) {
    return {
      status: "failed",
      code: "rollback_remove_failed",
      message: `Failed to remove reconcile backup ${backupPath}: ${errorMessage(error)}`,
      path: backupPath
    };
  }
}

function validateReconcileBackupPath({
  skill,
  targetPath,
  backupPath
}: {
  skill: string;
  targetPath: string;
  backupPath: string | null;
}): { ok: true } | { ok: false; code: string; message: string; path: string } {
  if (backupPath === null) {
    return { ok: true };
  }
  const backupParent = path.dirname(backupPath);
  const siblingBackup = backupParent === path.dirname(targetPath);
  const categorizedArchiveBackup = path.basename(backupParent) === ".archive"
    && path.dirname(backupParent) === path.dirname(path.dirname(targetPath));
  if ((siblingBackup || categorizedArchiveBackup) && path.basename(backupPath).startsWith(`.${skill}.suitcase-pre-reconcile-`)) {
    return { ok: true };
  }
  return {
    ok: false,
    code: "invalid_receipt",
    message: `Refusing to remove unexpected reconcile backup ${backupPath}.`,
    path: backupPath
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

async function restoreRollbackFile(
  file: RollbackFileRecord,
  installRoot: string,
  beforeMutation?: ((targetPath: string) => Promise<void> | void) | undefined,
  beforeOwnershipChange?: ((targetPath: string) => Promise<void> | void) | undefined
): Promise<
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
    return removeRollbackTarget(file, installRoot, beforeMutation);
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
  const temporaryPath = path.join(
    path.dirname(file.targetPath),
    `.suitcase-rollback-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
  let temporaryCreated = false;
  try {
    const currentTarget = await lstat(file.targetPath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    });
    if (currentTarget !== null && (!currentTarget.isFile() || currentTarget.isSymbolicLink())) {
      throw new Error(`Refusing to restore ${file.targetPath}: the target is not a regular file.`);
    }
    const replacementMode = currentTarget === null ? undefined : currentTarget.mode & 0o777;
    const replacementOwner = currentTarget === null ? null : { uid: currentTarget.uid, gid: currentTarget.gid };
    await beforeMutation?.(file.targetPath);
    if (!(await rollbackMutationParentIsSafe(installRoot, file.targetPath, true))) {
      throw new Error(`Refusing to restore ${file.targetPath}: its parent is not a real directory under ${installRoot}.`);
    }
    await mkdir(path.dirname(file.targetPath), { recursive: true });
    if (!(await symlinkParentIsRealDirectoryUnderInstallRoot(installRoot, file.targetPath))) {
      throw new Error(`Refusing to restore ${file.targetPath}: its parent is not a real directory under ${installRoot}.`);
    }
    const temporaryFile = await open(temporaryPath, "wx", replacementMode);
    temporaryCreated = true;
    try {
      await temporaryFile.writeFile(bytes);
      if (replacementOwner !== null && platform() !== "win32") {
        const temporaryOwner = await temporaryFile.stat();
        if (temporaryOwner.uid !== replacementOwner.uid || temporaryOwner.gid !== replacementOwner.gid) {
          await beforeOwnershipChange?.(file.targetPath);
          await temporaryFile.chown(replacementOwner.uid, replacementOwner.gid);
        }
      }
      if (replacementMode !== undefined) await temporaryFile.chmod(replacementMode);
    } finally {
      await temporaryFile.close();
    }
    if (!(await symlinkParentIsRealDirectoryUnderInstallRoot(installRoot, file.targetPath))) {
      throw new Error(`Refusing to restore ${file.targetPath}: its parent is not a real directory under ${installRoot}.`);
    }
    await rename(temporaryPath, file.targetPath);
    temporaryCreated = false;
  } catch (error) {
    let cleanupFailure = "";
    if (temporaryCreated) {
      try {
        if (!(await symlinkParentIsRealDirectoryUnderInstallRoot(installRoot, temporaryPath))) {
          throw new Error(`its parent is not a real directory under ${installRoot}`);
        }
        await unlink(temporaryPath);
      } catch (cleanupError) {
        cleanupFailure = `; temporary rollback file retained at ${temporaryPath}: ${errorMessage(cleanupError)}`;
      }
    }
    return {
      status: "failed",
      code: "restore_write_failed",
      message: `Failed to restore ${file.path}: ${errorMessage(error)}${cleanupFailure}`
    };
  }
  return { status: "restored" };
}

async function removeRollbackTarget(
  file: RollbackFileRecord,
  installRoot: string,
  beforeMutation?: ((targetPath: string) => Promise<void> | void) | undefined
): Promise<
  | { status: "removed" }
  | { status: "failed"; code: string; message: string }
> {
  try {
    await beforeMutation?.(file.targetPath);
    if (!(await rollbackMutationParentIsSafe(installRoot, file.targetPath, true))) {
      throw new Error(`Refusing to remove ${file.targetPath}: its parent is not safely contained under ${installRoot}.`);
    }
    if (await rollbackTargetIsMissing(file.targetPath)) {
      if (!(await rollbackMutationParentIsSafe(installRoot, file.targetPath, true))) {
        throw new Error(`Refusing to accept missing target ${file.targetPath}: its parent is not safely contained under ${installRoot}.`);
      }
      return { status: "removed" };
    }
    if (!(await symlinkParentIsRealDirectoryUnderInstallRoot(installRoot, file.targetPath))) {
      throw new Error(`Refusing to remove ${file.targetPath}: its parent is not a real directory under ${installRoot}.`);
    }
    await unlink(file.targetPath);
    return { status: "removed" };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      if (await rollbackMutationParentIsSafe(installRoot, file.targetPath, true)) {
        return { status: "removed" };
      }
      return {
        status: "failed",
        code: "rollback_remove_failed",
        message: `Failed to remove ${file.path}: its parent is not safely contained under ${installRoot}.`
      };
    }
    if (isNodeError(error) && (error.code === "EISDIR" || error.code === "EPERM") && await isDirectory(file.targetPath)) {
      try {
        if (!(await symlinkParentIsRealDirectoryUnderInstallRoot(installRoot, file.targetPath))) {
          throw new Error(`Refusing to remove ${file.targetPath}: its parent is not a real directory under ${installRoot}.`);
        }
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

async function rollbackTargetIsMissing(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return false;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
}

async function isDirectory(candidatePath: string): Promise<boolean> {
  try {
    return (await lstat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
