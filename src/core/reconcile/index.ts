import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCatalog, type TargetOverrides } from "../catalog/index.js";
import { diff } from "../diffing/index.js";
import {
  RECEIPT_FILE,
  buildInstallRecord,
  buildInstalledFiles,
  upsertAndWriteReceipt
} from "../receipts/index.js";
import { readSkillVersion } from "../skill-metadata.js";
import {
  collectSourcePolicyDeniedPaths,
  sourcePolicyDecision,
  sourcePolicyPrunesDirectory,
  type SourcePolicy
} from "../source-policy.js";
import { status } from "../status/index.js";

type ReconcileInput = {
  source: string;
  target: string;
  skills?: string[];
  dryRun?: boolean;
  apply?: boolean;
  targetOverrides?: TargetOverrides | undefined;
  __test?: {
    failAfterBackup?: boolean;
    failAfterBackupForSkill?: string;
    failBeforeReceipt?: boolean;
  };
};

type ReconcileError = {
  code: string;
  message: string;
  skill?: string;
  path?: string;
};

type ReconcileDiffEntry = {
  action: "create" | "update" | "unchanged" | "extra" | "missing" | "blocked";
  skill: string;
  relativePath: string | null;
  sourcePath: string | null;
  targetPath: string | null;
  reason?: string;
};

type ReconcileChanges = {
  create: number;
  update: number;
  extra: number;
  missing: number;
  unchanged: number;
};

type ReconcileCandidate = {
  skill: string;
  sourcePath: string;
  targetPath: string;
  variant?: string;
  status: "unknown";
  reason: string;
  changes: ReconcileChanges;
  entries: ReconcileDiffEntry[];
  backup: {
    strategy: "rename-target-directory";
    backupPathTemplate: string;
  };
};

type ReconciledBackup = {
  skill: string;
  targetPath: string;
  backupPath: string;
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

type ReconcileBaseResult = {
  ok: boolean;
  dryRun: boolean;
  readOnly: boolean;
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  selected: {
    skills: string[];
  };
  candidates: ReconcileCandidate[];
  refused: {
    skills: string[];
  };
  summary: {
    planned: number;
    candidates: number;
    refused: number;
    blocked: number;
    create: number;
    update: number;
    extra: number;
    missing: number;
    unchanged: number;
  };
  errors: ReconcileError[];
};

export type ReconcilePlanResult = ReconcileBaseResult & {
  dryRun: true;
  readOnly: true;
  reconciled: {
    skills: [];
    files: 0;
    backups: [];
  };
  receiptPath: null;
  postReconcileStatus: null;
};

export type ReconcileApplyResult = ReconcileBaseResult & {
  dryRun: false;
  readOnly: false;
  reconciled: {
    skills: string[];
    files: number;
    backups: ReconciledBackup[];
  };
  receiptPath: string | null;
  postReconcileStatus: Awaited<ReturnType<typeof status>> | null;
};

export type ReconcileResult = ReconcilePlanResult | ReconcileApplyResult;

type DiffForReconcile = {
  ok: boolean;
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  readOnly?: boolean;
  planned: Array<{ skill: string; sourcePath: string; variant?: string }>;
  blocked: Array<{ skill: string; reason?: string }>;
  entries: ReconcileDiffEntry[];
  errors: Array<{ code: string; message: string; skill?: string }>;
};

type StatusResult = Awaited<ReturnType<typeof status>>;
type StatusItem = StatusResult["statuses"][number];

const ROLLBACK_SCHEMA = "calvinnwq.skills.rollback.v0";

export async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  if (!input.source) {
    throw new Error("source is required");
  }
  if (!input.target) {
    throw new Error("target is required");
  }

  const selectedSkills = normalizeSelectedSkills(input.skills);
  if (input.skills === undefined || selectedSkills.length === 0 || hasBlankSkillFilter(input.skills)) {
    return planFailure({
      source: input.source,
      target: input.target,
      assignment: null,
      installRoot: null,
      selected: selectedSkills,
      errors: [reconcileError({
        code: "invalid_skill_filter",
        message: "At least one non-blank skill filter is required for reconcile."
      })]
    });
  }

  const wantsDryRun = input.dryRun === true;
  const wantsApply = input.apply === true;
  if (wantsDryRun === wantsApply) {
    return planFailure({
      source: input.source,
      target: input.target,
      assignment: null,
      installRoot: null,
      selected: selectedSkills,
      errors: [reconcileError({
        code: "invalid_reconcile_mode",
        message: "reconcile requires exactly one of dryRun or apply."
      })]
    });
  }

  const plan = await planReconcile(input, selectedSkills);
  if (wantsDryRun || !plan.ok) {
    return {
      ...plan,
      dryRun: true,
      readOnly: true,
      reconciled: {
        skills: [],
        files: 0,
        backups: []
      },
      receiptPath: null,
      postReconcileStatus: null
    };
  }

  return executeReconcile(input, plan);
}

