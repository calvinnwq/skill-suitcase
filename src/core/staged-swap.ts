import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  collectSourcePolicyDeniedPaths,
  sourcePolicyDecision,
  sourcePolicyPrunesDirectory,
  type SourcePolicy
} from "./source-policy.js";

/**
 * Shared staged-directory replacement boundary for the repair and reconcile
 * workflows.
 *
 * Both workflows replace a live target directory with a fresh copy of catalog
 * source through the same filesystem lifecycle: validate the target parent,
 * prepare a real transaction directory, stage the source tree under source
 * policy, verify the staged tree, move the current target to a workflow-named
 * backup, move the staged tree into place, and recover by restoring backups
 * and cleaning incomplete staged copies when any step fails. This module owns
 * only those mechanics and reports structured filesystem facts back to the
 * caller.
 *
 * Workflow policy stays in the owning modules: candidate planning and refusal
 * rules, backup and staging path names, receipt install records and receipt
 * writes, rollback metadata collection, error codes, result shapes, and
 * post-operation status checks.
 *
 * Two behavior differences stay explicit instead of being normalized away:
 * `requireDirectoryParents` preserves reconcile's stricter rejection of a
 * target parent component that is not a directory, and `workflow` labels the
 * recovery facts with each caller's exact existing wording.
 */
export type StagedSwapContext = {
  installRoot: string;
  sourcePath: string;
  targetPath: string;
  backupPath: string;
  stagingPath: string;
  /** Workflow label used verbatim in recovery fact messages. */
  workflow: string;
  /** Reconcile rejects non-directory target parent components; repair does not. */
  requireDirectoryParents: boolean;
  sourcePolicy?: SourcePolicy | undefined;
};

export type StagedSwapRecovery = {
  /** Ordered recovery facts: target recovery first, then staged-copy cleanup. */
  errors: string[];
  /** True when the backup had to be retained because restoration was incomplete. */
  backupRetained: boolean;
};

export type StagedDirectorySwap = {
  /**
   * Validate the target parent, prepare the transaction directory, validate
   * source policy, and stage the source tree at the staging path.
   */
  stageSourceTree: () => Promise<void>;
  /** Verify the staged tree matches the source tree under source policy. */
  stagedTreeMatchesSource: () => Promise<boolean>;
  /** Move the current target to the workflow-named backup path. */
  moveTargetToBackup: () => Promise<void>;
  /** Move the staged tree into the target location. */
  installStagedTree: () => Promise<void>;
  /**
   * Undo whatever this swap completed: remove an installed target, restore the
   * backup, and clean an incomplete staged copy when safe. Never throws;
   * incomplete recovery is reported as structured facts.
   */
  recoverAfterFailure: () => Promise<StagedSwapRecovery>;
};

export function beginStagedSwap(context: StagedSwapContext): StagedDirectorySwap {
  const {
    installRoot,
    sourcePath,
    targetPath,
    backupPath,
    stagingPath,
    workflow,
    requireDirectoryParents,
    sourcePolicy
  } = context;
  const assertParentSafe = (candidatePath: string): Promise<void> =>
    assertTargetParentInsideInstallRoot(candidatePath, installRoot, requireDirectoryParents);
  let staged = false;
  let backedUp = false;
  let installed = false;

  return {
    async stageSourceTree(): Promise<void> {
      await assertParentSafe(targetPath);
      await ensureTransactionDirectory(
        transactionDirectoryForTarget(targetPath, installRoot),
        installRoot,
        requireDirectoryParents
      );
      await assertParentSafe(stagingPath);
      await assertSourcePolicyAllowsSource(sourcePath, sourcePolicy);
      await copyTree(sourcePath, stagingPath, sourcePolicy);
      staged = true;
    },
    stagedTreeMatchesSource(): Promise<boolean> {
      return treesMatch(sourcePath, stagingPath, sourcePolicy);
    },
    async moveTargetToBackup(): Promise<void> {
      await assertParentSafe(targetPath);
      await assertParentSafe(backupPath);
      await rename(targetPath, backupPath);
      backedUp = true;
    },
    async installStagedTree(): Promise<void> {
      await assertParentSafe(targetPath);
      await assertParentSafe(stagingPath);
      await rename(stagingPath, targetPath);
      installed = true;
      staged = false;
    },
    async recoverAfterFailure(): Promise<StagedSwapRecovery> {
      const errors = await recoverSwappedTarget({
        targetPath,
        backupPath,
        installed,
        backedUp,
        installRoot,
        requireDirectoryParents,
        workflow
      });
      const backupRetained = backedUp && errors.length > 0;
      if (staged) {
        try {
          await assertParentSafe(stagingPath);
          await removePath(stagingPath);
        } catch (cleanupError) {
          errors.push(`Temporary ${workflow} copy retained at ${stagingPath}: ${errorMessage(cleanupError)}`);
        }
      }
      return { errors, backupRetained };
    }
  };
}

