import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SKILLS_DIRECTORY } from "../../config/defaults.js";
import { isPathWithinRoot, SYMLINK_MODE } from "../install-modes.js";
import {
  buildInstallRecord,
  buildInstalledFiles,
  upsertAndWriteReceipt
} from "../receipts/index.js";
import { readSkillVersion } from "../skill-metadata.js";

/**
 * Machine-readable conflict categories a read-only promote plan can surface
 * before any mutation. These mirror the promote/import-target conflict list in
 * ARCHITECTURE.md and the NGX-457 acceptance criteria.
 */
export type PromoteConflictCode =
  | "existing_repo_skill"
  | "unsafe_path"
  | "dirty_target"
  | "unsupported_layout";

export type PromoteConflict = {
  code: PromoteConflictCode;
  message: string;
  path: string | null;
};

/**
 * One declarative step in the promote workflow. The dry-run plan describes the
 * intended copy -> verify -> symlink -> receipt sequence without performing it.
 */
export type PromotePlanStep = {
  action: "copy" | "verify" | "symlink" | "receipt";
  description: string;
  from?: string;
  to?: string;
};

export type PromotePlanResult = {
  ok: boolean;
  dryRun: boolean;
  readOnly: boolean;
  source: string;
  targetSkill: string;
  skillName: string | null;
  repoSkillPath: string | null;
  plan: PromotePlanStep[];
  conflicts: PromoteConflict[];
  summary: {
    conflicts: number;
    steps: number;
  };
};

type PlanPromoteInput = {
  source: string;
  targetSkill: string;
};

/**
 * One forward step the live promote completed, mirroring the dry-run plan
 * actions. Only completed steps are recorded; failures are reported in `errors`.
 */
export type PromoteExecuteStep = {
  action: PromotePlanStep["action"];
  from?: string;
  to?: string;
};

export type PromoteExecuteError = {
  code: string;
  message: string;
};

export type PromoteExecuteResult = {
  ok: boolean;
  dryRun: false;
  source: string;
  targetSkill: string;
  skillName: string | null;
  repoSkillPath: string | null;
  steps: PromoteExecuteStep[];
  conflicts: PromoteConflict[];
  receiptPath: string | null;
  backupPath: string | null;
  errors: PromoteExecuteError[];
};

type ExecutePromoteInput = {
  source: string;
  targetSkill: string;
  __test?: {
    failBeforeSwap?: boolean;
    failAfterBackup?: boolean;
  };
};

const SKILL_FILE = "SKILL.md";

/**
 * Schema marker the live promote writes into a receipt's `rollback` field. It is
 * deliberately distinct from the apply symlink-rollback schema: a promote
 * replaced a real target directory with a symlink and preserved the original at
 * `backupPath`, so reversing it means restoring that backup, not just removing a
 * link. The existing `rollback` command therefore treats promote receipts as a
 * safe no-op rather than removing the link and leaving nothing behind.
 */
const PROMOTE_ROLLBACK_SCHEMA = "calvinnwq.skills.promote-rollback.v0";

/**
 * Produce a read-only promote/import-target plan for a target-created skill.
 *
 * This never mutates anything: it stats and reads the target skill directory and
 * the catalog source path, then reports the intended workflow plus every
 * machine-readable conflict (existing repo skill, unsafe path, dirty target,
 * unsupported layout). Live copy/verify/symlink/receipt mutation is a separate,
 * approval-gated workflow.
 */