async function planReconcile(input: ReconcileInput, selectedSkills: string[]): Promise<ReconcileBaseResult> {
  const selectedSkillSet = new Set(selectedSkills);
  const diffInput: Parameters<typeof diff>[0] = {
    source: input.source,
    target: input.target,
    skills: selectedSkills
  };
  if (input.targetOverrides !== undefined) {
    diffInput.targetOverrides = input.targetOverrides;
  }
  const diffResult = await diff(diffInput) as DiffForReconcile;
  const errors: ReconcileError[] = [];

  if (diffResult.readOnly === true) {
    errors.push(reconcileError({
      code: "read_only_target",
      message: `Target ${input.target} is modeled read-only and cannot be reconciled.`
    }));
  }

  if (diffResult.installRoot === null) {
    errors.push(reconcileError({
      code: "missing_install_root",
      message: "could not resolve install root for reconcile"
    }));
  }

  for (const error of diffResult.errors) {
    if (error.skill !== undefined && !selectedSkillSet.has(error.skill)) {
      continue;
    }
    errors.push(reconcileError({
      code: `diff_${error.code}`,
      message: error.message,
      ...(error.skill !== undefined ? { skill: error.skill } : {})
    }));
  }

  for (const blocked of diffResult.blocked) {
    if (!selectedSkillSet.has(blocked.skill)) {
      continue;
    }
    errors.push(reconcileError({
      code: "blocked_skill",
      message: `Skill ${blocked.skill} is blocked for reconcile: ${blocked.reason ?? "blocked"}`,
      skill: blocked.skill
    }));
  }

  const plannedBySkill = new Map(diffResult.planned.map((planned) => [planned.skill, planned]));
  const entriesBySkill = groupEntriesBySkill(diffResult.entries, selectedSkillSet);

  for (const skill of selectedSkills) {
    if (!plannedBySkill.has(skill)) {
      errors.push(reconcileError({
        code: "skill_not_planned",
        message: `Skill ${skill} is not planned for target ${diffResult.assignment ?? diffResult.target}.`,
        skill
      }));
    }
  }

  if (diffResult.readOnly === true || diffResult.installRoot === null) {
    return buildBaseResult({
      ok: false,
      source: diffResult.source,
      target: input.target,
      assignment: diffResult.assignment,
      installRoot: diffResult.installRoot,
      selected: selectedSkills,
      candidates: [],
      planned: countSelectedPlanned(diffResult.planned, selectedSkillSet),
      blocked: countSelectedBlocked(diffResult.blocked, selectedSkillSet),
      errors
    });
  }

  const statusInput: Parameters<typeof status>[0] = {
    source: diffResult.source,
    target: input.target
  };
  if (input.targetOverrides !== undefined) {
    statusInput.targetOverrides = input.targetOverrides;
  }
  const statusResult = await status(statusInput);
  for (const statusError of statusResult.errors) {
    if (statusError.skill !== undefined && !selectedSkillSet.has(statusError.skill)) {
      continue;
    }
    errors.push(reconcileError({
      code: `status_${statusError.code}`,
      message: statusError.message,
      ...(statusError.skill !== undefined ? { skill: statusError.skill } : {}),
      ...(statusError.path !== undefined ? { path: statusError.path } : {})
    }));
  }

  const statusesBySkill = new Map(
    statusResult.statuses
      .filter((item) => item.assignment === (diffResult.assignment ?? input.target) && selectedSkillSet.has(item.skill))
      .map((item) => [item.skill, item])
  );

  const candidates: ReconcileCandidate[] = [];
  for (const skill of selectedSkills) {
    const planned = plannedBySkill.get(skill);
    if (planned === undefined) {
      continue;
    }

    if (!isPlainPathSegment(skill)) {
      errors.push(reconcileError({
        code: "unsafe_path",
        message: `Skill ${skill} is not a plain skill directory name and cannot be reconciled.`,
        skill
      }));
      continue;
    }

    if (!isSameOrInsidePath(planned.sourcePath, diffResult.source)) {
      errors.push(reconcileError({
        code: "unsafe_path",
        message: `Source path for ${skill} resolves outside the catalog source root.`,
        skill,
        path: planned.sourcePath
      }));
      continue;
    }

    const statusItem = statusesBySkill.get(skill);
    if (statusItem === undefined) {
      errors.push(reconcileError({
        code: "unsupported_target_state",
        message: `Skill ${skill} has no status entry for target ${input.target}.`,
        skill
      }));
      continue;
    }

    if (!isSameOrInsidePath(statusItem.targetPath, diffResult.installRoot)) {
      errors.push(reconcileError({
        code: "unsafe_path",
        message: `Target path for ${skill} resolves outside the install root and cannot be reconciled.`,
        skill,
        path: statusItem.targetPath
      }));
      continue;
    }

    if (statusItem.status !== "unknown" || statusItem.reason !== "target exists but has no Suitcase receipt") {
      errors.push(reconcileError({
        code: "unsupported_target_state",
        message: `Skill ${skill} is ${statusItem.status}: ${statusItem.reason}`,
        skill,
        path: statusItem.targetPath
      }));
      continue;
    }

    const skillEntries = entriesBySkill.get(skill) ?? [];
    const changes = summarizeEntries(skillEntries);
    if (changes.missing > 0 || skillEntries.some((entry) => entry.action === "missing")) {
      errors.push(reconcileError({
        code: "missing_source",
        message: `Skill ${skill} has missing catalog source entries and cannot be reconciled.`,
        skill,
        path: planned.sourcePath
      }));
      continue;
    }

    if (changes.create === 0 && changes.update === 0 && changes.extra === 0) {
      errors.push(reconcileError({
        code: "target_matches_catalog_use_track",
        message: `Skill ${skill} already matches the catalog; use track to adopt it without rewriting files.`,
        skill,
        path: statusItem.targetPath
      }));
      continue;
    }

    const sourceValidation = await validateDirectoryTree(planned.sourcePath, {
      symlinkCode: "unsupported_source_tree",
      unreadableCode: "source_unreadable",
      missingCode: "missing_source",
      label: "Source"
    });
    if (!sourceValidation.ok) {
      errors.push({
        ...sourceValidation.error,
        skill
      });
      continue;
    }

    const targetValidation = await validateDirectoryTree(statusItem.targetPath, {
      symlinkCode: "unsafe_target_tree",
      unreadableCode: "target_unreadable",
      missingCode: "unsupported_target_state",
      label: "Target",
      rejectEmptyDirectories: true
    });
    if (!targetValidation.ok) {
      errors.push({
        ...targetValidation.error,
        skill
      });
      continue;
    }

    const candidate: ReconcileCandidate = {
      skill,
      sourcePath: planned.sourcePath,
      targetPath: statusItem.targetPath,
      status: "unknown",
      reason: statusItem.reason,
      changes,
      entries: skillEntries.sort(compareEntries),
      backup: {
        strategy: "rename-target-directory",
        backupPathTemplate: backupPathTemplate(path.dirname(statusItem.targetPath), skill)
      }
    };
    if (planned.variant !== undefined) {
      candidate.variant = planned.variant;
    }
    candidates.push(candidate);
  }

  return buildBaseResult({
    ok: errors.length === 0 && candidates.length === selectedSkills.length,
    source: diffResult.source,
    target: input.target,
    assignment: diffResult.assignment,
    installRoot: diffResult.installRoot,
    selected: selectedSkills,
    candidates,
    planned: countSelectedPlanned(diffResult.planned, selectedSkillSet),
    blocked: countSelectedBlocked(diffResult.blocked, selectedSkillSet),
    errors
  });
}

