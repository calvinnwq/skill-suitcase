import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { loadCatalog, type TargetOverrides } from "../catalog/index.js";
import { diff } from "../diffing/index.js";
import {
  classifySymlinkInstall,
  isPathWithinRoot,
  SYMLINK_MODE
} from "../install-modes.js";
import {
  buildInstallRecord,
  buildInstalledFiles,
  readReceipt,
  upsertAndWriteReceipt,
  type Receipt,
  type ReceiptInstallRecord
} from "../receipts/index.js";
import {
  RECEIPT_ROLLBACK_FAILED,
  receiptRollbackIncompleteMessage,
  type ReceiptTransaction,
  withReceiptTransaction
} from "../receipts/transaction.js";
import { readSkillVersion } from "../skill-metadata.js";
import { checkSelectedSourceHygiene } from "../source-hygiene.js";
import { status } from "../status/index.js";
import {
  collectSourcePolicyExcludedPaths,
  sourcePolicyHasExcludePatterns,
  type SourcePolicy
} from "../source-policy.js";
import {
  type ApplyFinding,
  type ApplyMode,
  type ResolvedApprovalContext,
  isApprovedDirtyBehindUpdate,
  resolveArtifactContext,
  resolveLockContext
} from "./approval-context.js";
import {
  assertSafeMutationParent,
  cleanupApplyBackups,
  executeCopyWriteTransaction,
  rollbackApplyWrites,
  type WriteEntry
} from "./copy-write-transaction.js";
import {
  findReceiptInstallRecord,
  normalizeSymlinkRecordSourcePath,
  normalizeTargetPathForInstallRoot
} from "./receipt-install-records.js";

export type { ApplyMode };

type ApplyInput = {
  source: string;
  target: string;
  lock?: string;
  artifact?: string;
  mode?: string;
  targetOverrides?: TargetOverrides | undefined;
  __test?: {
    failAfterSuccessfulWrites?: number;
    failAfterReceiptWrites?: number;
    beforeWriteForSkill?: (skill: string) => Promise<void> | void;
    afterCopyBackup?: (targetPath: string, backupPath: string) => Promise<void> | void;
    beforeSymlinkFailureCleanup?: () => Promise<void> | void;
    afterSymlinkCleanupClassification?: (targetPath: string) => Promise<void> | void;
    beforeCopyBackupCleanup?: (targetPath: string, backupPath: string) => Promise<void> | void;
  };
};

/**
 * How apply materializes a planned skill in the target root. "copy" writes the
 * source files (the default, unchanged behavior). "symlink" links the agent
 * skill path to the catalog source path (agent skill path -> repo source path),
 * recorded explicitly in the receipt rather than inferred from filesystem shape.
 */
export type ApplyInstallMode = "copy" | typeof SYMLINK_MODE;

type ApplyStatusSummary = {
  total: number;
  blocked: number;
  current: number;
  behind: number;
  missing: number;
  dirty: number;
  unknown: number;
  version: number;
  unchanged: number;
};

type StatusResult = Awaited<ReturnType<typeof status>>;

type StatusItem = StatusResult["statuses"][number];

type DiffForApply = {
  source: string;
  target: string;
  assignment: string | null;
  readOnly?: boolean;
  planned: Array<{ skill: string; sourcePath: string; destination: string; variant?: string }>;
  blocked: Array<{ skill: string; reason?: string }>;
  entries: Array<{
    action: "create" | "update" | "unchanged" | "extra" | "missing" | "blocked";
    skill: string;
    relativePath: string | null;
    sourcePath: string | null;
    targetPath: string | null;
    reason?: string | undefined;
  }>;
  summary: {
    create: number;
    update: number;
    unchanged: number;
    extra: number;
    missing: number;
    blocked: number;
  };
  ok: boolean;
  installRoot: string | null;
  errors: Array<{ code: string; message: string }>;
};

type TargetStatusState = {
  source: string;
  statuses: StatusItem[];
  summary: ApplyStatusSummary;
};

export type ApplyResult = {
  ok: boolean;
  source: string;
  target: string;
  mode: ApplyMode;
  input: string | null;
  assignment: string | null;
  planTarget: string | null;
  installRoot: string | null;
  preApplyStatus: TargetStatusState;
  postApplyStatus: StatusResult | null;
  summary: {
    planned: number;
    blocked: number;
    create: number;
    update: number;
    unchanged: number;
    extra: number;
    missing: number;
  };
  applied: {
    skills: string[];
    files: number;
  };
  errors: ApplyFinding[];
};

