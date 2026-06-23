import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessPlanLock, type PlanLock, PLAN_LOCK_SCHEMA } from "../planning/plan-lock.js";
import type { TargetOverrides } from "../catalog/index.js";
import { diff } from "../diffing/index.js";
import {
  classifySymlinkInstall,
  isPathWithinRoot,
  SYMLINK_MODE
} from "../install-modes.js";
import {
  RECEIPT_FILE,
  buildInstallRecord,
  buildInstalledFiles,
  readReceipt,
  upsertAndWriteReceipt,
  type Receipt,
  type ReceiptInstalledFile,
  type ReceiptInstallRecord
} from "../receipts/index.js";
import { readSkillVersion } from "../skill-metadata.js";
import { checkSelectedSourceHygiene } from "../source-hygiene.js";
import { status } from "../status/index.js";

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
  };
};

/**
 * How apply materializes a planned skill in the target root. "copy" writes the
 * source files (the default, unchanged behavior). "symlink" links the agent
 * skill path to the catalog source path (agent skill path -> repo source path),
 * recorded explicitly in the receipt rather than inferred from filesystem shape.
 */
export type ApplyInstallMode = "copy" | typeof SYMLINK_MODE;

type ApplyFinding = {
  code: string;
  message: string;
};

export type ApplyMode = "lock" | "artifact";

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

type PlanLockManifest = PlanLock & {
  planId?: string;
};

type ArtifactManifest = {
  schema: string;
  source: {
    repo: string;
    ref?: string | null;
    commit?: string | null;
  };
  target: string;
  planned: Array<{ skill: string; sourcePath?: string }>;
  blocked?: Array<{ skill: string }>;
};

type DiffForApply = {
  source: string;
  target: string;
  assignment: string | null;
  readOnly?: boolean;
  planned: Array<{ skill: string; sourcePath: string; variant?: string }>;
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

const BUNDLE_SCHEMA = "calvinnwq.skills.pack-bundle.v0";
const BUNDLE_FILE = "skill-suitcase-bundle.json";
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

  let context: ApprovalContext;

  if (hasLock) {
    context = await resolveLockContext({ lockPath: lock, source, target });
  } else {
    context = await resolveArtifactContext({ artifactPath: artifact!, source, target });
  }

  if (!context.ok) {
    return failure({
      source,
      target,
      mode: context.mode,
      input: context.input,
      errors: context.errors
    });
  }

  const diffResult = await diff({ source, target, targetOverrides }) as DiffForApply;
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

  const hygiene = checkSelectedSourceHygiene({
    sourceRoot: diffResult.source,
    plannedSkills: diffResult.planned
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

  const preStatus = await status({
    source: diffResult.source,
    target,
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
  const preApplyErrors: ApplyFinding[] = [];

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

  for (const targetStatus of targetStatuses) {
    if (
      targetStatus.status === "dirty"
      && await isApprovedDirtyBehindUpdate({
        statusItem: targetStatus,
        skillsWithWrites,
        diffEntriesBySkill,
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
      target
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
  const variantBySkill = new Map<string, string>();
  for (const planned of diffResult.planned) {
    sourceBySkill.set(planned.skill, planned.sourcePath);
    if (typeof planned.variant === "string" && planned.variant.trim().length > 0) {
      variantBySkill.set(planned.skill, planned.variant);
    }
  }

  const statusBySkill = new Map<string, StatusItem>();
  for (const statusItem of targetStatuses) {
    statusBySkill.set(statusItem.skill, statusItem);
  }

  const filesAppliedBySkill = new Map<string, number>();
  const restorePlan: Array<{ targetPath: string; backupPath: string | null }> = [];
  const successfulWritesRef = {
    value: 0
  };

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
  let writeResult: WritePlannedSkillResult;

  const entriesBySkill = new Map<string, WriteEntry[]>();
  for (const entry of writeEntries.items) {
    const bucket = entriesBySkill.get(entry.skill);
    if (bucket === undefined) {
      entriesBySkill.set(entry.skill, [entry]);
      continue;
    }
    bucket.push(entry);
  }
  const rollbackBySkill = new Map<string, RollbackRecord>();

  for (const [skill, entries] of entriesBySkill) {
    const skillSource = sourceBySkill.get(skill);
    if (!skillSource) {
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
        errors: [{ code: "missing_skill_source", message: `No source path for ${skill}` }]
      });
    }

    rollbackBySkill.set(skill, await buildRollbackRecord({
      targetPath: path.join(installRoot, skill),
      entries
    }));

    writeResult = await writePlannedSkillEntries({
      skill,
      entries,
      failAfterSuccessfulWrites,
      successfulWritesRef
    });

    if (!writeResult.ok) {
      await rollbackApplyWrites({
        restorePlan
      });
      await cleanupApplyBackups({ restorePlan });
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
        errors: [{ code: "write_error", message: writeResult.message }]
      });
    }

    filesAppliedBySkill.set(skill, entries.length);
    restorePlan.push(...writeResult.restorePlan);
    successfulWritesRef.value = writeResult.successfulWrites;
  }

  const receiptPath = path.join(installRoot, RECEIPT_FILE);
  const previousReceiptText = await readFileSafeText(receiptPath);

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

      const targetPath = path.join(installRoot, skill);
      const nextRecord: Record<string, unknown> = {
        skill,
        agent: (diffResult.assignment ?? target),
        mode: "copy",
        source: {
          path: skillSource
        },
        sourcePath: skillSource,
        targetPath
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
        installRecord: buildInstallRecord(nextRecord)
      });
    }
  } catch (error) {
    await rollbackApplyWrites({
      restorePlan
    });
    await restoreOriginalReceipt({
      receiptPath,
      previousReceiptText
    });
    await cleanupApplyBackups({ restorePlan });
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
      }]
    });
  }

  await cleanupApplyBackups({ restorePlan });

  let postApplyStatus: StatusResult | null = null;
  try {
    postApplyStatus = await status({
      source: diffResult.source,
      target,
      targetOverrides
    });
  } catch {
    postApplyStatus = null;
  }

  return {
    ok: true,
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
    errors: []
  };
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