async function executeReconcile(input: ReconcileInput, plan: ReconcileBaseResult): Promise<ReconcileApplyResult> {
  const installRoot = plan.installRoot;
  if (installRoot === null) {
    return applyFailure(plan, "missing_install_root", "could not resolve install root for reconcile");
  }

  const receiptPath = path.join(installRoot, RECEIPT_FILE);
  let previousReceiptText: string | null;
  try {
    previousReceiptText = await readOptionalText(receiptPath);
  } catch (error) {
    return applyFailure(plan, "invalid_receipt", `Could not read receipt before reconcile: ${errorMessage(error)}`);
  }

  const reconciledSkills: string[] = [];
  const backups: ReconciledBackup[] = [];
  let reconciledFiles = 0;
  let receiptPathWritten: string | null = null;
  const { manifest } = await loadCatalog(input.source, { targetOverrides: input.targetOverrides });
  const sourcePolicy = manifest.sourcePolicy;

  for (const candidate of plan.candidates) {
    const backupPath = path.join(path.dirname(candidate.targetPath), `.${candidate.skill}.suitcase-pre-reconcile-${uniqueSuffix()}`);
    const tmpPath = path.join(path.dirname(candidate.targetPath), `.${candidate.skill}.suitcase-reconcile-next-${uniqueSuffix()}`);
    let copied = false;
    let backedUp = false;
    let installed = false;

    try {
      await assertSourcePolicyAllowsSource(candidate.sourcePath, sourcePolicy);
      await copyTree(candidate.sourcePath, tmpPath, sourcePolicy);
      copied = true;
      if (!(await treesMatch(candidate.sourcePath, tmpPath, sourcePolicy))) {
        throw new Error(`Temporary reconcile copy for ${candidate.skill} does not match catalog source.`);
      }
      await rename(candidate.targetPath, backupPath);
      backedUp = true;
      if (input.__test?.failAfterBackup === true || input.__test?.failAfterBackupForSkill === candidate.skill) {
        throw new Error("Injected failure after backup.");
      }
      await rename(tmpPath, candidate.targetPath);
      installed = true;
      copied = false;

      if (input.__test?.failBeforeReceipt === true) {
        throw new Error("Injected failure before receipt.");
      }

      const installedFiles = await buildInstalledFiles(candidate.targetPath);
      const rollbackFiles = await buildRollbackFiles({
        previousTargetPath: backupPath,
        appliedTargetPath: candidate.targetPath
      });
      const installRecord: Record<string, unknown> = {
        skill: candidate.skill,
        agent: plan.assignment ?? input.target,
        target: plan.assignment ?? input.target,
        mode: "reconcile",
        source: {
          path: candidate.sourcePath
        },
        sourcePath: candidate.sourcePath,
        targetPath: candidate.targetPath,
        sourceHash: await hashDirectory(candidate.sourcePath, sourcePolicy),
        installedFiles,
        priorState: {
          status: candidate.status,
          reason: candidate.reason
        },
        rollback: {
          schema: ROLLBACK_SCHEMA,
          status: "available",
          mode: "reconcile",
          targetPath: candidate.targetPath,
          sourcePath: candidate.sourcePath,
          backupPath,
          files: rollbackFiles,
          appliedFiles: installedFiles
        }
      };
      const version = await readSkillVersion(candidate.sourcePath).catch(() => null);
      if (version !== null) {
        installRecord.version = version;
      }
      if (candidate.variant !== undefined) {
        installRecord.variant = candidate.variant;
      }

      receiptPathWritten = await upsertAndWriteReceipt({
        installRoot,
        skillName: candidate.skill,
        installRecord: buildInstallRecord(installRecord)
      });
      reconciledSkills.push(candidate.skill);
      reconciledFiles += installedFiles.length;
      backups.push({
        skill: candidate.skill,
        targetPath: candidate.targetPath,
        backupPath
      });
    } catch (error) {
      if (installed) {
        await removePath(candidate.targetPath);
      }
      if (backedUp) {
        await restorePath(backupPath, candidate.targetPath);
      }
      if (copied) {
        await removePath(tmpPath);
      }
      await restoreOriginalReceipt({ receiptPath, previousReceiptText });
      for (const completed of backups.reverse()) {
        await removePath(completed.targetPath);
        await restorePath(completed.backupPath, completed.targetPath);
      }
      reconciledSkills.length = 0;
      reconciledFiles = 0;
      backups.length = 0;
      receiptPathWritten = null;
      return {
        ...plan,
        ok: false,
        dryRun: false,
        readOnly: false,
        refused: {
          skills: [...new Set([...plan.refused.skills, candidate.skill])].sort()
        },
        summary: {
          ...plan.summary,
          refused: plan.summary.refused + 1
        },
        errors: [
          ...plan.errors,
          reconcileError({
            code: "reconcile_write_failed",
            message: errorMessage(error),
            skill: candidate.skill,
            path: candidate.targetPath
          })
        ],
        reconciled: {
          skills: reconciledSkills.sort(),
          files: reconciledFiles,
          backups: backups.sort(compareBackups)
        },
        receiptPath: receiptPathWritten,
        postReconcileStatus: null
      };
    }
  }

  const statusInput: Parameters<typeof status>[0] = {
    source: plan.source,
    target: input.target
  };
  if (input.targetOverrides !== undefined) {
    statusInput.targetOverrides = input.targetOverrides;
  }
  const postReconcileStatus = await status(statusInput).catch(() => null);
  const postStatusErrors = postStatusCurrentErrors({
    postReconcileStatus,
    plan,
    inputTarget: input.target
  });

  return {
    ...plan,
    ok: postStatusErrors.length === 0,
    dryRun: false,
    readOnly: false,
    errors: [
      ...plan.errors,
      ...postStatusErrors
    ],
    reconciled: {
      skills: reconciledSkills.sort(),
      files: reconciledFiles,
      backups: backups.sort(compareBackups)
    },
    receiptPath: receiptPathWritten,
    postReconcileStatus
  };
}