const SYMLINK_ROLLBACK_SCHEMA = "calvinnwq.skills.symlink-rollback.v0";

export async function apply({
  source,
  target,
  lock,
  artifact,
  mode,
  targetOverrides,
  __test
}: ApplyInput): Promise<ApplyResult> {
  if (!source) {
    throw new Error("source is required");
  }

  if (!target) {
    throw new Error("target is required");
  }

  const hasLock = hasText(lock);
  const hasArtifact = hasText(artifact);

  if ((hasLock && hasArtifact) || (!hasLock && !hasArtifact)) {
    return failure({
      source,
      target,
      mode: "lock",
      input: null,
      errors: [
        {
          code: hasLock || hasArtifact ? "invalid_apply_input" : "missing_apply_input",
          message: "apply requires exactly one of --lock or --artifact"
        }
      ]
    });
  }

  const installMode = normalizeInstallMode(mode);
  if (installMode === null) {
    return failure({
      source,
      target,
      mode: hasLock ? "lock" : "artifact",
      input: null,
      errors: [
        {
          code: "invalid_apply_mode",
          message: `Unknown apply mode: ${String(mode)}. Use "copy" or "symlink".`
        }
      ]
    });
  }

  const context = hasLock
    ? await resolveLockContext({ lockPath: lock, source, target })
    : await resolveArtifactContext({ artifactPath: artifact!, source, target });

  if (!context.ok) {
    return failure({
      source,
      target,
      mode: context.mode,
      input: context.input,
      errors: context.errors
    });
  }

  const resolutionTarget = context.assignmentPath ?? target;
  const resolvedDiffResult = await diff({ source, target: resolutionTarget, targetOverrides });
  const diffResult = { ...resolvedDiffResult, target } as DiffForApply;
  if (diffResult.readOnly === true) {
    return failure({
      source: diffResult.source,
      target,
      mode: context.mode,
      input: context.input,
      assignment: diffResult.assignment,
      planTarget: diffResult.target,
      installRoot: diffResult.installRoot,
      summary: asSummary(diffResult),
      preApplyStatus: {
        source: diffResult.source,
        statuses: [],
        summary: emptyStatusSummary()
      },
      errors: [{
        code: "read_only_target",
        message: `Target ${target} is modeled read-only and cannot be applied.`
      }]
    });
  }
  if (!diffResult.ok) {
    return failure({
      source: diffResult.source,
      target,
      mode: context.mode,
      input: context.input,
      assignment: diffResult.assignment,
      planTarget: diffResult.target,
      installRoot: diffResult.installRoot,
      summary: asSummary(diffResult),
      preApplyStatus: {
        source: diffResult.source,
        statuses: [],
        summary: emptyStatusSummary()
      },
      errors: diffFailureErrors(diffResult)
    });
  }

  const { manifest } = await loadCatalog(diffResult.source, { targetOverrides });
  const hygiene = checkSelectedSourceHygiene({
    sourceRoot: diffResult.source,
    plannedSkills: diffResult.planned,
    sourcePolicy: manifest.sourcePolicy
  });
  if (!hygiene.ok) {
    return failure({
      source: diffResult.source,
      target,
      mode: context.mode,
      input: context.input,
      assignment: diffResult.assignment,
      planTarget: diffResult.target,
      installRoot: diffResult.installRoot,
      summary: asSummary(diffResult),
      preApplyStatus: {
        source: diffResult.source,
        statuses: [],
        summary: emptyStatusSummary()
      },
      errors: hygiene.errors.map((error) => ({
        code: error.code,
        message: error.message
      }))
    });
  }

  const installRoot = diffResult.installRoot;
  if (!installRoot) {
    return failure({
      source: diffResult.source,
      target,
      mode: context.mode,
      input: context.input,
      assignment: diffResult.assignment,
      planTarget: diffResult.target,
      errors: [{ code: "missing_install_root", message: "could not resolve install root for apply" }]
    });
  }

  try {
    return await withReceiptTransaction({ installRoot }, async (receiptTransaction) => {
    const preStatus = await status({
    source: diffResult.source,
    target: resolutionTarget,
    targetOverrides
  });
  const receipt = await readReceipt({ installRoot }).catch((): Receipt => ({}));
  const targetAssignment = diffResult.assignment ?? target;
  const targetStatuses = preStatus.statuses.filter(
    (entry) => entry.target === installRoot && entry.assignment === targetAssignment
  );
  const preApplySummary = summarizeStatus(targetStatuses);

  const writeEntries = collectApplyEntries(diffResult.entries);
  const skillsWithWrites = new Set(writeEntries.items.map((entry) => entry.skill));
  const diffEntriesBySkill = groupDiffEntriesBySkill(diffResult.entries);
  const approvedSkills = new Set(context.approvedSkills);
  const approvedFileHashes = context.approvedFileHashes;
  const preApplyErrors: ApplyFinding[] = [];

  if (context.approvedDestinations !== undefined) {
    for (const planned of diffResult.planned) {
      const approvedDestination = context.approvedDestinations.get(planned.skill);
      if (approvedDestination !== planned.destination) {
        preApplyErrors.push({
          code: "artifact_destination_mismatch",
          message: `Artifact destination ${approvedDestination ?? "<missing>"} for ${planned.skill} does not match current plan destination ${planned.destination}.`
        });
      }
    }
  }

  if (preStatus.errors.length > 0) {
    preApplyErrors.push(
      ...preStatus.errors.map((entry) => ({
        code: `status_${entry.code}`,
        message: entry.message
      }))
    );
  }

  if (diffResult.planned.length > 0 && targetStatuses.length === 0) {
    preApplyErrors.push({
      code: "unmanaged_target",
      message: "target has no managed status entries"
    });
  }

  if (installMode === "copy") {
    preApplyErrors.push(
      ...(await collectExcludedTargetPolicyFindings({
        plannedSkills: diffResult.planned,
        installRoot,
        sourcePolicy: manifest.sourcePolicy
      }))
    );
  }

  for (const targetStatus of targetStatuses) {
    if (
      targetStatus.status === "dirty"
      && await isApprovedDirtyBehindUpdate({
        statusItem: targetStatus,
        skillsWithWrites,
        diffEntriesBySkill,
        approvedSkills,
        approvedFileHashes,
        receipt,
        installRoot
      })
    ) {
      continue;
    }

    if (targetStatus.status === "dirty" || targetStatus.status === "unknown") {
      preApplyErrors.push({
        code: "unsafe_target_state",
        message: `${targetStatus.skill} is ${targetStatus.status}: ${targetStatus.reason}`
      });
    }
  }

  if (preApplyErrors.length > 0) {
    return failure({
      source: diffResult.source,
      target,
      mode: context.mode,
      input: context.input,
      assignment: diffResult.assignment,
      planTarget: diffResult.target,
      installRoot,
      summary: asSummary(diffResult),
      preApplyStatus: {
        source: preStatus.source,
        statuses: targetStatuses,
        summary: preApplySummary
      },
      errors: preApplyErrors
    });
  }

  if (installMode === SYMLINK_MODE) {
    return applySymlinkInstalls({
      diffResult,
      context,
      installRoot,
      preStatusSource: preStatus.source,
      targetStatuses,
      preApplySummary,
      targetOverrides,
      target,
      statusTarget: resolutionTarget,
      sourcePolicy: manifest.sourcePolicy,
      receiptTransaction,
      __test
    });
  }

  if (writeEntries.errors.length > 0) {
    return failure({
      source: diffResult.source,
      target,
      mode: context.mode,
      input: context.input,
      assignment: diffResult.assignment,
      planTarget: diffResult.target,
      installRoot,
      summary: asSummary(diffResult),
      preApplyStatus: {
        source: preStatus.source,
        statuses: targetStatuses,
        summary: preApplySummary
      },
      errors: writeEntries.errors
    });
  }

  const sourceBySkill = new Map<string, string>();
  const destinationBySkill = new Map<string, string>();
  const variantBySkill = new Map<string, string>();
  for (const planned of diffResult.planned) {
    sourceBySkill.set(planned.skill, planned.sourcePath);
    destinationBySkill.set(planned.skill, planned.destination);
    if (typeof planned.variant === "string" && planned.variant.trim().length > 0) {
      variantBySkill.set(planned.skill, planned.variant);
    }
  }

  const statusBySkill = new Map<string, StatusItem>();
  for (const statusItem of targetStatuses) {
    statusBySkill.set(statusItem.skill, statusItem);
  }

  const failAfterSuccessfulWrites = typeof __test?.failAfterSuccessfulWrites === "number"
    && Number.isFinite(__test.failAfterSuccessfulWrites)
    && __test.failAfterSuccessfulWrites > 0
      ? Math.trunc(__test.failAfterSuccessfulWrites)
      : null;
  const failAfterReceiptWrites = typeof __test?.failAfterReceiptWrites === "number"
    && Number.isFinite(__test.failAfterReceiptWrites)
    && __test.failAfterReceiptWrites > 0
      ? Math.trunc(__test.failAfterReceiptWrites)
      : null;

  const writeOutcome = await executeCopyWriteTransaction({
    writeEntries: writeEntries.items,
    installRoot,
    sourceBySkill,
    destinationBySkill,
    failAfterSuccessfulWrites,
    beforeWriteForSkill: __test?.beforeWriteForSkill,
    afterBackup: __test?.afterCopyBackup
  });

  if (!writeOutcome.ok) {
    return failure({
      source: diffResult.source,
      target,
      mode: context.mode,
      input: context.input,
      assignment: diffResult.assignment,
      planTarget: diffResult.target,
      installRoot,
      summary: asSummary(diffResult),
      preApplyStatus: {
        source: preStatus.source,
        statuses: targetStatuses,
        summary: preApplySummary
      },
      errors: writeOutcome.errors
    });
  }

  const { rollbackBySkill, restorePlan, filesAppliedBySkill } = writeOutcome;

  const sourceCommit = context.sourceCommit;
  const backupPaths = restorePlan
    .map((plannedRestore) => plannedRestore.backupPath)
    .filter((value): value is string => value !== null);
  let receiptWriteCount = 0;
  try {
    for (const [skill, skillSource] of sourceBySkill) {
      const priorState = statusBySkill.get(skill);
      if (!filesAppliedBySkill.has(skill) && priorState?.status === "current") {
        continue;
      }
      if (!skillSource) {
        throw new Error(`No source path for ${skill}`);
      }

      const destination = destinationBySkill.get(skill) ?? skill;
      const targetPath = path.join(installRoot, destination);
      const nextRecord: Record<string, unknown> = {
        skill,
        agent: (diffResult.assignment ?? target),
        mode: "copy",
        source: {
          path: skillSource
        },
        sourcePath: skillSource,
        targetPath,
        destination
      };

      if (sourceCommit.length > 0) {
        nextRecord.sourceCommit = sourceCommit;
      }

      const variant = variantBySkill.get(skill);
      if (variant !== undefined) {
        nextRecord.variant = variant;
      }

      const currentVersion = priorState?.currentVersion;
      if (currentVersion !== null && typeof currentVersion === "string") {
        nextRecord.version = currentVersion;
      }

      const currentHash = priorState?.currentHash;
      if (currentHash !== null && typeof currentHash === "string") {
        nextRecord.sourceHash = currentHash;
      }

      if (priorState !== undefined) {
        nextRecord.priorState = {
          status: priorState.status,
          reason: priorState.reason,
          installedVersion: priorState.installedVersion,
          currentVersion: priorState.currentVersion,
          installedCommit: priorState.installedCommit,
          currentCommit: priorState.currentCommit,
          installedHash: priorState.installedHash,
          currentHash: priorState.currentHash
        };
      }

      nextRecord.installedFiles = await buildInstalledFiles(targetPath, { exclude: backupPaths });
      const rollbackRecord = rollbackBySkill.get(skill);
      if (rollbackRecord !== undefined) {
        nextRecord.rollback = {
          ...rollbackRecord,
          appliedFiles: nextRecord.installedFiles
        };
      }

      receiptWriteCount += 1;
      if (failAfterReceiptWrites !== null && receiptWriteCount === failAfterReceiptWrites) {
        throw new Error(`Injected receipt write failure after ${receiptWriteCount} successful writes`);
      }

      await upsertAndWriteReceipt({
        installRoot,
        skillName: skill,
        installRecord: buildInstallRecord(nextRecord),
        onWritten: receiptTransaction.recordMutation,
        receiptLock: receiptTransaction.receiptLock
      });
    }
  } catch (error) {
    const recoveryErrors = await rollbackApplyWrites({
      restorePlan,
      installRoot
    });
    const receiptRollbackComplete = await receiptTransaction.rollbackRecordedMutations();
    return failure({
      source: diffResult.source,
      target,
      mode: context.mode,
      input: context.input,
      assignment: diffResult.assignment,
      planTarget: diffResult.target,
      installRoot,
      summary: asSummary(diffResult),
      preApplyStatus: {
        source: preStatus.source,
        statuses: targetStatuses,
        summary: preApplySummary
      },
      errors: [{
        code: "write_error",
        message: error instanceof Error ? error.message : "Unknown write error"
      }, ...recoveryErrors.map((message) => ({
        code: "apply_recovery_failed",
        message
      })), ...receiptRollbackComplete ? [] : [{
        code: RECEIPT_ROLLBACK_FAILED,
        message: receiptRollbackIncompleteMessage("apply failed")
      }]]
    });
  }

  const backupCleanupErrors = await cleanupApplyBackups({
    restorePlan,
    installRoot,
    beforeCleanup: __test?.beforeCopyBackupCleanup
  });

  let postApplyStatus: StatusResult | null = null;
  try {
    postApplyStatus = await status({
      source: diffResult.source,
      target: resolutionTarget,
      targetOverrides
    });
  } catch {
    postApplyStatus = null;
  }

    return {
      ok: backupCleanupErrors.length === 0,
      source: diffResult.source,
      target,
      mode: context.mode,
      input: context.input,
      assignment: diffResult.assignment,
      planTarget: diffResult.target,
      installRoot,
      preApplyStatus: {
        source: preStatus.source,
        statuses: targetStatuses,
        summary: preApplySummary
      },
      postApplyStatus,
      summary: asSummary(diffResult),
      applied: {
        skills: [...filesAppliedBySkill.keys()],
        files: writeEntries.items.length
      },
      errors: backupCleanupErrors.map((message) => ({
        code: "apply_backup_cleanup_failed",
        message
      }))
    };
    });
  } catch (error) {
    return failure({
      source: diffResult.source,
      target,
      mode: context.mode,
      input: context.input,
      assignment: diffResult.assignment,
      planTarget: diffResult.target,
      installRoot,
      errors: [{ code: "receipt_lock_failed", message: error instanceof Error ? error.message : "Receipt lock failed" }]
    });
  }
}