export async function planPromote({ source, targetSkill }: PlanPromoteInput): Promise<PromotePlanResult> {
  if (!source) {
    throw new Error("source is required");
  }
  if (!targetSkill) {
    throw new Error("targetSkill is required");
  }

  const sourceRoot = path.resolve(source);
  const targetSkillPath = path.resolve(targetSkill);
  const skillName = path.basename(targetSkillPath);
  const repoSkillsRoot = path.join(sourceRoot, DEFAULT_SKILLS_DIRECTORY);
  const repoSkillPath = path.join(repoSkillsRoot, skillName);

  const conflicts: PromoteConflict[] = [];
  const nameIsPlain = isPlainPathSegment(skillName);

  if (!nameIsPlain) {
    conflicts.push({
      code: "unsafe_path",
      message: `Target skill name ${skillName} is not a plain directory name and cannot be promoted into ${DEFAULT_SKILLS_DIRECTORY}/.`,
      path: targetSkillPath
    });
  } else {
    const relativeToSkillsRoot = path.relative(repoSkillsRoot, repoSkillPath);
    if (relativeToSkillsRoot === "" || relativeToSkillsRoot.startsWith("..") || path.isAbsolute(relativeToSkillsRoot)) {
      conflicts.push({
        code: "unsafe_path",
        message: `Promoted path ${repoSkillPath} would escape the catalog skills directory ${repoSkillsRoot}.`,
        path: repoSkillPath
      });
    }
  }

  if (await isPathWithinRoot({ candidatePath: targetSkillPath, rootPath: sourceRoot })) {
    conflicts.push({
      code: "unsafe_path",
      message: `Target skill ${targetSkillPath} already lives inside the source repo ${sourceRoot}; it is not a target-created skill.`,
      path: targetSkillPath
    });
  }

  const targetInfo = await lstatSafe(targetSkillPath);
  if (targetInfo === null) {
    conflicts.push({
      code: "unsupported_layout",
      message: `Target skill directory ${targetSkillPath} does not exist.`,
      path: targetSkillPath
    });
  } else if (targetInfo.isSymbolicLink()) {
    conflicts.push({
      code: "dirty_target",
      message: `Target skill ${targetSkillPath} is a symlink, not a real target-created directory.`,
      path: targetSkillPath
    });
  } else if (!targetInfo.isDirectory()) {
    conflicts.push({
      code: "unsupported_layout",
      message: `Target skill ${targetSkillPath} is not a directory.`,
      path: targetSkillPath
    });
  } else {
    const skillFile = path.join(targetSkillPath, SKILL_FILE);
    if (!(await isFile(skillFile))) {
      conflicts.push({
        code: "unsupported_layout",
        message: `Target skill ${targetSkillPath} is missing ${SKILL_FILE}.`,
        path: skillFile
      });
    }
    const nestedSymlink = await findNestedSymlink(targetSkillPath);
    if (nestedSymlink !== null) {
      conflicts.push({
        code: "dirty_target",
        message: `Target skill tree contains a symlink at ${nestedSymlink} and cannot be hash-verified safely.`,
        path: nestedSymlink
      });
    }
  }

  if (await pathExists(repoSkillPath)) {
    conflicts.push({
      code: "existing_repo_skill",
      message: `Catalog already contains a skill at ${repoSkillPath}; promotion needs a conflict decision.`,
      path: repoSkillPath
    });
  }

  const plan: PromotePlanStep[] = [
    {
      action: "copy",
      description: "Copy the target skill contents into the catalog source path.",
      from: targetSkillPath,
      to: repoSkillPath
    },
    {
      action: "verify",
      description: "Hash-verify the copied catalog source against the original target contents before swapping.",
      from: targetSkillPath,
      to: repoSkillPath
    },
    {
      action: "symlink",
      description: "Replace the target directory with a symlink back to the catalog source after verification.",
      from: targetSkillPath,
      to: repoSkillPath
    },
    {
      action: "receipt",
      description: "Write receipt metadata linking the target to the promoted catalog source.",
      to: repoSkillPath
    }
  ];

  return {
    ok: conflicts.length === 0,
    dryRun: true,
    readOnly: true,
    source: sourceRoot,
    targetSkill: targetSkillPath,
    skillName: nameIsPlain ? skillName : null,
    repoSkillPath: nameIsPlain ? repoSkillPath : null,
    plan,
    conflicts,
    summary: {
      conflicts: conflicts.length,
      steps: plan.length
    }
  };
}