function postStatusCurrentErrors({
  postReconcileStatus,
  plan,
  inputTarget
}: {
  postReconcileStatus: StatusResult | null;
  plan: ReconcileBaseResult;
  inputTarget: string;
}): ReconcileError[] {
  if (postReconcileStatus === null) {
    return [reconcileError({
      code: "post_status_unavailable",
      message: "Could not verify post-reconcile status."
    })];
  }

  const errors: ReconcileError[] = [];
  const targetAssignment = plan.assignment ?? inputTarget;
  const statusBySkill = new Map(
    postReconcileStatus.statuses
      .filter((item) => item.assignment === targetAssignment)
      .map((item) => [item.skill, item])
  );
  for (const candidate of plan.candidates) {
    const statusItem = statusBySkill.get(candidate.skill);
    if (statusItem?.status === "current") {
      continue;
    }
    errors.push(reconcileError({
      code: "post_status_not_current",
      message: statusItem === undefined
        ? `Could not verify post-reconcile status for ${candidate.skill}.`
        : `Skill ${candidate.skill} is ${statusItem.status} after reconcile: ${statusItem.reason}`,
      skill: candidate.skill,
      path: candidate.targetPath
    }));
  }
  return errors;
}

function buildBaseResult({
  ok,
  source,
  target,
  assignment,
  installRoot,
  selected,
  candidates,
  planned,
  blocked,
  errors
}: {
  ok: boolean;
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  selected: string[];
  candidates: ReconcileCandidate[];
  planned: number;
  blocked: number;
  errors: ReconcileError[];
}): ReconcileBaseResult {
  const changes = candidates.reduce<ReconcileChanges>(
    (summary, candidate) => ({
      create: summary.create + candidate.changes.create,
      update: summary.update + candidate.changes.update,
      extra: summary.extra + candidate.changes.extra,
      missing: summary.missing + candidate.changes.missing,
      unchanged: summary.unchanged + candidate.changes.unchanged
    }),
    emptyChanges()
  );
  return {
    ok,
    dryRun: true,
    readOnly: true,
    source,
    target,
    assignment,
    installRoot,
    selected: {
      skills: selected
    },
    candidates,
    refused: {
      skills: refusedSkillsFromErrors(errors)
    },
    summary: {
      planned,
      candidates: candidates.length,
      refused: errors.length,
      blocked,
      create: changes.create,
      update: changes.update,
      extra: changes.extra,
      missing: changes.missing,
      unchanged: changes.unchanged
    },
    errors
  };
}

