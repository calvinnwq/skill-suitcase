import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  sourcePolicyDecision,
  sourcePolicyPrunesDirectory,
  type SourcePolicy
} from "../source-policy.js";
import { listDirectories, listFiles } from "../staged-swap.js";

/**
 * Safe-tree preflight and rollback-state capture owned by repair.
 *
 * Before repair mutates a target it validates that both the catalog source
 * tree and the live target tree contain only real directories and regular
 * files, and after the staged swap it captures the pre-repair target bytes as
 * deterministic rollback records so `rollback --receipt` can restore the dirty
 * target exactly. This module owns that preparation phase: recursive tree
 * validation that rejects symlinks and unsupported filesystem entries,
 * rollback file-state capture with content, hash, and missing-file
 * representation preserved exactly, and the deterministic path ordering and
 * ancestor-containment checks used while recording replaced and created
 * paths. It only reads the trees it is given; it never writes into a live
 * target.
 *
 * Workflow policy stays in `src/core/repair/index.ts`: repair planning, status
 * routing, staged-swap execution via `src/core/staged-swap.ts`, receipt
 * transactions, post-repair verification, and result construction. This
 * module is deliberately repair-private, not a cross-workflow filesystem
 * abstraction.
 */

export type TreeValidationCodes = {
  symlinkCode: string;
  unreadableCode: string;
  missingCode: string;
  label: string;
  rejectEmptyDirectories?: boolean;
  sourcePolicy?: SourcePolicy | undefined;
};

export type TreeValidationError = {
  code: string;
  message: string;
  path: string;
};

export type DirectoryTreeValidationResult =
  | { ok: true }
  | { ok: false; error: TreeValidationError };

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

export async function validateDirectoryTree(
  rootPath: string,
  codes: TreeValidationCodes
): Promise<DirectoryTreeValidationResult> {
  let info: Stats;
  try {
    info = await lstat(rootPath);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: isNodeError(error) && error.code === "ENOENT" ? codes.missingCode : codes.unreadableCode,
        message: `${codes.label} directory ${rootPath} could not be read: ${errorMessage(error)}`,
        path: rootPath
      }
    };
  }

  if (info.isSymbolicLink()) {
    return {
      ok: false,
      error: {
        code: codes.symlinkCode,
        message: `${codes.label} directory ${rootPath} is a symlink and cannot be repaired safely.`,
        path: rootPath
      }
    };
  }

  if (!info.isDirectory()) {
    return {
      ok: false,
      error: {
        code: codes.unreadableCode,
        message: `${codes.label} path ${rootPath} is not a directory.`,
        path: rootPath
      }
    };
  }

  return validateDirectoryEntries(rootPath, rootPath, codes);
}

async function validateDirectoryEntries(
  rootPath: string,
  currentPath: string,
  codes: TreeValidationCodes
): Promise<DirectoryTreeValidationResult> {
  let entries: Dirent[];
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: codes.unreadableCode,
        message: `${codes.label} directory ${rootPath} could not be scanned: ${errorMessage(error)}`,
        path: currentPath
      }
    };
  }

  if (codes.rejectEmptyDirectories === true && currentPath !== rootPath && entries.length === 0) {
    return {
      ok: false,
      error: {
        code: codes.symlinkCode,
        message: `${codes.label} tree ${rootPath} contains an empty directory at ${currentPath} and cannot be rollback-recorded safely.`,
        path: currentPath
      }
    };
  }

  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, entryPath);
    const policyDecision = codes.sourcePolicy === undefined
      ? { action: "include" as const, pattern: null }
      : sourcePolicyDecision(relativePath, codes.sourcePolicy);
    if (policyDecision.action === "exclude") {
      continue;
    }
    if (policyDecision.action === "deny") {
      return {
        ok: false,
        error: {
          code: codes.symlinkCode,
          message: `${codes.label} tree ${rootPath} contains a source-policy denied path at ${entryPath} and cannot be repaired safely.`,
          path: entryPath
        }
      };
    }
    if (entry.isSymbolicLink()) {
      return {
        ok: false,
        error: {
          code: codes.symlinkCode,
          message: `${codes.label} tree ${rootPath} contains a symlink at ${entryPath} and cannot be repaired safely.`,
          path: entryPath
        }
      };
    }
    if (entry.isDirectory()) {
      if (codes.sourcePolicy !== undefined && sourcePolicyPrunesDirectory(relativePath, codes.sourcePolicy)) {
        continue;
      }
      const nested = await validateDirectoryEntries(rootPath, entryPath, codes);
      if (!nested.ok) {
        return nested;
      }
      continue;
    }
    if (entry.isFile()) {
      continue;
    }
    return {
      ok: false,
      error: {
        code: codes.symlinkCode,
        message: `${codes.label} tree ${rootPath} contains an unsupported filesystem entry at ${entryPath} and cannot be repaired safely.`,
        path: entryPath
      }
    };
  }
  return { ok: true };
}

