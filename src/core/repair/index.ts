import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { TargetOverrides } from "../catalog/index.js";
import { diff } from "../diffing/index.js";
import { status } from "../status/index.js";

type RepairInput = {
  source: string;
  target: string;
  skills?: string[];
  dryRun?: boolean;
  targetOverrides?: TargetOverrides | undefined;
};

type RepairError = {
  code: string;
  message: string;
  skill?: string;
  path?: string;
};

type RepairDiffEntry = {
  action: "create" | "update" | "unchanged" | "extra" | "missing" | "blocked";
  skill: string;
  relativePath: string | null;
  sourcePath: string | null;
  targetPath: string | null;
  reason?: string;
};

type RepairChanges = {
  create: number;
  update: number;
  extra: number;
  missing: number;
  unchanged: number;
};

type RepairCandidate = {
  skill: string;
  sourcePath: string;
  targetPath: string;
  variant?: string;
  status: "dirty";
  reason: string;
  receiptHash: string | null;
  catalogHash: string | null;
  changes: RepairChanges;
  entries: RepairDiffEntry[];
  backup: {
    strategy: "rename-target-directory";
    backupPathTemplate: string;
  };
  finalAction: "replace-target-from-catalog";
};

type RepairBaseResult = {
  ok: boolean;
  dryRun: true;
  readOnly: true;
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  selected: {
    skills: string[];
  };
  candidates: RepairCandidate[];
  refused: {
    skills: string[];
  };
  summary: {
    planned: number;
    candidates: number;
    refused: number;
    blocked: number;
    dirty: number;
    create: number;
    update: number;
    extra: number;
    missing: number;
    unchanged: number;
  };
  errors: RepairError[];
};

export type RepairResult = RepairBaseResult & {
  repaired: {
    skills: string[];
    files: number;
    backups: never[];
  };
  receiptPath: null;
};

type DiffForRepair = {
  ok: boolean;
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  readOnly?: boolean;
  planned: Array<{ skill: string; sourcePath: string; variant?: string }>;
  blocked: Array<{ skill: string; reason?: string }>;
  entries: RepairDiffEntry[];
  errors: Array<{ code: string; message: string; skill?: string }>;
};

type StatusResult = Awaited<ReturnType<typeof status>>;
type StatusItem = StatusResult["statuses"][number];

export async function repair(input: RepairInput): Promise<RepairResult> {
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
      errors: [repairError({
        code: "invalid_skill_filter",
        message: "At least one non-blank skill filter is required for repair."
      })]
    });
  }

  if (input.dryRun !== true) {
    return planFailure({
      source: input.source,
      target: input.target,
      assignment: null,
      installRoot: null,
      selected: selectedSkills,
      errors: [repairError({
        code: "unsupported_repair_mode",
        message: "repair currently supports --dry-run only; apply lands in a follow-up slice."
      })]
    });
  }

  const plan = await planRepair(input, selectedSkills);
  return finalizePlan(plan);
}