function planFailure({
  source,
  target,
  assignment,
  installRoot,
  selected,
  errors
}: {
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  selected: string[];
  errors: ReconcileError[];
}): ReconcilePlanResult {
  return {
    ...buildBaseResult({
      ok: false,
      source,
      target,
      assignment,
      installRoot,
      selected,
      candidates: [],
      planned: 0,
      blocked: 0,
      errors
    }),
    dryRun: true,
    readOnly: true,
    reconciled: {
      skills: [],
      files: 0,
      backups: []
    },
    receiptPath: null,
    postReconcileStatus: null
  };
}

function applyFailure(plan: ReconcileBaseResult, code: string, message: string): ReconcileApplyResult {
  return {
    ...plan,
    ok: false,
    dryRun: false,
    readOnly: false,
    errors: [
      ...plan.errors,
      reconcileError({ code, message })
    ],
    reconciled: {
      skills: [],
      files: 0,
      backups: []
    },
    receiptPath: null,
    postReconcileStatus: null
  };
}

function normalizeSelectedSkills(skills: string[] | undefined): string[] {
  if (skills === undefined) {
    return [];
  }
  return [...new Set(skills.map((skill) => skill.trim()).filter((skill) => skill.length > 0))].sort();
}

function hasBlankSkillFilter(skills: string[]): boolean {
  return skills.some((skill) => skill.trim().length === 0);
}