type SymlinkApplyPlanItem = {
  skill: string;
  sourcePath: string;
  targetPath: string;
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
  target
}: {
  diffResult: DiffForApply;
  context: ApprovalContext;
  installRoot: string;
  preStatusSource: string;
  targetStatuses: StatusItem[];
  preApplySummary: ApplyStatusSummary;
  targetOverrides: TargetOverrides | undefined;
  target: string;
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
    const targetPath = path.join(installRoot, planned.skill);

    if (!(await isPathWithinRoot({ candidatePath: sourcePath, rootPath: sourceRoot }))) {
      errors.push({
        code: "symlink_source_escape",
        message: `Refusing to symlink ${planned.skill}: source ${sourcePath} escapes the approved source root ${sourceRoot}.`
      });
      continue;
    }

    const classification = await classifySymlinkInstall({ targetPath, expectedSourcePath: sourcePath });
    if (classification.state === "missing") {
      plannedItems.push({ skill: planned.skill, sourcePath, targetPath, variant: symlinkVariant(planned), action: "create" });
      continue;
    }
    if (classification.state === "correct") {
      // Already linked at the selected source: idempotent re-apply, refresh the
      // receipt only.
      plannedItems.push({ skill: planned.skill, sourcePath, targetPath, variant: symlinkVariant(planned), action: "noop" });
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
  const receiptPath = path.join(installRoot, RECEIPT_FILE);
  const previousReceiptText = await readFileSafeText(receiptPath);
  const previousReceipt = await readReceipt({ installRoot }).catch((): Receipt => ({}));
  const linkedSkills: string[] = [];
  const createdLinks: string[] = [];
  try {
    for (const item of plannedItems) {
      if (item.action === "create") {
        await mkdir(path.dirname(item.targetPath), { recursive: true });
        await symlink(item.sourcePath, item.targetPath, "dir");
        createdLinks.push(item.targetPath);
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
        installRecord: buildInstallRecord(nextRecord)
      });
      linkedSkills.push(item.skill);
    }
  } catch (error) {
    // Best-effort: remove only the links this run created and restore the prior
    // receipt. Never touch the source tree the link points at.
    for (const linkPath of [...createdLinks].reverse()) {
      await unlinkSafe(linkPath);
    }
    await restoreOriginalReceipt({ receiptPath, previousReceiptText });
    return failSymlink([{
      code: "symlink_write_error",
      message: error instanceof Error ? error.message : "Unknown symlink write error"
    }]);
  }

  let postApplyStatus: StatusResult | null = null;
  try {
    postApplyStatus = await status({ source: sourceRoot, target, targetOverrides });
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

function findReceiptInstallRecord({
  receipt,
  skillName,
  targetPath,
  installRoot
}: {
  receipt: Receipt;
  skillName: string;
  targetPath: string;
  installRoot: string;
}): ReceiptInstallRecord | null {
  const entry = receipt.installs?.[skillName];
  const records = Array.isArray(entry) ? entry : entry === undefined ? [] : [entry];
  const normalizedTarget = path.resolve(targetPath);
  return records.find((record) => normalizeTargetPathForInstallRoot(record.targetPath, installRoot) === normalizedTarget) ?? null;
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

function normalizeTargetPathForInstallRoot(value: unknown, installRoot: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(installRoot, value);
}

function normalizeSymlinkRecordSourcePath(record: ReceiptInstallRecord): string | null {
  if (typeof record.sourcePath === "string" && record.sourcePath.trim().length > 0) {
    return record.sourcePath;
  }
  if (isRecord(record.source) && typeof record.source.path === "string" && record.source.path.trim().length > 0) {
    return record.source.path;
  }
  return null;
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

type ApprovalContext = {
  ok: boolean;
  mode: ApplyMode;
  input: string;
  sourceCommit: string;
  errors: ApplyFinding[];
};

async function resolveLockContext({ lockPath, source, target }: {
  lockPath: string;
  source: string;
  target: string;
}): Promise<ApprovalContext> {
  const resolved = path.resolve(lockPath);
  const normalizedSource = path.resolve(source);
  const parsed = await readJson(resolved);

  if (!isRecord(parsed) || !isPlanLock(parsed)) {
    return {
      ok: false,
      mode: "lock",
      input: resolved,
      sourceCommit: "",
      errors: [{ code: "invalid_apply_input", message: `Invalid lockfile at ${resolved}` }]
    };
  }

  const lock = parsed as PlanLockManifest;
  if (lock.target !== target) {
    return {
      ok: false,
      mode: "lock",
      input: resolved,
      sourceCommit: lock.source.commit ?? "",
      errors: [{
        code: "plan_lock_target_mismatch",
        message: `Plan-lock target ${lock.target} does not match apply target ${target}`
      }]
    };
  }

  if (path.resolve(lock.source.repo) !== normalizedSource) {
    return {
      ok: false,
      mode: "lock",
      input: resolved,
      sourceCommit: lock.source.commit ?? "",
      errors: [{
        code: "plan_lock_source_mismatch",
        message: `Plan-lock source ${lock.source.repo} does not match apply source ${source}`
      }]
    };
  }

  const assessed = await assessPlanLock({
    source: normalizedSource,
    target: lock.target,
    assignmentPath: lock.assignmentPath ?? target,
    lock,
    ...(lock.source.commit ? { sourceCommit: lock.source.commit } : {})
  });

  if (!assessed.valid) {
    return {
      ok: false,
      mode: "lock",
      input: resolved,
      sourceCommit: lock.source.commit ?? "",
      errors: assessed.reasons.map((reason) => ({
        code: `plan_lock_${reason}`,
        message: `Plan-lock is stale: ${reason}`
      }))
    };
  }

  return {
    ok: true,
    mode: "lock",
    input: resolved,
    sourceCommit: lock.source.commit ?? "",
    errors: []
  };
}

async function resolveArtifactContext({ artifactPath, source, target }: {
  artifactPath: string;
  source: string;
  target: string;
}): Promise<ApprovalContext> {
  const manifestPath = await resolveArtifactManifestPath(artifactPath);
  if (manifestPath === null) {
    return {
      ok: false,
      mode: "artifact",
      input: artifactPath,
      sourceCommit: "",
      errors: [{
        code: "invalid_artifact_manifest",
        message: "Cannot locate skill-suitcase-bundle.json"
      }]
    };
  }

  const parsed = await readJson(manifestPath);
  if (!isRecord(parsed)) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      sourceCommit: "",
      errors: [{
        code: "invalid_artifact_manifest",
        message: `Invalid artifact manifest at ${manifestPath}`
      }]
    };
  }

  const manifest = parsed as ArtifactManifest;
  if (!isRecord(manifest.source) || !isNonEmptyString(manifest.source.repo)) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      sourceCommit: "",
      errors: [{
        code: "invalid_artifact_manifest",
        message: `Invalid artifact manifest at ${manifestPath}`
      }]
    };
  }

  if (
    manifest.source.ref !== undefined
    && manifest.source.ref !== null
    && typeof manifest.source.ref !== "string"
  ) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      sourceCommit: "",
      errors: [{
        code: "invalid_artifact_manifest",
        message: `Invalid artifact manifest at ${manifestPath}`
      }]
    };
  }

  if (
    manifest.source.commit !== undefined
    && manifest.source.commit !== null
    && typeof manifest.source.commit !== "string"
  ) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      sourceCommit: "",
      errors: [{
        code: "invalid_artifact_manifest",
        message: `Invalid artifact manifest at ${manifestPath}`
      }]
    };
  }

  if (manifest.schema !== BUNDLE_SCHEMA) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      sourceCommit: typeof manifest.source.commit === "string" ? manifest.source.commit : "",
      errors: [{
        code: "invalid_artifact_manifest",
        message: `Unsupported artifact schema ${manifest.schema}`
      }]
    };
  }

  if (manifest.target !== target) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      sourceCommit: typeof manifest.source.commit === "string" ? manifest.source.commit : "",
      errors: [{
        code: "artifact_target_mismatch",
        message: `Artifact target ${manifest.target} does not match apply target ${target}`
      }]
    };
  }

  if (path.resolve(manifest.source.repo) !== path.resolve(source)) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      sourceCommit: typeof manifest.source.commit === "string" ? manifest.source.commit : "",
      errors: [{
        code: "artifact_source_mismatch",
        message: `Artifact source ${manifest.source.repo} does not match apply source ${source}`
      }]
    };
  }

  if (Array.isArray(manifest.blocked) && manifest.blocked.length > 0) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      sourceCommit: typeof manifest.source.commit === "string" ? manifest.source.commit : "",
      errors: [{
        code: "artifact_blocked",
        message: "Artifact includes blocked plan entries"
      }]
    };
  }

  if (!Array.isArray(manifest.planned) || manifest.planned.length === 0) {
    return {
      ok: false,
      mode: "artifact",
      input: manifestPath,
      sourceCommit: typeof manifest.source.commit === "string" ? manifest.source.commit : "",
      errors: [{
        code: "artifact_missing_planned",
        message: "Artifact contains no planned skills"
      }]
    };
  }

  return {
    ok: true,
    mode: "artifact",
    input: manifestPath,
    sourceCommit: typeof manifest.source.commit === "string" ? manifest.source.commit : "",
    errors: []
  };
}