export async function buildRollbackFiles({
  previousTargetPath,
  appliedTargetPath
}: {
  previousTargetPath: string;
  appliedTargetPath: string;
}): Promise<RollbackFileRecord[]> {
  const previousFiles = await listFiles(previousTargetPath);
  const appliedFiles = await listFiles(appliedTargetPath);
  const appliedDirectories = await listDirectories(appliedTargetPath);
  const replacedDirectories: string[] = [];
  const replacedFiles: string[] = [];
  const createdDirectories: string[] = [];
  for (const relativePath of appliedDirectories.sort(compareShallowestPathFirst)) {
    if (hasPathAncestor(replacedDirectories, relativePath)) {
      continue;
    }
    const previousDirectoryState = await lstat(path.join(previousTargetPath, relativePath)).catch((error: unknown) => {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return null;
      }
      throw error;
    });
    if (previousDirectoryState === null) {
      createdDirectories.push(relativePath);
      continue;
    }
    if (!previousDirectoryState.isDirectory()) {
      replacedDirectories.push(relativePath);
    }
  }
  for (const relativePath of appliedFiles.sort(compareShallowestPathFirst)) {
    if (hasPathAncestor(replacedDirectories, relativePath)) {
      continue;
    }
    const previousFileState = await lstat(path.join(previousTargetPath, relativePath)).catch((error: unknown) => {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return null;
      }
      throw error;
    });
    if (previousFileState?.isDirectory() === true) {
      replacedFiles.push(relativePath);
    }
  }
  const relativePaths = [...new Set([...previousFiles, ...appliedFiles])].sort();
  const records: RollbackFileRecord[] = [];
  for (const relativePath of [...replacedDirectories, ...replacedFiles].sort(compareShallowestPathFirst)) {
    records.push({
      path: relativePath,
      targetPath: path.join(appliedTargetPath, relativePath),
      previous: { kind: "missing" }
    });
  }
  for (const relativePath of relativePaths) {
    if (hasPathAncestor(replacedDirectories, relativePath) || replacedFiles.includes(relativePath)) {
      continue;
    }
    records.push({
      path: relativePath,
      targetPath: path.join(appliedTargetPath, relativePath),
      previous: await readRollbackFileState(path.join(previousTargetPath, relativePath))
    });
  }
  for (const relativePath of createdDirectories.sort(compareDeepestPathFirst)) {
    records.push({
      path: relativePath,
      targetPath: path.join(appliedTargetPath, relativePath),
      previous: { kind: "missing" }
    });
  }
  return records;
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
      reason: errorMessage(error)
    };
  }
}

function compareDeepestPathFirst(left: string, right: string): number {
  const depthDifference = right.split(path.sep).length - left.split(path.sep).length;
  return depthDifference === 0 ? left.localeCompare(right) : depthDifference;
}

function compareShallowestPathFirst(left: string, right: string): number {
  const depthDifference = left.split(path.sep).length - right.split(path.sep).length;
  return depthDifference === 0 ? left.localeCompare(right) : depthDifference;
}

function hasPathAncestor(ancestors: string[], candidate: string): boolean {
  return ancestors.some((ancestor) => {
    const relativePath = path.relative(ancestor, candidate);
    return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