function groupEntriesBySkill(
  entries: ReconcileDiffEntry[],
  selectedSkillSet: ReadonlySet<string>
): Map<string, ReconcileDiffEntry[]> {
  const result = new Map<string, ReconcileDiffEntry[]>();
  for (const entry of entries) {
    if (!selectedSkillSet.has(entry.skill)) {
      continue;
    }
    const normalized = normalizeEntry(entry);
    const bucket = result.get(entry.skill);
    if (bucket === undefined) {
      result.set(entry.skill, [normalized]);
      continue;
    }
    bucket.push(normalized);
  }
  return result;
}

function normalizeEntry(entry: ReconcileDiffEntry): ReconcileDiffEntry {
  const result: ReconcileDiffEntry = {
    action: entry.action,
    skill: entry.skill,
    relativePath: entry.relativePath,
    sourcePath: entry.sourcePath,
    targetPath: entry.targetPath
  };
  if (entry.reason !== undefined) {
    result.reason = entry.reason;
  }
  return result;
}

function summarizeEntries(entries: ReconcileDiffEntry[]): ReconcileChanges {
  const summary = emptyChanges();
  for (const entry of entries) {
    if (entry.action === "create") summary.create += 1;
    if (entry.action === "update") summary.update += 1;
    if (entry.action === "extra") summary.extra += 1;
    if (entry.action === "missing") summary.missing += 1;
    if (entry.action === "unchanged") summary.unchanged += 1;
  }
  return summary;
}

function emptyChanges(): ReconcileChanges {
  return {
    create: 0,
    update: 0,
    extra: 0,
    missing: 0,
    unchanged: 0
  };
}

function countSelectedPlanned(
  planned: DiffForReconcile["planned"],
  selectedSkillSet: ReadonlySet<string>
): number {
  return planned.filter((entry) => selectedSkillSet.has(entry.skill)).length;
}

function countSelectedBlocked(
  blocked: DiffForReconcile["blocked"],
  selectedSkillSet: ReadonlySet<string>
): number {
  return blocked.filter((entry) => selectedSkillSet.has(entry.skill)).length;
}

function refusedSkillsFromErrors(errors: ReconcileError[]): string[] {
  return [...new Set(
    errors
      .map((error) => error.skill)
      .filter((skill): skill is string => typeof skill === "string")
  )].sort();
}

function backupPathTemplate(installRoot: string, skill: string): string {
  return path.join(installRoot, `.${skill}.suitcase-pre-reconcile-<timestamp>`);
}

type DirectoryTreeValidationResult =
  | { ok: true }
  | { ok: false; error: ReconcileError };