/**
 * Restore a replaced target after a failure: remove the installed tree when
 * present, then move the backup into place. Returns recovery facts instead of
 * throwing so callers can unwind remaining candidates.
 */
export async function recoverSwappedTarget({
  targetPath,
  backupPath,
  installed,
  backedUp,
  installRoot,
  requireDirectoryParents,
  workflow
}: {
  targetPath: string;
  backupPath: string;
  installed: boolean;
  backedUp: boolean;
  installRoot: string;
  requireDirectoryParents: boolean;
  workflow: string;
}): Promise<string[]> {
  const errors: string[] = [];
  let targetReady = true;
  if (installed) {
    try {
      await assertTargetParentInsideInstallRoot(targetPath, installRoot, requireDirectoryParents);
      await removePath(targetPath);
    } catch (error) {
      targetReady = false;
      errors.push(`Could not safely remove failed ${workflow} target ${targetPath}: ${errorMessage(error)}`);
    }
  }
  if (backedUp && targetReady) {
    try {
      await assertTargetParentInsideInstallRoot(targetPath, installRoot, requireDirectoryParents);
      await assertTargetParentInsideInstallRoot(backupPath, installRoot, requireDirectoryParents);
      await rename(backupPath, targetPath);
    } catch (error) {
      errors.push(`Could not restore ${targetPath}; backup retained at ${backupPath}: ${errorMessage(error)}`);
    }
  } else if (backedUp) {
    errors.push(`Backup retained at ${backupPath} because ${targetPath} could not be safely cleared.`);
  }
  return errors;
}

/**
 * Choose the transaction directory that holds backup and staging trees for a
 * target: the target's own parent for top-level installs, or the install
 * root's `.archive` directory for nested destinations.
 */
export function transactionDirectoryForTarget(targetPath: string, installRoot: string): string {
  return path.dirname(path.relative(installRoot, targetPath)) === "."
    ? path.dirname(targetPath)
    : path.join(installRoot, ".archive");
}