/**
 * Live promote/import-target: turn a target-created skill into a repo-owned
 * catalog skill. This is the approval-gated mutation that follows the read-only
 * {@link planPromote}.
 *
 * The flow follows ARCHITECTURE.md exactly: copy the target tree into the
 * catalog source path, hash-verify the copy against the original target, then —
 * only after verification — preserve the original (move it aside, never delete
 * before verify) and replace it with a symlink back to the catalog source, and
 * finally write a receipt recording source provenance, the symlink mode, and
 * rollback state (including the preserved backup path).
 *
 * It is transactional: any failure rolls back to leave the original target as
 * the untouched real directory it started as, with no catalog copy, symlink, or
 * receipt left behind. Conflicts reported by {@link planPromote} abort before any
 * mutation.
 */
export async function executePromote({ source, targetSkill, __test }: ExecutePromoteInput): Promise<PromoteExecuteResult> {
  if (!source) {
    throw new Error("source is required");
  }
  if (!targetSkill) {
    throw new Error("targetSkill is required");
  }

  const plan = await planPromote({ source, targetSkill });
  const steps: PromoteExecuteStep[] = [];
  const result: PromoteExecuteResult = {
    ok: false,
    dryRun: false,
    source: plan.source,
    targetSkill: plan.targetSkill,
    skillName: plan.skillName,
    repoSkillPath: plan.repoSkillPath,
    steps,
    conflicts: plan.conflicts,
    receiptPath: null,
    backupPath: null,
    errors: []
  };

  if (plan.conflicts.length > 0 || plan.repoSkillPath === null || plan.skillName === null) {
    result.errors.push({
      code: "promote_conflicts",
      message: `Refusing to promote ${plan.targetSkill}: ${plan.conflicts.length} conflict(s) must be resolved before live promotion.`
    });
    return result;
  }

  const repoSkillPath = plan.repoSkillPath;
  const targetSkillPath = plan.targetSkill;
  const skillName = plan.skillName;
  const installRoot = path.dirname(targetSkillPath);

  // Defense-in-depth re-check: the plan found the catalog path clear, but never
  // copy onto (and then delete) a directory we did not create.
  if (await pathExists(repoSkillPath)) {
    result.conflicts = [
      ...plan.conflicts,
      {
        code: "existing_repo_skill",
        message: `Catalog already contains a skill at ${repoSkillPath}; promotion needs a conflict decision.`,
        path: repoSkillPath
      }
    ];
    result.errors.push({
      code: "existing_repo_skill",
      message: `Catalog already contains a skill at ${repoSkillPath}; refusing to overwrite it.`
    });
    return result;
  }

  // Phase 1: copy the target tree into the catalog source path.
  try {
    await copyTree(targetSkillPath, repoSkillPath);
  } catch (error) {
    await removeTree(repoSkillPath);
    result.errors.push({ code: "promote_copy_failed", message: describeError(error) });
    return result;
  }
  steps.push({ action: "copy", from: targetSkillPath, to: repoSkillPath });

  // Phase 2: hash-verify the catalog copy against the original target content.
  let verified: boolean;
  try {
    verified = await treesMatch(targetSkillPath, repoSkillPath);
  } catch (error) {
    await removeTree(repoSkillPath);
    result.errors.push({ code: "promote_verify_failed", message: describeError(error) });
    return result;
  }
  if (!verified) {
    await removeTree(repoSkillPath);
    result.errors.push({
      code: "promote_verify_mismatch",
      message: `Catalog copy ${repoSkillPath} does not match the original target ${targetSkillPath}.`
    });
    return result;
  }
  steps.push({ action: "verify", from: targetSkillPath, to: repoSkillPath });

  if (__test?.failBeforeSwap === true) {
    await removeTree(repoSkillPath);
    result.errors.push({ code: "promote_test_failure", message: "Injected failure before swap." });
    return result;
  }

  // Phase 3: preserve the original (move aside, never delete before verify), then
  // replace it with a symlink back to the verified catalog source.
  const backupPath = path.join(installRoot, `.${skillName}.suitcase-pre-promote-${uniqueSuffix()}`);
  let backedUp = false;
  let linked = false;
  try {
    await rename(targetSkillPath, backupPath);
    backedUp = true;
    if (__test?.failAfterBackup === true) {
      throw new Error("Injected failure after backup.");
    }
    await symlink(repoSkillPath, targetSkillPath, "dir");
    linked = true;
  } catch (error) {
    if (linked) {
      await removeLink(targetSkillPath);
    }
    if (backedUp) {
      await restorePath(backupPath, targetSkillPath);
    }
    await removeTree(repoSkillPath);
    result.errors.push({ code: "promote_swap_failed", message: describeError(error) });
    return result;
  }
  steps.push({ action: "symlink", from: targetSkillPath, to: repoSkillPath });
  result.backupPath = backupPath;

  // Phase 4: write a receipt linking the target to the promoted catalog source.
  try {
    const installRecord = buildInstallRecord({
      skill: skillName,
      agent: installRoot,
      target: installRoot,
      mode: SYMLINK_MODE,
      source: { path: repoSkillPath },
      sourcePath: repoSkillPath,
      targetPath: targetSkillPath,
      sourceHash: await hashDirectory(repoSkillPath),
      installedFiles: await buildInstalledFiles(repoSkillPath),
      ...(await optionalVersion(repoSkillPath)),
      priorState: {
        status: "real-directory",
        reason: "promoted target-created skill into the catalog"
      },
      rollback: {
        schema: PROMOTE_ROLLBACK_SCHEMA,
        status: "available",
        mode: SYMLINK_MODE,
        targetPath: targetSkillPath,
        repoSkillPath,
        backupPath,
        created: true
      }
    });
    result.receiptPath = await upsertAndWriteReceipt({
      installRoot,
      skillName,
      installRecord
    });
  } catch (error) {
    // The swap succeeded but the receipt did not: undo the swap and remove the
    // catalog copy so the operation is all-or-nothing.
    await removeLink(targetSkillPath);
    await restorePath(backupPath, targetSkillPath);
    await removeTree(repoSkillPath);
    result.backupPath = null;
    result.errors.push({ code: "promote_receipt_failed", message: describeError(error) });
    return result;
  }
  steps.push({ action: "receipt", to: result.receiptPath });

  result.ok = true;
  return result;
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      continue;
    }
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to);
      continue;
    }
    if (entry.isFile()) {
      await copyFile(from, to);
    }
    // Symlinks are excluded by planPromote's dirty_target conflict, so any other
    // entry kind is skipped rather than copied.
  }
}

