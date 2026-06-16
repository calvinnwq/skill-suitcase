import { lstat, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Canonical identifier for the symlink install mode recorded in Suitcase
 * receipts. Status (and later apply/track/rollback) branch on the receipt mode
 * instead of inferring an install mode from filesystem shape alone.
 */
export const SYMLINK_MODE = "symlink";

/**
 * The distinct on-disk states a managed symlink install can be in, relative to
 * the catalog source path the receipt selected. These mirror the symlink-state
 * list in ARCHITECTURE.md so status, track, and rollback agree on one taxonomy.
 */
export type SymlinkInstallState =
  | "correct"
  | "wrong-target"
  | "broken"
  | "real-directory"
  | "not-symlink"
  | "missing";

export type SymlinkClassification = {
  state: SymlinkInstallState;
  targetPath: string;
  expectedSourcePath: string;
  /** Resolved absolute path the symlink points at, or null when not a symlink. */
  linkTarget: string | null;
};

/**
 * Source-root escape guard. Returns true only when `candidatePath` resolves to
 * the approved `rootPath` or a descendant of it after resolving filesystem
 * symlinks.
 */
export async function isPathWithinRoot({
  candidatePath,
  rootPath
}: {
  candidatePath: string;
  rootPath: string;
}): Promise<boolean> {
  let resolvedRoot: string;
  let resolvedCandidate: string;
  try {
    [resolvedRoot, resolvedCandidate] = await Promise.all([
      realpath(rootPath),
      realpath(candidatePath)
    ]);
  } catch {
    return false;
  }

  if (resolvedCandidate === resolvedRoot) {
    return true;
  }
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Classify the install at `targetPath` against the source path the catalog
 * selected. This is read-only: it never mutates the target and never follows a
 * symlink to mutate anything. Comparison is lexical (matching how the symlink is
 * created during apply) so results are deterministic across platforms.
 */
export async function classifySymlinkInstall({
  targetPath,
  expectedSourcePath
}: {
  targetPath: string;
  expectedSourcePath: string;
}): Promise<SymlinkClassification> {
  const expected = path.resolve(expectedSourcePath);

  let info;
  try {
    info = await lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return base("missing", targetPath, expected, null);
    }
    throw error;
  }

  if (info.isSymbolicLink()) {
    const linkTarget = await resolveLinkTarget(targetPath);
    if (linkTarget === null) {
      return base("broken", targetPath, expected, null);
    }
    if (!(await pathExists(linkTarget))) {
      return base("broken", targetPath, expected, linkTarget);
    }
    return base(linkTarget === expected ? "correct" : "wrong-target", targetPath, expected, linkTarget);
  }

  if (info.isDirectory()) {
    return base("real-directory", targetPath, expected, null);
  }

  return base("not-symlink", targetPath, expected, null);
}

function base(
  state: SymlinkInstallState,
  targetPath: string,
  expectedSourcePath: string,
  linkTarget: string | null
): SymlinkClassification {
  return { state, targetPath, expectedSourcePath, linkTarget };
}

async function resolveLinkTarget(targetPath: string): Promise<string | null> {
  try {
    const raw = await readlink(targetPath);
    return path.resolve(path.dirname(targetPath), raw);
  } catch {
    return null;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