async function ensureTransactionDirectory(
  transactionDirectory: string,
  installRoot: string,
  requireDirectoryParents: boolean
): Promise<void> {
  try {
    const info = await lstat(transactionDirectory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Transaction directory ${transactionDirectory} must be a real directory.`);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    await mkdir(transactionDirectory, { recursive: false });
  }
  await assertTargetParentInsideInstallRoot(
    path.join(transactionDirectory, ".transaction-check"),
    installRoot,
    requireDirectoryParents
  );
}

async function assertTargetParentInsideInstallRoot(
  targetPath: string,
  installRoot: string,
  requireDirectoryParents: boolean
): Promise<void> {
  const lexicalRoot = path.resolve(installRoot);
  const lexicalParent = path.resolve(path.dirname(targetPath));
  if (!isSameOrInsidePath(lexicalParent, lexicalRoot)) {
    throw new Error(`Target parent ${lexicalParent} escapes install root ${lexicalRoot}.`);
  }
  let current = lexicalRoot;
  for (const part of path.relative(lexicalRoot, lexicalParent).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new Error(`Target parent component ${current} is a symlink.`);
    }
    if (requireDirectoryParents && !info.isDirectory()) {
      throw new Error(`Target parent component ${current} is not a directory.`);
    }
  }
  const [resolvedRoot, resolvedParent] = await Promise.all([
    realpath(installRoot),
    realpath(path.dirname(targetPath))
  ]);
  if (!isSameOrInsidePath(resolvedParent, resolvedRoot)) {
    throw new Error(`Target parent ${path.dirname(targetPath)} resolves outside install root ${installRoot}.`);
  }
}

async function copyTree(
  sourcePath: string,
  targetPath: string,
  sourcePolicy?: SourcePolicy | undefined,
  sourceRoot = sourcePath
): Promise<void> {
  if (isSameOrInsidePath(targetPath, sourcePath)) {
    throw new Error(`Refusing to copy ${sourcePath} into nested destination ${targetPath}.`);
  }
  await mkdir(targetPath, { recursive: true });
  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(sourcePath, entry.name);
    const relativePath = path.relative(sourceRoot, from);
    const policyDecision = sourcePolicy === undefined
      ? { action: "include" as const, pattern: null }
      : sourcePolicyDecision(relativePath, sourcePolicy);
    if (policyDecision.action === "deny") {
      throw new Error(`source policy denies path ${relativePath}`);
    }
    if (policyDecision.action === "exclude") {
      continue;
    }
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      continue;
    }
    const to = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      if (sourcePolicy !== undefined && sourcePolicyPrunesDirectory(relativePath, sourcePolicy)) {
        continue;
      }
      await copyTree(from, to, sourcePolicy, sourceRoot);
      continue;
    }
    if (entry.isFile()) {
      await copyFile(from, to);
    }
  }
}

async function treesMatch(left: string, right: string, sourcePolicy?: SourcePolicy | undefined): Promise<boolean> {
  const [leftFiles, rightFiles] = await Promise.all([
    buildFileHashes(left, sourcePolicy),
    buildFileHashes(right)
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

async function assertSourcePolicyAllowsSource(root: string, sourcePolicy?: SourcePolicy | undefined): Promise<void> {
  if (sourcePolicy === undefined) {
    return;
  }
  const deniedPaths = await collectSourcePolicyDeniedPaths(root, sourcePolicy);
  if (deniedPaths.length > 0) {
    throw new Error(`source policy denies paths (${deniedPaths.join(", ")})`);
  }
}

export async function hashDirectory(root: string, sourcePolicy?: SourcePolicy | undefined): Promise<string> {
  await assertSourcePolicyAllowsSource(root, sourcePolicy);
  const files = await listFiles(root, "", sourcePolicy);
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

async function buildFileHashes(root: string, sourcePolicy?: SourcePolicy | undefined): Promise<Array<{ path: string; hash: string }>> {
  const files = await listFiles(root, "", sourcePolicy);
  const records = [];
  for (const relativePath of files) {
    const bytes = await readFile(path.join(root, relativePath));
    records.push({
      path: relativePath,
      hash: createHash("sha256").update(bytes).digest("hex")
    });
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

export async function listFiles(
  root: string,
  prefix = "",
  sourcePolicy?: SourcePolicy | undefined
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = prefix.length > 0 ? path.join(prefix, entry.name) : entry.name;
    const policyDecision = sourcePolicy === undefined
      ? { action: "include" as const, pattern: null }
      : sourcePolicyDecision(relativePath, sourcePolicy);
    if (policyDecision.action === "deny") {
      throw new Error(`source policy denies path ${relativePath}`);
    }
    if (policyDecision.action === "exclude") {
      continue;
    }
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      continue;
    }

    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (sourcePolicy !== undefined && sourcePolicyPrunesDirectory(relativePath, sourcePolicy)) {
        continue;
      }
      files.push(...(await listFiles(entryPath, relativePath, sourcePolicy)));
      continue;
    }
    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

export async function listDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const directories: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      directories.push(entry.name);
      directories.push(...(await listDirectories(entryPath)).map((item) => path.join(entry.name, item)));
    }
  }

  return directories.sort();
}

async function removePath(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
}

function isSameOrInsidePath(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