type WriteEntry = {
  skill: string;
  relativePath: string;
  sourcePath: string;
  targetPath: string;
};

type WriteEntries = {
  items: WriteEntry[];
  errors: ApplyFinding[];
};

type WritePlannedSkillInput = {
  skill: string;
  entries: WriteEntry[];
  failAfterSuccessfulWrites: number | null;
  successfulWritesRef: {
    value: number;
  };
};

type WritePlannedSkillResult = {
  ok: true;
  successfulWrites: number;
  restorePlan: Array<{ targetPath: string; backupPath: string | null }>;
} | {
  ok: false;
  message: string;
  successfulWrites: number;
  restorePlan: Array<{ targetPath: string; backupPath: string | null }>;
};

type RollbackFileState = {
  kind: "file";
  sha256: string;
  bytes: string;
} | {
  kind: "missing";
} | {
  kind: "restore-impossible";
  reason: string;
};

type RollbackFileRecord = {
  path: string;
  targetPath: string;
  previous: RollbackFileState;
};

type RollbackRecord = {
  schema: "calvinnwq.skills.rollback.v0";
  status: "available";
  targetPath: string;
  files: RollbackFileRecord[];
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

async function isApprovedDirtyBehindUpdate({
  statusItem,
  skillsWithWrites,
  diffEntriesBySkill,
  receipt,
  installRoot
}: {
  statusItem: StatusItem;
  skillsWithWrites: Set<string>;
  diffEntriesBySkill: Map<string, DiffForApply["entries"]>;
  receipt: Receipt;
  installRoot: string;
}): Promise<boolean> {
  const installRecord = findReceiptInstallRecord({
    receipt,
    skillName: statusItem.skill,
    targetPath: statusItem.targetPath,
    installRoot
  });
  if (
    installRecord?.mode !== "copy"
    || statusItem.installedHash === null
    || statusItem.currentHash === null
    || statusItem.installedHash === statusItem.currentHash
    || !skillsWithWrites.has(statusItem.skill)
    || !(await isPathWithinRoot({ candidatePath: statusItem.targetPath, rootPath: installRoot }))
    || !(await isRealDirectory(statusItem.targetPath))
  ) {
    return false;
  }

  const skillEntries = diffEntriesBySkill.get(statusItem.skill) ?? [];
  return skillEntries.length > 0
    && skillEntries.every((entry) => entry.action === "create" || entry.action === "update" || entry.action === "unchanged")
    && skillEntries.some((entry) => entry.action === "create" || entry.action === "update")
    && await targetEntriesAreSafeForDirtyBehind({
      entries: skillEntries,
      installRecord,
      targetRoot: statusItem.targetPath
    });
}

async function isRealDirectory(targetPath: string): Promise<boolean> {
  try {
    const info = await lstat(targetPath);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function targetEntriesAreSafeForDirtyBehind({
  entries,
  installRecord,
  targetRoot
}: {
  entries: DiffForApply["entries"];
  installRecord: ReceiptInstallRecord;
  targetRoot: string;
}): Promise<boolean> {
  const installedFiles = receiptInstalledFileHashes(installRecord.installedFiles);
  if (installedFiles === null) {
    return false;
  }

  if (!(await receiptOwnedFilesStillMatch({ targetRoot, installedFiles }))) {
    return false;
  }

  for (const entry of entries) {
    if (entry.action !== "create" && entry.action !== "update") {
      continue;
    }

    const relativePath = typeof entry.relativePath === "string" ? entry.relativePath : null;
    const targetPath = typeof entry.targetPath === "string" ? entry.targetPath : null;
    if (relativePath === null || targetPath === null) {
      return false;
    }

    if (!(await plannedWriteStaysInRealTarget({ targetRoot, targetPath }))) {
      return false;
    }

    const expectedHash = installedFiles.get(relativePath);
    if (entry.action === "create") {
      if (expectedHash !== undefined) {
        return false;
      }
      continue;
    }

    if (expectedHash === undefined) {
      return false;
    }

    let targetHash: string;
    try {
      targetHash = createHash("sha256").update(await readFile(targetPath)).digest("hex");
    } catch {
      return false;
    }

    if (targetHash !== expectedHash) {
      return false;
    }
  }

  return true;
}

async function plannedWriteStaysInRealTarget({
  targetRoot,
  targetPath
}: {
  targetRoot: string;
  targetPath: string;
}): Promise<boolean> {
  const resolvedTargetRoot = path.resolve(targetRoot);
  const resolvedTargetPath = path.resolve(targetPath);
  const relativePath = path.relative(resolvedTargetRoot, resolvedTargetPath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return false;
  }

  let candidatePath = resolvedTargetPath;
  while (true) {
    try {
      const info = await lstat(candidatePath);
      if (info.isSymbolicLink()) {
        return false;
      }
      return isPathWithinRoot({ candidatePath, rootPath: targetRoot });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        return false;
      }
    }

    const parentPath = path.dirname(candidatePath);
    if (parentPath === candidatePath) {
      return false;
    }
    candidatePath = parentPath;
  }
}

function receiptInstalledFileHashes(installedFiles: unknown): Map<string, string> | null {
  if (!Array.isArray(installedFiles) || installedFiles.length === 0) {
    return null;
  }

  const hashes = new Map<string, string>();
  for (const file of installedFiles) {
    if (!isReceiptInstalledFile(file)) {
      return null;
    }
    hashes.set(file.path, file.hash);
  }
  return hashes;
}

async function receiptOwnedFilesStillMatch({
  targetRoot,
  installedFiles
}: {
  targetRoot: string;
  installedFiles: Map<string, string>;
}): Promise<boolean> {
  for (const [relativePath, expectedHash] of installedFiles) {
    const targetPath = path.join(targetRoot, relativePath);
    if (!(await plannedWriteStaysInRealTarget({ targetRoot, targetPath }))) {
      return false;
    }

    let info;
    try {
      info = await lstat(targetPath);
    } catch {
      return false;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      return false;
    }

    let targetHash: string;
    try {
      targetHash = createHash("sha256").update(await readFile(targetPath)).digest("hex");
    } catch {
      return false;
    }
    if (targetHash !== expectedHash) {
      return false;
    }
  }
  return true;
}

function isReceiptInstalledFile(file: unknown): file is ReceiptInstalledFile {
  return file !== null
    && typeof file === "object"
    && typeof (file as { path?: unknown }).path === "string"
    && typeof (file as { hash?: unknown }).hash === "string";
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
    failAfterSuccessfulWrites,
    successfulWritesRef
  }: WritePlannedSkillInput
): Promise<WritePlannedSkillResult> {
  const tempSuffix = `suitcase-apply-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const nextRestorePlan: Array<{ targetPath: string; backupPath: string | null }> = [];

  try {
    for (const entry of entries) {
      await writePlannedEntryWithRollback({
        entry,
        restorePlan: nextRestorePlan,
        tempSuffix
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
    for (const plannedRestore of [...nextRestorePlan].reverse()) {
      await rollbackPlannedEntry(plannedRestore);
      if (plannedRestore.backupPath !== null) {
        await unlinkSafe(plannedRestore.backupPath);
      }
    }

    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unknown write error",
      successfulWrites: successfulWritesRef.value,
      restorePlan: []
    };
  }
}

async function writePlannedEntryWithRollback({
  entry,
  tempSuffix,
  restorePlan
}: {
  entry: WriteEntry;
  tempSuffix: string;
  restorePlan: Array<{ targetPath: string; backupPath: string | null }>;
}): Promise<void> {
  const targetPath = entry.targetPath;
  const sourcePath = entry.sourcePath;
  const tmpPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let backupPath: string | null = null;

  try {
    await mkdir(path.dirname(targetPath), { recursive: true });

    if (await statSafe(targetPath) !== null) {
      backupPath = `${targetPath}.previous-${tempSuffix}`;
      await rename(targetPath, backupPath);
    }

    const contents = await readFile(sourcePath);
    await writeFile(tmpPath, contents);
    await rename(tmpPath, targetPath);
    restorePlan.push({
      targetPath,
      backupPath
    });
  } catch (error) {
    await rollbackPlannedEntry({
      targetPath,
      backupPath
    });
    try {
      await unlinkSafe(tmpPath);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

async function rollbackPlannedEntry({
  targetPath,
  backupPath
}: {
  targetPath: string;
  backupPath: string | null;
}): Promise<void> {
  if (backupPath === null) {
    try {
      await unlink(targetPath);
    } catch {
      // best effort
    }
    return;
  }

  try {
    await rename(backupPath, targetPath);
  } catch {
    // best effort
  }
}

async function rollbackApplyWrites({
  restorePlan
}: {
  restorePlan: Array<{ targetPath: string; backupPath: string | null }>;
}): Promise<void> {
  for (const plannedRestore of [...restorePlan].reverse()) {
    await rollbackPlannedEntry(plannedRestore);
  }
}

async function cleanupApplyBackups({
  restorePlan
}: {
  restorePlan: Array<{ targetPath: string; backupPath: string | null }>;
}): Promise<void> {
  for (const plannedRestore of restorePlan) {
    if (plannedRestore.backupPath !== null) {
      await unlinkSafe(plannedRestore.backupPath);
    }
  }
}

async function restoreOriginalReceipt({
  receiptPath,
  previousReceiptText
}: {
  receiptPath: string;
  previousReceiptText: string | null;
}): Promise<void> {
  if (previousReceiptText === null) {
    await unlinkSafe(receiptPath);
    return;
  }

  try {
    await writeFile(receiptPath, previousReceiptText, "utf8");
  } catch {
    // best effort
  }
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

async function readJson(filePath: string): Promise<unknown> {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function resolveArtifactManifestPath(candidate: string | null): Promise<string | null> {
  if (!hasText(candidate)) {
    return null;
  }

  const asPath = path.resolve(candidate);
  if ((await statSafe(asPath))?.isFile() && path.basename(asPath) === BUNDLE_FILE) {
    return asPath;
  }

  const inArtifacts = path.join(asPath, ".skill-suitcase", "artifacts", BUNDLE_FILE);
  if ((await statSafe(inArtifacts))?.isFile()) {
    return inArtifacts;
  }

  const plainManifest = path.join(asPath, BUNDLE_FILE);
  if ((await statSafe(plainManifest))?.isFile()) {
    return plainManifest;
  }

  return null;
}

function isPlanLock(value: unknown): value is PlanLockManifest {
  if (!isRecord(value)) {
    return false;
  }

  if (value.schema !== PLAN_LOCK_SCHEMA) {
    return false;
  }

  if (!isNonEmptyString(value.target)) {
    return false;
  }

  const source = value.source;
  if (!isRecord(source)) {
    return false;
  }

  if (!isNonEmptyString(source.repo)) {
    return false;
  }

  if (!Array.isArray(value.selectedSkills)) {
    return false;
  }

  if (source.commit !== null && source.commit !== undefined && !isString(source.commit)) {
    return false;
  }

  if (source.ref !== null && source.ref !== undefined && !isString(source.ref)) {
    return false;
  }

  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
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

async function unlinkSafe(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // best effort only
  }
}