/**
 * True when both trees have byte-identical content, compared by the sorted
 * per-file sha256 list that {@link buildInstalledFiles} produces.
 */
async function treesMatch(left: string, right: string): Promise<boolean> {
  const [leftFiles, rightFiles] = await Promise.all([
    buildInstalledFiles(left),
    buildInstalledFiles(right)
  ]);
  if (leftFiles.length !== rightFiles.length) {
    return false;
  }
  for (let index = 0; index < leftFiles.length; index += 1) {
    const a = leftFiles[index];
    const b = rightFiles[index];
    if (a === undefined || b === undefined || a.path !== b.path || a.hash !== b.hash) {
      return false;
    }
  }
  return true;
}

async function hashDirectory(root: string): Promise<string> {
  const files = await buildInstalledFiles(root);
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(file.hash);
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function optionalVersion(root: string): Promise<{ version?: string }> {
  const version = await readSkillVersion(root).catch(() => null);
  return version === null ? {} : { version };
}

async function removeTree(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    // best effort cleanup only
  }
}

async function removeLink(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch {
    // best effort cleanup only
  }
}

async function restorePath(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    // best effort restore only
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function findNestedSymlink(root: string): Promise<string | null> {
  const entries = await readDirSafe(root);

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const nested = await findNestedSymlink(entryPath);
      if (nested !== null) {
        return nested;
      }
    }
  }

  return null;
}

async function readDirSafe(root: string): Promise<Dirent[]> {
  try {
    return await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function lstatSafe(targetPath: string): Promise<Stats | null> {
  try {
    return await lstat(targetPath);
  } catch {
    return null;
  }
}

async function isFile(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isPlainPathSegment(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 &&
    trimmed === value &&
    trimmed !== "." &&
    trimmed !== ".." &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    !path.isAbsolute(trimmed);
}
