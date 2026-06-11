import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessPlanLock, type PlanLock, PLAN_LOCK_SCHEMA } from "./plan-lock.js";
import { diff } from "./diff.js";
import { RECEIPT_FILE, buildInstallRecord, buildInstalledFiles, upsertAndWriteReceipt } from "./receipt.js";
import { status } from "./status.js";

type ApplyInput = {
  source: string;
  target: string;
  lock?: string;
  artifact?: string;
  __test?: {
    failAfterSuccessfulWrites?: number;
    failAfterReceiptWrites?: number;
  };
};

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
  planned: Array<{ skill: string; sourcePath: string }>;
  blocked: Array<Record<string, unknown>>;
  entries: Array<{
    action: "create" | "update" | "unchanged" | "extra" | "missing" | "blocked";
    skill: string;
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

export async function apply({
  source,
  target,
  lock,
  artifact,
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

  let context: ApprovalContext;

  if (hasLock) {
    context = await resolveLockContext({ lockPath: lock, source, target });
  } else if (hasArtifact) {
    context = await resolveArtifactContext({ artifactPath: artifact, source, target });
  } else {
    return failure({
      source,
      target,
      mode: "lock",
      input: null,
      errors: [{
        code: "missing_apply_input",
        message: "apply requires exactly one of --lock or --artifact"
      }]
    });
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

  const diffResult = await diff({ source, target }) as DiffForApply;
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
      errors: diffResult.errors.map((error) => ({ code: `diff_${error.code}`, message: error.message }))
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

  const preStatus = await status({ source: diffResult.source });
  const targetAssignment = diffResult.assignment ?? target;
  const targetStatuses = preStatus.statuses.filter(
    (entry) => entry.target === installRoot && entry.assignment === targetAssignment
  );
  const preApplySummary = summarizeStatus(targetStatuses);

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

  const writeEntries = collectApplyEntries(diffResult.entries);
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
  for (const planned of diffResult.planned) {
    sourceBySkill.set(planned.skill, planned.sourcePath);
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
    for (const [skill] of filesAppliedBySkill) {
      const priorState = statusBySkill.get(skill);
      const skillSource = sourceBySkill.get(skill);
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

  const postApplyStatus = await status({ source: diffResult.source });

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