async function validateDirectoryTree(
  rootPath: string,
  codes: {
    symlinkCode: string;
    unreadableCode: string;
    missingCode: string;
    label: string;
    rejectEmptyDirectories?: boolean;
  }
): Promise<DirectoryTreeValidationResult> {
  let info: Stats;
  try {
    info = await lstat(rootPath);
  } catch (error) {
    return {
      ok: false,
      error: reconcileError({
        code: isNodeError(error) && error.code === "ENOENT" ? codes.missingCode : codes.unreadableCode,
        message: `${codes.label} directory ${rootPath} could not be read: ${errorMessage(error)}`,
        path: rootPath
      })
    };
  }

  if (info.isSymbolicLink()) {
    return {
      ok: false,
      error: reconcileError({
        code: codes.symlinkCode,
        message: `${codes.label} directory ${rootPath} is a symlink and cannot be reconciled safely.`,
        path: rootPath
      })
    };
  }

  if (!info.isDirectory()) {
    return {
      ok: false,
      error: reconcileError({
        code: codes.unreadableCode,
        message: `${codes.label} path ${rootPath} is not a directory.`,
        path: rootPath
      })
    };
  }

  return validateDirectoryEntries(rootPath, rootPath, codes);
}

async function validateDirectoryEntries(
  rootPath: string,
  currentPath: string,
  codes: {
    symlinkCode: string;
    unreadableCode: string;
    missingCode: string;
    label: string;
    rejectEmptyDirectories?: boolean;
  }
): Promise<DirectoryTreeValidationResult> {
  let entries: Dirent[];
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    return {
      ok: false,
      error: reconcileError({
        code: codes.unreadableCode,
        message: `${codes.label} directory ${rootPath} could not be scanned: ${errorMessage(error)}`,
        path: currentPath
      })
    };
  }

  if (codes.rejectEmptyDirectories === true && currentPath !== rootPath && entries.length === 0) {
    return {
      ok: false,
      error: reconcileError({
        code: codes.symlinkCode,
        message: `${codes.label} tree ${rootPath} contains an empty directory at ${currentPath} and cannot be rollback-recorded safely.`,
        path: currentPath
      })
    };
  }

  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isSymbolicLink()) {
      return {
        ok: false,
        error: reconcileError({
          code: codes.symlinkCode,
          message: `${codes.label} tree ${rootPath} contains a symlink at ${entryPath} and cannot be reconciled safely.`,
          path: entryPath
        })
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
      error: reconcileError({
        code: codes.symlinkCode,
        message: `${codes.label} tree ${rootPath} contains an unsupported filesystem entry at ${entryPath} and cannot be reconciled safely.`,
        path: entryPath
      })
    };
  }
  return { ok: true };
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

async function buildRollbackFiles({
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
  const relativePaths = [...new Set([...previousFiles, ...appliedFiles])].sort();
  const records: RollbackFileRecord[] = [];
  for (const relativePath of replacedDirectories.sort(compareShallowestPathFirst)) {
    records.push({
      path: relativePath,
      targetPath: path.join(appliedTargetPath, relativePath),
      previous: { kind: "missing" }
    });
  }
  for (const relativePath of relativePaths) {
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

async function hashDirectory(root: string, sourcePolicy?: SourcePolicy | undefined): Promise<string> {
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

async function listFiles(
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

async function listDirectories(root: string): Promise<string[]> {
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

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function restoreOriginalReceipt({
  receiptPath,
  previousReceiptText
}: {
  receiptPath: string;
  previousReceiptText: string | null;
}): Promise<void> {
  try {
    if (previousReceiptText === null) {
      await unlink(receiptPath);
      return;
    }
    await writeFile(receiptPath, previousReceiptText, "utf8");
  } catch {
    // best effort restore only
  }
}

async function removePath(targetPath: string): Promise<void> {
  try {
    await rm(targetPath, { recursive: true, force: true });
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

function reconcileError({
  code,
  message,
  skill,
  path: errorPath
}: {
  code: string;
  message: string;
  skill?: string;
  path?: string;
}): ReconcileError {
  return {
    code,
    message,
    ...(skill !== undefined ? { skill } : {}),
    ...(errorPath !== undefined ? { path: errorPath } : {})
  };
}

function compareEntries(left: ReconcileDiffEntry, right: ReconcileDiffEntry): number {
  return `${left.skill}:${left.relativePath ?? ""}:${left.action}`.localeCompare(`${right.skill}:${right.relativePath ?? ""}:${right.action}`);
}

function compareBackups(left: ReconciledBackup, right: ReconciledBackup): number {
  return left.skill.localeCompare(right.skill);
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isPlainPathSegment(value: string): boolean {
  return value.length > 0 &&
    !value.includes("\0") &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\");
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
