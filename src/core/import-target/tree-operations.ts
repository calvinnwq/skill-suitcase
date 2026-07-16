import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { buildInstalledFiles } from "../receipts/index.js";

/**
 * Safe-tree filesystem boundary owned by import-target.
 *
 * Import-target planning, apply, verification, and rollback all operate on the
 * same narrow filesystem contract: a catalog or target skill tree contains only
 * real directories and regular files, is listed and hashed deterministically,
 * is copied with executable modes preserved via `copyFile`, and is only ever
 * mutated at the explicitly supplied catalog/target/staging paths. This module
 * owns those mechanics: recursive tree validation that rejects symlinks and
 * unsupported filesystem entries, deterministic listing and directory hashing,
 * copy and equality verification, best-effort remove/restore recovery helpers,
 * and the categorized-target parent containment check.
 *
 * Workflow policy stays in `src/core/import-target/index.ts`: import planning,
 * receipt and status interpretation, transaction locking, error translation
 * other than the exact validation errors below, and result construction. This
 * module is deliberately import-target-private, not a cross-workflow
 * filesystem abstraction.
 */

export type TreeValidationCodes = {
  symlinkCode: string;
  unreadableCode: string;
  missingCode: string;
  label: string;
};

export type TreeValidationError = {
  code: string;
  message: string;
  path: string;
};

export type DirectoryTreeValidationResult =
  | { ok: true }
  | { ok: false; error: TreeValidationError };

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
        message: `${codes.label} directory ${rootPath} is a symlink and cannot be imported safely.`,
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

  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isSymbolicLink()) {
      return {
        ok: false,
        error: {
          code: codes.symlinkCode,
          message: `${codes.label} tree ${rootPath} contains a symlink at ${entryPath} and cannot be imported safely.`,
          path: entryPath
        }
      };
    }
    if (entry.isDirectory()) {
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
        message: `${codes.label} tree ${rootPath} contains an unsupported filesystem entry at ${entryPath} and cannot be imported safely.`,
        path: entryPath
      }
    };
  }
  return { ok: true };
}

export async function hashDirectory(root: string): Promise<string> {
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

export async function copyTree(
  sourcePath: string,
  targetPath: string,
  options: { failAfterCreate?: boolean } = {}
): Promise<void> {
  if (isSameOrInsidePath(targetPath, sourcePath)) {
    throw new Error(`Refusing to copy ${sourcePath} into nested destination ${targetPath}.`);
  }
  await mkdir(targetPath, { recursive: true });
  if (options.failAfterCreate === true) {
    throw new Error("Injected failure during copy.");
  }
  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      continue;
    }
    const from = path.join(sourcePath, entry.name);
    const to = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to);
      continue;
    }
    if (entry.isFile()) {
      await copyFile(from, to);
    }
  }
}

export async function treesMatch(left: string, right: string): Promise<boolean> {
  const [leftFiles, rightFiles] = await Promise.all([
    buildInstalledFiles(left),
    buildInstalledFiles(right)
  ]);
  if (leftFiles.length !== rightFiles.length) {
    return false;
  }
  for (let index = 0; index < leftFiles.length; index += 1) {
    const leftFile = leftFiles[index];
    const rightFile = rightFiles[index];
    if (leftFile === undefined || rightFile === undefined || leftFile.path !== rightFile.path || leftFile.hash !== rightFile.hash) {
      return false;
    }
  }
  return true;
}

export async function removePath(targetPath: string): Promise<void> {
  try {
    await rm(targetPath, { recursive: true, force: true });
  } catch {
    // best effort cleanup only
  }
}

export async function restorePath(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    // best effort restore only
  }
}

export function isSameOrInsidePath(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export async function assertCategorizedTargetParentInsideInstallRoot(targetPath: string, installRoot: string): Promise<void> {
  const lexicalRoot = path.resolve(installRoot);
  const lexicalParent = path.resolve(path.dirname(targetPath));
  const relativeParent = path.relative(lexicalRoot, lexicalParent);
  if (relativeParent === "") {
    return;
  }
  if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    throw new Error(`Target parent ${lexicalParent} escapes install root ${lexicalRoot}.`);
  }

  let current = lexicalRoot;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new Error(`Target parent component ${current} is a symlink.`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Target parent component ${current} is not a directory.`);
    }
  }

  const [resolvedRoot, resolvedParent] = await Promise.all([
    realpath(lexicalRoot),
    realpath(lexicalParent)
  ]);
  if (!isSameOrInsidePath(resolvedParent, resolvedRoot)) {
    throw new Error(`Target parent ${lexicalParent} resolves outside install root ${lexicalRoot}.`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