function normalizeInstallMode(mode: string | undefined): ApplyInstallMode | null {
  if (mode === undefined) {
    return "copy";
  }
  if (mode === "copy" || mode === SYMLINK_MODE) {
    return mode;
  }
  return null;
}

async function collectExcludedTargetPolicyFindings({
  plannedSkills,
  installRoot,
  sourcePolicy
}: {
  plannedSkills: DiffForApply["planned"];
  installRoot: string;
  sourcePolicy: SourcePolicy | undefined;
}): Promise<ApplyFinding[]> {
  if (!sourcePolicyHasExcludePatterns(sourcePolicy)) {
    return [];
  }

  const errors: ApplyFinding[] = [];
  for (const planned of plannedSkills) {
    const targetPath = path.join(installRoot, planned.destination);
    let info;
    try {
      info = await lstat(targetPath);
    } catch {
      continue;
    }
    if (!info.isDirectory()) {
      continue;
    }

    const excludedPaths = await collectSourcePolicyExcludedPaths(targetPath, sourcePolicy);
    if (excludedPaths.length === 0) {
      continue;
    }

    errors.push({
      code: "source_policy_excluded_target",
      message: `Refusing to apply ${planned.skill}: target contains source policy excluded paths (${excludedPaths.join(", ")}).`
    });
  }

  return errors;
}