async function planRepair(input: RepairInput, selectedSkills: string[]): Promise<RepairBaseResult> {
  const selectedSkillSet = new Set(selectedSkills);
  const diffInput: Parameters<typeof diff>[0] = {
    source: input.source,
    target: input.target,
    skills: selectedSkills
  };
  if (input.targetOverrides !== undefined) {
    diffInput.targetOverrides = input.targetOverrides;
  }
  const diffResult = await diff(diffInput) as DiffForRepair;
  const errors: RepairError[] = [];

  if (diffResult.readOnly === true) {
    errors.push(repairError({
      code: "read_only_target",
      message: `Target ${input.target} is modeled read-only and cannot be repaired.`
    }));
  }

  if (diffResult.installRoot === null) {
    errors.push(repairError({
      code: "missing_install_root",
      message: "could not resolve install root for repair"
    }));
  }

  for (const error of diffResult.errors) {
    if (error.skill !== undefined && !selectedSkillSet.has(error.skill)) {
      continue;
    }
    errors.push(repairError({
      code: `diff_${error.code}`,
      message: error.message,
      ...(error.skill !== undefined ? { skill: error.skill } : {})
    }));
  }

  for (const blocked of diffResult.blocked) {
    if (!selectedSkillSet.has(blocked.skill)) {
      continue;
    }
    errors.push(repairError({
      code: "blocked_skill",
      message: `Skill ${blocked.skill} is blocked for repair: ${blocked.reason ?? "blocked"}`,
      skill: blocked.skill
    }));
  }

  const plannedBySkill = new Map(diffResult.planned.map((planned) => [planned.skill, planned]));
  const entriesBySkill = groupEntriesBySkill(diffResult.entries, selectedSkillSet);

  for (const skill of selectedSkills) {
    if (!plannedBySkill.has(skill)) {
      errors.push(repairError({
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
      dirty: 0,
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
    errors.push(repairError({
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

  let dirtyCount = 0;
  const candidates: RepairCandidate[] = [];
  for (const skill of selectedSkills) {
    const planned = plannedBySkill.get(skill);
    if (planned === undefined) {
      continue;
    }

    if (!isPlainPathSegment(skill)) {
      errors.push(repairError({
        code: "unsafe_path",
        message: `Skill ${skill} is not a plain skill directory name and cannot be repaired.`,
        skill
      }));
      continue;
    }

    if (!isSameOrInsidePath(planned.sourcePath, diffResult.source)) {
      errors.push(repairError({
        code: "unsafe_path",
        message: `Source path for ${skill} resolves outside the catalog source root.`,
        skill,
        path: planned.sourcePath
      }));
      continue;
    }

    const statusItem = statusesBySkill.get(skill);
    if (statusItem === undefined) {
      errors.push(repairError({
        code: "unsupported_target_state",
        message: `Skill ${skill} has no status entry for target ${input.target}.`,
        skill
      }));
      continue;
    }

    if (!isSameOrInsidePath(statusItem.targetPath, diffResult.installRoot)) {
      errors.push(repairError({
        code: "unsafe_path",
        message: `Target path for ${skill} resolves outside the install root and cannot be repaired.`,
        skill,
        path: statusItem.targetPath
      }));
      continue;
    }

    if (statusItem.status === "dirty") {
      dirtyCount += 1;
    }

    const routingError = routeNonDirtyStatus(skill, statusItem);
    if (routingError !== null) {
      errors.push(routingError);
      continue;
    }

    const skillEntries = entriesBySkill.get(skill) ?? [];
    const changes = summarizeEntries(skillEntries);
    if (changes.missing > 0 || skillEntries.some((entry) => entry.action === "missing")) {
      errors.push(repairError({
        code: "missing_source",
        message: `Skill ${skill} has missing catalog source entries and cannot be repaired.`,
        skill,
        path: planned.sourcePath
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
      errors.push({ ...sourceValidation.error, skill });
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
      errors.push({ ...targetValidation.error, skill });
      continue;
    }

    const candidate: RepairCandidate = {
      skill,
      sourcePath: planned.sourcePath,
      targetPath: statusItem.targetPath,
      status: "dirty",
      reason: statusItem.reason,
      receiptHash: statusItem.installedHash,
      catalogHash: statusItem.currentHash,
      changes,
      entries: skillEntries.sort(compareEntries),
      backup: {
        strategy: "rename-target-directory",
        backupPathTemplate: backupPathTemplate(path.dirname(statusItem.targetPath), skill)
      },
      finalAction: "replace-target-from-catalog"
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
    dirty: dirtyCount,
    errors
  });
}

/**
 * Repair only owns receipt-backed `dirty` targets. Every other state is routed
 * to the command that owns it so machine-by-machine sync stays deterministic.
 */
function routeNonDirtyStatus(skill: string, statusItem: StatusItem): RepairError | null {
  switch (statusItem.status) {
    case "dirty":
      return null;
    case "current":
      return repairError({
        code: "already_current",
        message: `Skill ${skill} is already current; repair is a no-op.`,
        skill,
        path: statusItem.targetPath
      });
    case "unknown":
      return repairError({
        code: "route_to_track_or_reconcile",
        message: `Skill ${skill} is unknown (${statusItem.reason}); use track or reconcile, not repair.`,
        skill,
        path: statusItem.targetPath
      });
    case "missing":
      return repairError({
        code: "route_to_pack_apply",
        message: `Skill ${skill} is missing; use pack + apply to install it, not repair.`,
        skill,
        path: statusItem.targetPath
      });
    case "behind":
    case "version":
      return repairError({
        code: "route_to_pack_apply",
        message: `Skill ${skill} is ${statusItem.status} (${statusItem.reason}); use pack + apply to update it, not repair.`,
        skill,
        path: statusItem.targetPath
      });
    case "blocked":
      return repairError({
        code: "blocked_skill",
        message: `Skill ${skill} is blocked for repair: ${statusItem.reason}`,
        skill,
        path: statusItem.targetPath
      });
    default:
      return repairError({
        code: "unsupported_target_state",
        message: `Skill ${skill} is ${statusItem.status}: ${statusItem.reason}`,
        skill,
        path: statusItem.targetPath
      });
  }
}

function finalizePlan(plan: RepairBaseResult): RepairResult {
  return {
    ...plan,
    repaired: {
      skills: [],
      files: 0,
      backups: []
    },
    receiptPath: null
  };
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
  dirty,
  errors
}: {
  ok: boolean;
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  selected: string[];
  candidates: RepairCandidate[];
  planned: number;
  blocked: number;
  dirty: number;
  errors: RepairError[];
}): RepairBaseResult {
  const changes = candidates.reduce<RepairChanges>(
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
      dirty,
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
  errors: RepairError[];
}): RepairResult {
  return finalizePlan(buildBaseResult({
    ok: false,
    source,
    target,
    assignment,
    installRoot,
    selected,
    candidates: [],
    planned: 0,
    blocked: 0,
    dirty: 0,
    errors
  }));
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
  entries: RepairDiffEntry[],
  selectedSkillSet: ReadonlySet<string>
): Map<string, RepairDiffEntry[]> {
  const result = new Map<string, RepairDiffEntry[]>();
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

function normalizeEntry(entry: RepairDiffEntry): RepairDiffEntry {
  const result: RepairDiffEntry = {
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

function summarizeEntries(entries: RepairDiffEntry[]): RepairChanges {
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

function emptyChanges(): RepairChanges {
  return {
    create: 0,
    update: 0,
    extra: 0,
    missing: 0,
    unchanged: 0
  };
}

function countSelectedPlanned(
  planned: DiffForRepair["planned"],
  selectedSkillSet: ReadonlySet<string>
): number {
  return planned.filter((entry) => selectedSkillSet.has(entry.skill)).length;
}

function countSelectedBlocked(
  blocked: DiffForRepair["blocked"],
  selectedSkillSet: ReadonlySet<string>
): number {
  return blocked.filter((entry) => selectedSkillSet.has(entry.skill)).length;
}

function refusedSkillsFromErrors(errors: RepairError[]): string[] {
  return [...new Set(
    errors
      .map((error) => error.skill)
      .filter((skill): skill is string => typeof skill === "string")
  )].sort();
}

function backupPathTemplate(installRoot: string, skill: string): string {
  return path.join(installRoot, `.${skill}.suitcase-pre-repair-<timestamp>`);
}

type DirectoryTreeValidationResult =
  | { ok: true }
  | { ok: false; error: RepairError };

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
      error: repairError({
        code: isNodeError(error) && error.code === "ENOENT" ? codes.missingCode : codes.unreadableCode,
        message: `${codes.label} directory ${rootPath} could not be read: ${errorMessage(error)}`,
        path: rootPath
      })
    };
  }

  if (info.isSymbolicLink()) {
    return {
      ok: false,
      error: repairError({
        code: codes.symlinkCode,
        message: `${codes.label} directory ${rootPath} is a symlink and cannot be repaired safely.`,
        path: rootPath
      })
    };
  }

  if (!info.isDirectory()) {
    return {
      ok: false,
      error: repairError({
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
      error: repairError({
        code: codes.unreadableCode,
        message: `${codes.label} directory ${rootPath} could not be scanned: ${errorMessage(error)}`,
        path: currentPath
      })
    };
  }

  if (codes.rejectEmptyDirectories === true && currentPath !== rootPath && entries.length === 0) {
    return {
      ok: false,
      error: repairError({
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
        error: repairError({
          code: codes.symlinkCode,
          message: `${codes.label} tree ${rootPath} contains a symlink at ${entryPath} and cannot be repaired safely.`,
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
      error: repairError({
        code: codes.symlinkCode,
        message: `${codes.label} tree ${rootPath} contains an unsupported filesystem entry at ${entryPath} and cannot be repaired safely.`,
        path: entryPath
      })
    };
  }
  return { ok: true };
}

function repairError({
  code,
  message,
  skill,
  path: errorPath
}: {
  code: string;
  message: string;
  skill?: string;
  path?: string;
}): RepairError {
  return {
    code,
    message,
    ...(skill !== undefined ? { skill } : {}),
    ...(errorPath !== undefined ? { path: errorPath } : {})
  };
}

function compareEntries(left: RepairDiffEntry, right: RepairDiffEntry): number {
  return `${left.skill}:${left.relativePath ?? ""}:${left.action}`.localeCompare(`${right.skill}:${right.relativePath ?? ""}:${right.action}`);
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
