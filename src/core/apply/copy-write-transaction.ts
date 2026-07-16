import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApplyFinding } from "./approval-context.js";

/**
 * Copy-mode apply write transaction: per-entry mutation with rollback-state
 * capture, apply-local backups, failed-write recovery, partial-apply rollback,
 * backup cleanup, and parent-path revalidation under the approved install
 * root. This module accepts already validated write entries and roots; it
 * cannot resolve commands, approval inputs, target adapters, or process
 * output. Apply orchestration, diff/status decisions, symlink-mode apply, and
 * receipt transaction orchestration stay in index.ts.
 */

export type WriteEntry = {
  skill: string;
  relativePath: string;
  sourcePath: string;
  targetPath: string;
};

export type RestorePlanEntry = {
  targetPath: string;
  backupPath: string | null;
};

export type RollbackFileState = {
  kind: "file";
  sha256: string;
  bytes: string;
} | {
  kind: "missing";
} | {
  kind: "restore-impossible";
  reason: string;
};

export type RollbackFileRecord = {
  path: string;
  targetPath: string;
  previous: RollbackFileState;
};

export type RollbackRecord = {
  schema: "calvinnwq.skills.rollback.v0";
  status: "available";
  targetPath: string;
  files: RollbackFileRecord[];
};

export type CopyWriteTransactionOutcome = {
  ok: true;
  rollbackBySkill: Map<string, RollbackRecord>;
  restorePlan: RestorePlanEntry[];
  filesAppliedBySkill: Map<string, number>;
} | {
  ok: false;
  errors: ApplyFinding[];
};

type WritePlannedSkillInput = {
  skill: string;
  entries: WriteEntry[];
  installRoot: string;
  failAfterSuccessfulWrites: number | null;
  successfulWritesRef: {
    value: number;
  };
  afterBackup?: ((targetPath: string, backupPath: string) => Promise<void> | void) | undefined;
};

type WritePlannedSkillResult = {
  ok: true;
  successfulWrites: number;
  restorePlan: RestorePlanEntry[];
} | {
  ok: false;
  message: string;
  successfulWrites: number;
  restorePlan: RestorePlanEntry[];
  recoveryErrors: string[];
};

/**
 * Write every planned copy-mode entry, skill by skill, capturing rollback
 * state before each skill mutates. A failed skill rolls back its own entries
 * and every previously written skill before returning the failure findings,
 * so the target root is never left half-applied by this operation.
 */
export async function executeCopyWriteTransaction({
  writeEntries,
  installRoot,
  sourceBySkill,
  destinationBySkill,
  failAfterSuccessfulWrites,
  beforeWriteForSkill,
  afterBackup
}: {
  writeEntries: WriteEntry[];
  installRoot: string;
  sourceBySkill: Map<string, string>;
  destinationBySkill: Map<string, string>;
  failAfterSuccessfulWrites: number | null;
  beforeWriteForSkill?: ((skill: string) => Promise<void> | void) | undefined;
  afterBackup?: ((targetPath: string, backupPath: string) => Promise<void> | void) | undefined;
}): Promise<CopyWriteTransactionOutcome> {
  const entriesBySkill = new Map<string, WriteEntry[]>();
  for (const entry of writeEntries) {
    const bucket = entriesBySkill.get(entry.skill);
    if (bucket === undefined) {
      entriesBySkill.set(entry.skill, [entry]);
      continue;
    }
    bucket.push(entry);
  }

  const rollbackBySkill = new Map<string, RollbackRecord>();
  const filesAppliedBySkill = new Map<string, number>();
  const restorePlan: RestorePlanEntry[] = [];
  const successfulWritesRef = {
    value: 0
  };
  let writeResult: WritePlannedSkillResult;

  for (const [skill, entries] of entriesBySkill) {
    const skillSource = sourceBySkill.get(skill);
    if (!skillSource) {
      return {
        ok: false,
        errors: [{ code: "missing_skill_source", message: `No source path for ${skill}` }]
      };
    }

    await beforeWriteForSkill?.(skill);
    rollbackBySkill.set(skill, await buildRollbackRecord({
      targetPath: path.join(installRoot, destinationBySkill.get(skill) ?? skill),
      entries
    }));

    writeResult = await writePlannedSkillEntries({
      skill,
      entries,
      installRoot,
      failAfterSuccessfulWrites,
      successfulWritesRef,
      afterBackup
    });

    if (!writeResult.ok) {
      const recoveryErrors = [
        ...writeResult.recoveryErrors,
        ...await rollbackApplyWrites({
          restorePlan,
          installRoot
        })
      ];
      return {
        ok: false,
        errors: [
          { code: "write_error", message: writeResult.message },
          ...recoveryErrors.map((message) => ({ code: "apply_recovery_failed", message }))
        ]
      };
    }

    filesAppliedBySkill.set(skill, entries.length);
    restorePlan.push(...writeResult.restorePlan);
    successfulWritesRef.value = writeResult.successfulWrites;
  }

  return { ok: true, rollbackBySkill, restorePlan, filesAppliedBySkill };
}