type SymlinkApplyPlanItem = {
  skill: string;
  sourcePath: string;
  targetPath: string;
  destination: string;
  variant: string | undefined;
  action: "create" | "noop";
};

/**
 * Install planned skills as symlinks (agent skill path -> catalog source path).
 *
 * This is reached only after the same approval (lock/artifact) and pre-apply
 * safety checks the copy path runs, so the plan is approved and the target is in
 * a safe state. It never enters the per-file copy/write path: each skill becomes
 * a single managed symlink and a receipt with mode "symlink". The link target is
 * guarded to stay inside the approved source root, and an existing real
 * directory / wrong link is refused rather than clobbered (converting those
 * requires explicit approval, per the mutation boundaries in ARCHITECTURE.md).
 */
async function applySymlinkInstalls({
  diffResult,
  context,
  installRoot,
  preStatusSource,
  targetStatuses,
  preApplySummary,
  targetOverrides,
  target,
  statusTarget,
  sourcePolicy,
  receiptTransaction,
  __test
}: {
  diffResult: DiffForApply;
  context: ResolvedApprovalContext;
  installRoot: string;
  preStatusSource: string;
  targetStatuses: StatusItem[];
  preApplySummary: ApplyStatusSummary;
  targetOverrides: TargetOverrides | undefined;
  target: string;
  statusTarget: string;
  sourcePolicy: SourcePolicy | undefined;
  receiptTransaction: ReceiptTransaction;
  __test: ApplyInput["__test"];
}): Promise<ApplyResult> {
  const sourceRoot = diffResult.source;
  const assignment = diffResult.assignment ?? target;
  const statusBySkill = new Map<string, StatusItem>();
  for (const item of targetStatuses) {
    statusBySkill.set(item.skill, item);
  }

  const preApplyStatus: TargetStatusState = {
    source: preStatusSource,
    statuses: targetStatuses,
    summary: preApplySummary
  };

  const failSymlink = (errors: ApplyFinding[]): ApplyResult =>
    failure({
      source: sourceRoot,
      target,
      mode: context.mode,
      input: context.input,
      assignment: diffResult.assignment,
      planTarget: diffResult.target,
      installRoot,
      summary: asSummary(diffResult),
      preApplyStatus,
      errors
    });

  // Phase 1: validate every planned skill before mutating anything, so a refusal
  // never leaves a half-applied target root.
  const errors: ApplyFinding[] = [];
  const plannedItems: SymlinkApplyPlanItem[] = [];
  for (const planned of diffResult.planned) {
    const sourcePath = planned.sourcePath;
    const targetPath = path.join(installRoot, planned.destination);

    if (!(await isPathWithinRoot({ candidatePath: sourcePath, rootPath: sourceRoot }))) {
      errors.push({
        code: "symlink_source_escape",
        message: `Refusing to symlink ${planned.skill}: source ${sourcePath} escapes the approved source root ${sourceRoot}.`
      });
      continue;
    }

    if (sourcePolicyHasExcludePatterns(sourcePolicy)) {
      const excludedPaths = await collectSourcePolicyExcludedPaths(sourcePath, sourcePolicy);
      const detail = excludedPaths.length > 0
        ? `excludes paths (${excludedPaths.join(", ")})`
        : "defines exclude patterns";
      errors.push({
        code: "symlink_source_policy_exclude",
        message: `Refusing to symlink ${planned.skill}: source policy ${detail}, which symlink mode would expose.`
      });
      continue;
    }

    const classification = await classifySymlinkInstall({ targetPath, expectedSourcePath: sourcePath });
    if (classification.state === "missing") {
      plannedItems.push({ skill: planned.skill, sourcePath, targetPath, destination: planned.destination, variant: symlinkVariant(planned), action: "create" });
      continue;
    }
    if (classification.state === "correct") {
      // Already linked at the selected source: idempotent re-apply, refresh the
      // receipt only.
      plannedItems.push({ skill: planned.skill, sourcePath, targetPath, destination: planned.destination, variant: symlinkVariant(planned), action: "noop" });
      continue;
    }
    errors.push({
      code: "symlink_target_conflict",
      message: `Refusing to symlink ${planned.skill}: target ${targetPath} is a ${classification.state} and would require explicit approval to replace.`
    });
  }

  if (errors.length > 0) {
    return failSymlink(errors);
  }

  // Phase 2: create links (only for missing targets) and write symlink receipts.
  const previousReceipt = await readReceipt({ installRoot }).catch((): Receipt => ({}));
  const linkedSkills: string[] = [];
  const createdLinks: Array<{ targetPath: string; sourcePath: string }> = [];
  try {
    for (const item of plannedItems) {
      if (item.action === "create") {
        await assertSafeMutationParent(item.targetPath, installRoot, true);
        await mkdir(path.dirname(item.targetPath), { recursive: true });
        await assertSafeMutationParent(item.targetPath, installRoot, false);
        await symlink(item.sourcePath, item.targetPath, "dir");
        createdLinks.push({ targetPath: item.targetPath, sourcePath: item.sourcePath });
        if (__test?.failAfterSuccessfulWrites === createdLinks.length) {
          throw new Error(`Injected symlink write failure after ${createdLinks.length} successful writes`);
        }
      }

      const priorState = statusBySkill.get(item.skill);
      const installedFiles = await buildInstalledFiles(item.sourcePath);
      const version = await readSkillVersion(item.sourcePath).catch(() => null);
      const previousRecord = findReceiptInstallRecord({
        receipt: previousReceipt,
        skillName: item.skill,
        targetPath: item.targetPath,
        installRoot
      });
      const preserveApplyCreatedRollback = item.action === "noop" && previousRecord !== null && hasAvailableApplyCreatedSymlinkRollback({
        record: previousRecord,
        targetPath: item.targetPath,
        sourcePath: item.sourcePath,
        installRoot
      });
      const createdByApply = item.action === "create" || preserveApplyCreatedRollback;

      const nextRecord: Record<string, unknown> = {
        skill: item.skill,
        agent: assignment,
        target: assignment,
        mode: SYMLINK_MODE,
        source: { path: item.sourcePath },
        sourcePath: item.sourcePath,
        targetPath: item.targetPath,
        destination: item.destination,
        sourceHash: await hashDirectory(item.sourcePath),
        installedFiles
      };
      if (version !== null) {
        nextRecord.version = version;
      }
      if (context.sourceCommit.length > 0) {
        nextRecord.sourceCommit = context.sourceCommit;
      }
      if (item.variant !== undefined) {
        nextRecord.variant = item.variant;
      }
      nextRecord.priorState = {
        status: priorState?.status ?? "missing",
        reason: item.action === "create"
          ? "symlink created by Suitcase apply --mode symlink"
          : "existing correct symlink refreshed by Suitcase apply --mode symlink"
      };
      nextRecord.rollback = {
        schema: SYMLINK_ROLLBACK_SCHEMA,
        status: "available",
        mode: SYMLINK_MODE,
        targetPath: item.targetPath,
        created: createdByApply,
        previous: { kind: createdByApply ? "missing" : "symlink" }
      };

      await upsertAndWriteReceipt({
        installRoot,
        skillName: item.skill,
        installRecord: buildInstallRecord(nextRecord),
        onWritten: receiptTransaction.recordMutation,
        receiptLock: receiptTransaction.receiptLock
      });
      linkedSkills.push(item.skill);
    }
  } catch (error) {
    await __test?.beforeSymlinkFailureCleanup?.();
    const cleanupErrors: ApplyFinding[] = [];
    for (const createdLink of [...createdLinks].reverse()) {
      try {
        await assertSafeMutationParent(createdLink.targetPath, installRoot, false);
        const classification = await classifySymlinkInstall({
          targetPath: createdLink.targetPath,
          expectedSourcePath: createdLink.sourcePath
        });
        if (classification.state !== "correct") {
          throw new Error(`created link is now ${classification.state}`);
        }
        await __test?.afterSymlinkCleanupClassification?.(createdLink.targetPath);
        await assertSafeMutationParent(createdLink.targetPath, installRoot, false);
        const finalClassification = await classifySymlinkInstall({
          targetPath: createdLink.targetPath,
          expectedSourcePath: createdLink.sourcePath
        });
        if (finalClassification.state !== "correct") {
          throw new Error(`created link is now ${finalClassification.state}`);
        }
        await unlink(createdLink.targetPath);
      } catch (cleanupError) {
        cleanupErrors.push({
          code: "symlink_cleanup_failed",
          message: `Could not safely remove created symlink ${createdLink.targetPath}: ${errorMessage(cleanupError)}`
        });
      }
    }
    const receiptRollbackComplete = await receiptTransaction.rollbackRecordedMutations();
    return failSymlink([{
      code: "symlink_write_error",
      message: error instanceof Error ? error.message : "Unknown symlink write error"
    }, ...cleanupErrors, ...receiptRollbackComplete ? [] : [{
      code: RECEIPT_ROLLBACK_FAILED,
      message: receiptRollbackIncompleteMessage("symlink apply failed")
    }]]);
  }

  let postApplyStatus: StatusResult | null = null;
  try {
    postApplyStatus = await status({ source: sourceRoot, target: statusTarget, targetOverrides });
  } catch {
    postApplyStatus = null;
  }

  return {
    ok: true,
    source: sourceRoot,
    target,
    mode: context.mode,
    input: context.input,
    assignment: diffResult.assignment,
    planTarget: diffResult.target,
    installRoot,
    preApplyStatus,
    postApplyStatus,
    summary: asSummary(diffResult),
    applied: {
      skills: linkedSkills.sort(),
      files: 0
    },
    errors: []
  };
}

function symlinkVariant(planned: DiffForApply["planned"][number]): string | undefined {
  if (typeof planned.variant === "string" && planned.variant.trim().length > 0) {
    return planned.variant;
  }
  return undefined;
}

function hasAvailableApplyCreatedSymlinkRollback({
  record,
  targetPath,
  sourcePath,
  installRoot
}: {
  record: ReceiptInstallRecord;
  targetPath: string;
  sourcePath: string;
  installRoot: string;
}): boolean {
  if (record.mode !== SYMLINK_MODE) {
    return false;
  }
  const rollback = record.rollback;
  if (!isRecord(rollback) || rollback.schema !== SYMLINK_ROLLBACK_SCHEMA || rollback.status !== "available" || rollback.created !== true) {
    return false;
  }
  const rollbackTargetPath = normalizeTargetPathForInstallRoot(rollback.targetPath, installRoot)
    ?? normalizeTargetPathForInstallRoot(record.targetPath, installRoot);
  if (rollbackTargetPath !== path.resolve(targetPath)) {
    return false;
  }
  const recordSourcePath = normalizeSymlinkRecordSourcePath(record);
  return recordSourcePath !== null && path.resolve(recordSourcePath) === path.resolve(sourcePath);
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

type WriteEntries = {
  items: WriteEntry[];
  errors: ApplyFinding[];
};

function collectApplyEntries(entries: DiffForApply["entries"]): WriteEntries {
  const items: WriteEntry[] = [];
  const errors: ApplyFinding[] = [];

  for (const entry of entries) {
    if (entry.action === "create" || entry.action === "update") {
      if (!entry.sourcePath || !entry.targetPath) {
        errors.push({
          code: "invalid_diff_entry",
          message: `Missing source/target path for ${entry.skill}`
        });
        continue;
      }
      items.push({
        skill: entry.skill,
        relativePath: entry.relativePath ?? path.basename(entry.targetPath),
        sourcePath: entry.sourcePath,
        targetPath: entry.targetPath
      });
      continue;
    }

    if (entry.action === "missing") {
      errors.push({
        code: "source_file_missing",
        message: `Cannot apply missing source file for ${entry.skill}`
      });
    }
  }

  return { items, errors };
}

function groupDiffEntriesBySkill(entries: DiffForApply["entries"]): Map<string, DiffForApply["entries"]> {
  const entriesBySkill = new Map<string, DiffForApply["entries"]>();
  for (const entry of entries) {
    const bucket = entriesBySkill.get(entry.skill);
    if (bucket === undefined) {
      entriesBySkill.set(entry.skill, [entry]);
      continue;
    }
    bucket.push(entry);
  }
  return entriesBySkill;
}

function diffFailureErrors(diffResult: DiffForApply): ApplyFinding[] {
  const errors = diffResult.errors.map((error) => ({
    code: `diff_${error.code}`,
    message: error.message
  }));

  for (const blocked of diffResult.blocked) {
    errors.push({
      code: "diff_blocked_skill",
      message: `Skill ${blocked.skill} is blocked for apply: ${blocked.reason ?? "blocked"}`
    });
  }

  return errors;
}

async function readFileSafeText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

function summarizeStatus(statuses: StatusItem[]): ApplyStatusSummary {
  const summary: ApplyStatusSummary = {
    total: 0,
    blocked: 0,
    current: 0,
    behind: 0,
    missing: 0,
    dirty: 0,
    unknown: 0,
    version: 0,
    unchanged: 0
  };

  for (const item of statuses) {
    summary.total += 1;
    if (item.status === "blocked") summary.blocked += 1;
    if (item.status === "current") summary.current += 1;
    if (item.status === "behind") summary.behind += 1;
    if (item.status === "missing") summary.missing += 1;
    if (item.status === "dirty") summary.dirty += 1;
    if (item.status === "unknown") summary.unknown += 1;
    if (item.status === "version") summary.version += 1;
  }

  return summary;
}

function asSummary(diffResult: DiffForApply): ApplyResult["summary"] {
  return {
    planned: diffResult.planned.length,
    blocked: diffResult.blocked.length,
    create: diffResult.summary.create,
    update: diffResult.summary.update,
    unchanged: diffResult.summary.unchanged,
    extra: diffResult.summary.extra,
    missing: diffResult.summary.missing
  };
}

function emptyStatusSummary(): ApplyStatusSummary {
  return {
    total: 0,
    blocked: 0,
    current: 0,
    behind: 0,
    missing: 0,
    dirty: 0,
    unknown: 0,
    version: 0,
    unchanged: 0
  };
}

function failure({
  source,
  target,
  mode,
  input,
  assignment = null,
  planTarget,
  installRoot = null,
  summary,
  preApplyStatus = {
    source,
    statuses: [],
    summary: emptyStatusSummary()
  },
  postApplyStatus = null,
  errors
}: {
  source: string;
  target: string;
  mode: ApplyMode;
  input: string | null;
  assignment?: string | null;
  planTarget?: string | null;
  installRoot?: string | null;
  summary?: ApplyResult["summary"];
  preApplyStatus?: TargetStatusState;
  postApplyStatus?: StatusResult | null;
  errors: ApplyFinding[];
}): ApplyResult {
  return {
    ok: false,
    source,
    target,
    mode,
    input,
    assignment,
    planTarget: planTarget ?? target,
    installRoot,
    preApplyStatus,
    postApplyStatus,
    summary: summary ?? {
      planned: 0,
      blocked: 0,
      create: 0,
      update: 0,
      unchanged: 0,
      extra: 0,
      missing: 0
    },
    applied: { skills: [], files: 0 },
    errors
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: string | null | undefined): value is string {
  return isNonEmptyString(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