async function buildRollbackRecord({
  targetPath,
  entries
}: {
  targetPath: string;
  entries: WriteEntry[];
}): Promise<RollbackRecord> {
  const files: RollbackFileRecord[] = [];
  for (const entry of entries) {
    files.push({
      path: entry.relativePath,
      targetPath: entry.targetPath,
      previous: await readRollbackFileState(entry.targetPath)
    });
  }

  return {
    schema: "calvinnwq.skills.rollback.v0",
    status: "available",
    targetPath,
    files: files.sort((left, right) => left.path.localeCompare(right.path))
  };
}

async function readRollbackFileState(filePath: string): Promise<RollbackFileState> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) {
      return {
        kind: "restore-impossible",
        reason: "target was a symbolic link"
      };
    }
    if (!info.isFile()) {
      return {
        kind: "restore-impossible",
        reason: "target was not a regular file"
      };
    }
    const bytes = await readFile(filePath);
    return {
      kind: "file",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.toString("base64")
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { kind: "missing" };
    }
    return {
      kind: "restore-impossible",
      reason: error instanceof Error ? error.message : "target could not be read"
    };
  }
}

async function writePlannedSkillEntries(
  {
    skill,
    entries,
    installRoot,
    failAfterSuccessfulWrites,
    successfulWritesRef,
    afterBackup
  }: WritePlannedSkillInput
): Promise<WritePlannedSkillResult> {
  const tempSuffix = `suitcase-apply-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const nextRestorePlan: RestorePlanEntry[] = [];

  try {
    for (const entry of entries) {
      await writePlannedEntryWithRollback({
        entry,
        restorePlan: nextRestorePlan,
        tempSuffix,
        installRoot,
        afterBackup
      });

      successfulWritesRef.value += 1;
      const wroteCount = successfulWritesRef.value;

      if (failAfterSuccessfulWrites !== null && wroteCount === failAfterSuccessfulWrites) {
        throw new Error(`Injected write failure for ${skill} after ${wroteCount} successful writes`);
      }
    }

    return {
      ok: true,
      successfulWrites: successfulWritesRef.value,
      restorePlan: nextRestorePlan
    };
  } catch (error) {
    const recoveryErrors: string[] = [];
    const retainedRestorePlan: RestorePlanEntry[] = [];
    for (const plannedRestore of [...nextRestorePlan].reverse()) {
      const recovery = await rollbackPlannedEntry(plannedRestore, installRoot);
      if (!recovery.ok) {
        recoveryErrors.push(recovery.message);
        retainedRestorePlan.push(plannedRestore);
      }
    }

    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unknown write error",
      successfulWrites: successfulWritesRef.value,
      restorePlan: retainedRestorePlan.reverse(),
      recoveryErrors
    };
  }
}

async function writePlannedEntryWithRollback({
  entry,
  tempSuffix,
  restorePlan,
  installRoot,
  afterBackup
}: {
  entry: WriteEntry;
  tempSuffix: string;
  restorePlan: RestorePlanEntry[];
  installRoot: string;
  afterBackup?: ((targetPath: string, backupPath: string) => Promise<void> | void) | undefined;
}): Promise<void> {
  const targetPath = entry.targetPath;
  const sourcePath = entry.sourcePath;
  const tmpPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let backupPath: string | null = null;

  try {
    await assertSafeMutationParent(targetPath, installRoot, true);

    if (await statSafe(targetPath) !== null) {
      backupPath = `${targetPath}.previous-${tempSuffix}`;
      await assertSafeMutationParent(targetPath, installRoot, false);
      await rename(targetPath, backupPath);
      await afterBackup?.(targetPath, backupPath);
    }

    const sourceMode = (await stat(sourcePath)).mode & 0o777;
    const contents = await readFile(sourcePath);
    await assertSafeMutationParent(targetPath, installRoot, false);
    await writeFile(tmpPath, contents, { mode: sourceMode });
    await chmod(tmpPath, sourceMode);
    await assertSafeMutationParent(targetPath, installRoot, false);
    await rename(tmpPath, targetPath);
    restorePlan.push({
      targetPath,
      backupPath
    });
  } catch (error) {
    const recoveryErrors: string[] = [];
    const plannedRestore = {
      targetPath,
      backupPath
    };
    const recovery = await rollbackPlannedEntry(plannedRestore, installRoot);
    if (!recovery.ok) {
      recoveryErrors.push(recovery.message);
      restorePlan.push(plannedRestore);
    }
    try {
      await assertSafeMutationParent(tmpPath, installRoot, false);
      await unlink(tmpPath);
    } catch (cleanupError) {
      if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT") {
        recoveryErrors.push(`Temporary apply path retained at ${tmpPath}: ${errorMessage(cleanupError)}`);
      }
    }
    const message = errorMessage(error);
    throw new Error(recoveryErrors.length === 0
      ? message
      : `${message}; recovery errors: ${recoveryErrors.join("; ")}`);
  }
}

async function rollbackPlannedEntry({
  targetPath,
  backupPath
}: RestorePlanEntry, installRoot: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await assertSafeMutationParent(targetPath, installRoot, false);
    if (backupPath !== null) await assertSafeMutationParent(backupPath, installRoot, false);
  } catch (error) {
    return {
      ok: false,
      message: `Apply recovery refused for ${targetPath}${backupPath === null ? "" : `; backup retained at ${backupPath}`}: ${errorMessage(error)}`
    };
  }
  if (backupPath === null) {
    try {
      await unlink(targetPath);
      return { ok: true };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { ok: true };
      return { ok: false, message: `Apply recovery could not remove ${targetPath}: ${errorMessage(error)}` };
    }
  }

  try {
    await rename(backupPath, targetPath);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `Apply recovery could not restore ${targetPath}; backup retained at ${backupPath}: ${errorMessage(error)}`
    };
  }
}

export async function rollbackApplyWrites({
  restorePlan,
  installRoot
}: {
  restorePlan: RestorePlanEntry[];
  installRoot: string;
}): Promise<string[]> {
  const recoveryErrors: string[] = [];
  for (const plannedRestore of [...restorePlan].reverse()) {
    const recovery = await rollbackPlannedEntry(plannedRestore, installRoot);
    if (!recovery.ok) recoveryErrors.push(recovery.message);
  }
  return recoveryErrors;
}

export async function cleanupApplyBackups({
  restorePlan,
  installRoot,
  beforeCleanup
}: {
  restorePlan: RestorePlanEntry[];
  installRoot: string;
  beforeCleanup?: ((targetPath: string, backupPath: string) => Promise<void> | void) | undefined;
}): Promise<string[]> {
  const errors: string[] = [];
  for (const plannedRestore of restorePlan) {
    if (plannedRestore.backupPath !== null) {
      try {
        await beforeCleanup?.(plannedRestore.targetPath, plannedRestore.backupPath);
        await assertSafeMutationParent(plannedRestore.backupPath, installRoot, false);
        await unlink(plannedRestore.backupPath);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        errors.push(`Apply backup retained at ${plannedRestore.backupPath}: ${errorMessage(error)}`);
      }
    }
  }
  return errors;
}

export async function assertSafeMutationParent(
  targetPath: string,
  installRoot: string,
  createMissing: boolean
): Promise<void> {
  const lexicalRoot = path.resolve(installRoot);
  const lexicalParent = path.resolve(path.dirname(targetPath));
  if (!isInsideOrEqual(lexicalParent, lexicalRoot)) {
    throw new Error(`Target parent ${lexicalParent} escapes install root ${lexicalRoot}.`);
  }

  let current = lexicalRoot;
  const relativeParts = path.relative(lexicalRoot, lexicalParent).split(path.sep).filter(Boolean);
  for (const part of relativeParts) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Target parent component ${current} is a symlink.`);
      if (!info.isDirectory()) throw new Error(`Target parent component ${current} is not a directory.`);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") break;
      throw error;
    }
  }

  const canonicalRoot = await realpath(lexicalRoot);
  let existingParent = lexicalParent;
  while (true) {
    try {
      const canonicalExistingParent = await realpath(existingParent);
      if (!isInsideOrEqual(canonicalExistingParent, canonicalRoot)) {
        throw new Error(`Target parent ${lexicalParent} resolves outside install root ${lexicalRoot}.`);
      }
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(existingParent);
      if (parent === existingParent) throw error;
      existingParent = parent;
    }
  }

  if (createMissing) await mkdir(lexicalParent, { recursive: true });
  const canonicalParent = await realpath(lexicalParent);
  if (!isInsideOrEqual(canonicalParent, canonicalRoot)) {
    throw new Error(`Target parent ${lexicalParent} resolves outside install root ${lexicalRoot}.`);
  }
}

function isInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
