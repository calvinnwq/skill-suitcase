import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TargetOverrides } from "../catalog/index.js";
import { diff } from "../diffing/index.js";
import {
  readReceipt,
  type Receipt,
  type ReceiptInstallRecord
} from "../receipts/index.js";
import { SYMLINK_MODE } from "../install-modes.js";
import { status } from "../status/index.js";

export type ImportTargetInput = {
  source: string;
  target: string;
  skills?: string[];
  dryRun?: boolean;
  apply?: boolean;
  targetOverrides?: TargetOverrides | undefined;
};

export type ImportTargetError = {
  code: string;
  message: string;
  skill?: string;
  path?: string;
};

export type ImportRepoWriteAction = "create" | "update" | "delete";

export type ImportRepoWrite = {
  action: ImportRepoWriteAction;
  skill: string;
  relativePath: string | null;
  catalogPath: string | null;
  targetPath: string | null;
  catalogSha256?: string | null;
  targetSha256?: string | null;
  bytes?: number | null;
};

export type ImportTargetChanges = {
  create: number;
  update: number;
  delete: number;
  unchanged: number;
};

export type ImportTargetCandidate = {
  skill: string;
  targetId: string;
  installRoot: string;
  targetSkillPath: string;
  catalogSkillPath: string;
  status: "dirty";
  reason: string;
  receiptState: "receipt-owned";
  receiptHash: string | null;
  catalogHash: string | null;
  targetHash: string | null;
  variant?: string;
  changes: ImportTargetChanges;
  repoWrites: ImportRepoWrite[];
  finalAction: "replace-catalog-from-target";
};

type ImportTargetBaseResult = {
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
  candidates: ImportTargetCandidate[];
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
    delete: number;
    unchanged: number;
  };
  errors: ImportTargetError[];
};

export type ImportTargetPlanResult = ImportTargetBaseResult & {
  dryRun: true;
  readOnly: true;
  imported: {
    skills: [];
    files: 0;
  };
  receiptPath: null;
};

export type ImportTargetResult = ImportTargetPlanResult;

type DiffEntry = {
  action: "create" | "update" | "unchanged" | "extra" | "missing" | "blocked";
  skill: string;
  relativePath: string | null;
  sourcePath: string | null;
  targetPath: string | null;
  sourceSha256?: string | null;
  targetSha256?: string | null;
  bytes?: number | null;
};

type DiffForImport = {
  ok: boolean;
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  readOnly?: boolean;
  planned: Array<{ skill: string; sourcePath: string; variant?: string }>;
  blocked: Array<{ skill: string; reason?: string }>;
  entries: DiffEntry[];
  errors: Array<{ code: string; message: string; skill?: string }>;
};

type StatusResult = Awaited<ReturnType<typeof status>>;
type StatusItem = StatusResult["statuses"][number];

/**
 * Import an intentionally-edited local target skill back into the catalog.
 *
 * This is the source-of-truth counterpart to `repair`: both own receipt-backed
 * `dirty` targets, but `repair` discards the live edits by restoring the catalog
 * copy, while `import-target` promotes the live edits into the catalog so they
 * can be reviewed as ordinary git changes. Every other target state is routed to
 * the command that owns it (`promote`, `pack`/`apply`, or a no-op) so the
 * source-of-truth loop stays deterministic.
 *
 * The first slice ships the read-only `--dry-run` plan; `--apply` lands in a
 * follow-up slice.
 */
export async function importTarget(input: ImportTargetInput): Promise<ImportTargetResult> {
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
      selected: selectedSkills,
      errors: [importError({
        code: "invalid_skill_filter",
        message: "At least one non-blank skill filter is required for import-target; there is no all-skills import."
      })]
    });
  }

  const wantsDryRun = input.dryRun === true;
  const wantsApply = input.apply === true;
  if (wantsDryRun === wantsApply) {
    return planFailure({
      source: input.source,
      target: input.target,
      selected: selectedSkills,
      errors: [importError({
        code: "invalid_import_mode",
        message: "import-target requires exactly one of dryRun or apply."
      })]
    });
  }

  if (!wantsDryRun) {
    return planFailure({
      source: input.source,
      target: input.target,
      selected: selectedSkills,
      errors: [importError({
        code: "unsupported_import_mode",
        message: "import-target currently supports --dry-run only; apply lands in a follow-up slice."
      })]
    });
  }

  const plan = await planImport(input, selectedSkills);
  return finalizePlan(plan);
}

async function planImport(input: ImportTargetInput, selectedSkills: string[]): Promise<ImportTargetBaseResult> {
  const selectedSkillSet = new Set(selectedSkills);
  const diffInput: Parameters<typeof diff>[0] = {
    source: input.source,
    target: input.target,
    skills: selectedSkills
  };
  if (input.targetOverrides !== undefined) {
    diffInput.targetOverrides = input.targetOverrides;
  }
  const diffResult = await diff(diffInput) as DiffForImport;
  const errors: ImportTargetError[] = [];

  if (diffResult.readOnly === true) {
    errors.push(importError({
      code: "read_only_target",
      message: `Target ${input.target} is modeled read-only and cannot be imported from.`
    }));
  }

  if (diffResult.installRoot === null) {
    errors.push(importError({
      code: "missing_install_root",
      message: "could not resolve install root for import-target"
    }));
  }

  for (const error of diffResult.errors) {
    if (error.skill !== undefined && !selectedSkillSet.has(error.skill)) {
      continue;
    }
    errors.push(importError({
      code: `diff_${error.code}`,
      message: error.message,
      ...(error.skill !== undefined ? { skill: error.skill } : {})
    }));
  }

  for (const blocked of diffResult.blocked) {
    if (!selectedSkillSet.has(blocked.skill)) {
      continue;
    }
    errors.push(importError({
      code: "blocked_skill",
      message: `Skill ${blocked.skill} is blocked for import-target: ${blocked.reason ?? "blocked"}`,
      skill: blocked.skill
    }));
  }

  const plannedBySkill = new Map(diffResult.planned.map((planned) => [planned.skill, planned]));
  const entriesBySkill = groupEntriesBySkill(diffResult.entries, selectedSkillSet);

  for (const skill of selectedSkills) {
    if (!plannedBySkill.has(skill)) {
      errors.push(importError({
        code: "skill_not_planned",
        message: `Skill ${skill} is not planned for target ${diffResult.assignment ?? diffResult.target}.`,
        skill
      }));
    }
  }

  if (diffResult.readOnly === true || diffResult.installRoot === null) {
    return buildBaseResult({
      source: diffResult.source,
      target: input.target,
      assignment: diffResult.assignment,
      installRoot: diffResult.installRoot,
      selected: selectedSkills,
      candidates: [],
      planned: countSelected(diffResult.planned, selectedSkillSet),
      blocked: countSelected(diffResult.blocked, selectedSkillSet),
      dirty: 0,
      errors
    });
  }
  const installRoot = diffResult.installRoot;

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
    errors.push(importError({
      code: `status_${statusError.code}`,
      message: statusError.message,
      ...(statusError.skill !== undefined ? { skill: statusError.skill } : {}),
      ...(statusError.path !== undefined ? { path: statusError.path } : {})
    }));
  }

  let receipt: Receipt | null = null;
  try {
    receipt = await readReceipt({ installRoot });
  } catch (error) {
    errors.push(importError({
      code: "invalid_receipt",
      message: `Could not read receipt before import-target planning: ${errorMessage(error)}`
    }));
  }

  const assignmentName = diffResult.assignment ?? input.target;
  const statusesBySkill = new Map(
    statusResult.statuses
      .filter((item) => item.assignment === assignmentName && selectedSkillSet.has(item.skill))
      .map((item) => [item.skill, item])
  );

  let dirtyCount = 0;
  const candidates: ImportTargetCandidate[] = [];
  for (const skill of selectedSkills) {
    const planned = plannedBySkill.get(skill);
    if (planned === undefined) {
      continue;
    }

    if (!isPlainPathSegment(skill)) {
      errors.push(importError({
        code: "unsafe_path",
        message: `Skill ${skill} is not a plain skill directory name and cannot be imported.`,
        skill
      }));
      continue;
    }

    if (!isSameOrInsidePath(planned.sourcePath, diffResult.source)) {
      errors.push(importError({
        code: "unsafe_path",
        message: `Catalog path for ${skill} resolves outside the catalog source root.`,
        skill,
        path: planned.sourcePath
      }));
      continue;
    }

    const statusItem = statusesBySkill.get(skill);
    if (statusItem === undefined) {
      errors.push(importError({
        code: "unsupported_target_state",
        message: `Skill ${skill} has no status entry for target ${input.target}.`,
        skill
      }));
      continue;
    }

    if (!isSameOrInsidePath(statusItem.targetPath, installRoot)) {
      errors.push(importError({
        code: "unsafe_path",
        message: `Target path for ${skill} resolves outside the install root and cannot be imported.`,
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

    if (receiptInstallMode({
      receipt,
      skill,
      installRoot,
      targetPath: statusItem.targetPath
    }) === SYMLINK_MODE) {
      errors.push(importError({
        code: "unsupported_install_mode",
        message: `Skill ${skill} is a symlink-mode install; the target already resolves to the catalog, so there is nothing to import.`,
        skill,
        path: statusItem.targetPath
      }));
      continue;
    }

    if (
      statusItem.installedHash !== null
      && statusItem.currentHash !== null
      && statusItem.installedHash !== statusItem.currentHash
    ) {
      errors.push(importError({
        code: "catalog_diverged",
        message: `Skill ${skill} is dirty but the catalog has also moved since it was tracked (${statusItem.reason}); reconcile the catalog (pack + apply, then repair) before importing local edits.`,
        skill,
        path: statusItem.targetPath
      }));
      continue;
    }

    const skillEntries = entriesBySkill.get(skill) ?? [];
    const unsupportedEntry = skillEntries.find((entry) => entry.action === "missing" || entry.action === "blocked");
    if (unsupportedEntry !== undefined) {
      errors.push(importError({
        code: "catalog_unreadable",
        message: `Skill ${skill} has catalog entries that could not be compared and cannot be imported safely.`,
        skill,
        path: unsupportedEntry.sourcePath ?? planned.sourcePath
      }));
      continue;
    }

    const targetValidation = await validateDirectoryTree(statusItem.targetPath, {
      symlinkCode: "unsafe_target_tree",
      unreadableCode: "target_unreadable",
      missingCode: "unsupported_target_state",
      label: "Target"
    });
    if (!targetValidation.ok) {
      errors.push({ ...targetValidation.error, skill });
      continue;
    }

    const catalogValidation = await validateDirectoryTree(planned.sourcePath, {
      symlinkCode: "unsafe_catalog_tree",
      unreadableCode: "catalog_unreadable",
      missingCode: "missing_catalog",
      label: "Catalog"
    });
    if (!catalogValidation.ok) {
      errors.push({ ...catalogValidation.error, skill });
      continue;
    }

    const repoWrites = repoWritesFromEntries(skill, skillEntries, planned.sourcePath);
    const changes = summarizeWrites(repoWrites, skillEntries);
    const targetHash = await hashDirectory(statusItem.targetPath).catch(() => null);
    const catalogHash = await hashDirectory(planned.sourcePath).catch(() => statusItem.currentHash);

    const candidate: ImportTargetCandidate = {
      skill,
      targetId: assignmentName,
      installRoot,
      targetSkillPath: statusItem.targetPath,
      catalogSkillPath: planned.sourcePath,
      status: "dirty",
      reason: statusItem.reason,
      receiptState: "receipt-owned",
      receiptHash: statusItem.installedHash,
      catalogHash,
      targetHash,
      changes,
      repoWrites,
      finalAction: "replace-catalog-from-target"
    };
    if (planned.variant !== undefined) {
      candidate.variant = planned.variant;
    }
    candidates.push(candidate);
  }

  return buildBaseResult({
    source: diffResult.source,
    target: input.target,
    assignment: diffResult.assignment,
    installRoot,
    selected: selectedSkills,
    candidates,
    planned: countSelected(diffResult.planned, selectedSkillSet),
    blocked: countSelected(diffResult.blocked, selectedSkillSet),
    dirty: dirtyCount,
    errors
  });
}

/**
 * import-target only owns receipt-backed `dirty` targets. Every other state is
 * routed to the command that owns it so the source-of-truth loop is
 * deterministic.
 */
function routeNonDirtyStatus(skill: string, statusItem: StatusItem): ImportTargetError | null {
  switch (statusItem.status) {
    case "dirty":
      return null;
    case "current":
      return importError({
        code: "already_current",
        message: `Skill ${skill} already matches the catalog; import-target is a no-op.`,
        skill,
        path: statusItem.targetPath
      });
    case "unknown":
      return importError({
        code: "route_to_promote",
        message: `Skill ${skill} is unknown (${statusItem.reason}); use promote to add a target-created skill, not import-target.`,
        skill,
        path: statusItem.targetPath
      });
    case "missing":
      return importError({
        code: "route_to_pack_apply",
        message: `Skill ${skill} is missing; use pack + apply to install it, not import-target.`,
        skill,
        path: statusItem.targetPath
      });
    case "behind":
    case "version":
      return importError({
        code: "route_to_pack_apply",
        message: `Skill ${skill} is ${statusItem.status} (${statusItem.reason}); the catalog is ahead, so use pack + apply, not import-target.`,
        skill,
        path: statusItem.targetPath
      });
    case "blocked":
      return importError({
        code: "blocked_skill",
        message: `Skill ${skill} is blocked for import-target: ${statusItem.reason}`,
        skill,
        path: statusItem.targetPath
      });
    default:
      return importError({
        code: "unsupported_target_state",
        message: `Skill ${skill} is ${statusItem.status}: ${statusItem.reason}`,
        skill,
        path: statusItem.targetPath
      });
  }
}

/**
 * Translate the catalog-vs-target diff into the catalog-side writes an import
 * would make: an `update` rewrites the catalog file with the target version, an
 * `extra` (present only in the target) creates a catalog file, and a `create`
 * (present only in the catalog) deletes the catalog file the target dropped.
 */
function repoWritesFromEntries(skill: string, entries: DiffEntry[], catalogSkillPath: string): ImportRepoWrite[] {
  const writes: ImportRepoWrite[] = [];
  for (const entry of entries) {
    if (entry.relativePath === null) {
      continue;
    }
    const catalogPath = entry.sourcePath ?? path.join(catalogSkillPath, entry.relativePath);
    if (entry.action === "update") {
      writes.push({
        action: "update",
        skill,
        relativePath: entry.relativePath,
        catalogPath,
        targetPath: entry.targetPath,
        catalogSha256: entry.sourceSha256 ?? null,
        targetSha256: entry.targetSha256 ?? null,
        bytes: entry.bytes ?? null
      });
      continue;
    }
    if (entry.action === "extra") {
      writes.push({
        action: "create",
        skill,
        relativePath: entry.relativePath,
        catalogPath,
        targetPath: entry.targetPath,
        catalogSha256: null,
        targetSha256: entry.targetSha256 ?? null,
        bytes: entry.bytes ?? null
      });
      continue;
    }
    if (entry.action === "create") {
      writes.push({
        action: "delete",
        skill,
        relativePath: entry.relativePath,
        catalogPath,
        targetPath: null,
        catalogSha256: entry.sourceSha256 ?? null,
        targetSha256: null,
        bytes: entry.bytes ?? null
      });
    }
  }
  return writes.sort(compareWrites);
}

function summarizeWrites(writes: ImportRepoWrite[], entries: DiffEntry[]): ImportTargetChanges {
  const changes: ImportTargetChanges = { create: 0, update: 0, delete: 0, unchanged: 0 };
  for (const write of writes) {
    changes[write.action] += 1;
  }
  for (const entry of entries) {
    if (entry.action === "unchanged") {
      changes.unchanged += 1;
    }
  }
  return changes;
}

function receiptInstallMode({
  receipt,
  skill,
  installRoot,
  targetPath
}: {
  receipt: Receipt | null;
  skill: string;
  installRoot: string;
  targetPath: string;
}): string | null {
  const records = receiptRecordsForSkill(receipt, skill);
  if (records.length === 0) {
    return null;
  }
  const normalizedTargetPath = normalizeReceiptTargetPath({ installRoot, targetPath });
  const matched = records.find((record) => {
    return normalizeReceiptTargetPath({ installRoot, targetPath: record.targetPath }) === normalizedTargetPath;
  });
  const record = matched ?? records[0];
  if (record === undefined) {
    return null;
  }
  return typeof record.mode === "string" ? record.mode : null;
}

function receiptRecordsForSkill(receipt: Receipt | null, skill: string): ReceiptInstallRecord[] {
  const installs = receipt?.installs;
  if (installs === undefined) {
    return [];
  }
  const entry = installs[skill];
  if (entry === undefined) {
    return [];
  }
  return (Array.isArray(entry) ? entry : [entry]).filter(isReceiptInstallRecord);
}

function normalizeReceiptTargetPath({
  installRoot,
  targetPath
}: {
  installRoot: string;
  targetPath: unknown;
}): string | null {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    return null;
  }
  return path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(installRoot, targetPath);
}

function isReceiptInstallRecord(value: unknown): value is ReceiptInstallRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finalizePlan(plan: ImportTargetBaseResult): ImportTargetPlanResult {
  return {
    ...plan,
    dryRun: true,
    readOnly: true,
    imported: {
      skills: [],
      files: 0
    },
    receiptPath: null
  };
}

function buildBaseResult({
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
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  selected: string[];
  candidates: ImportTargetCandidate[];
  planned: number;
  blocked: number;
  dirty: number;
  errors: ImportTargetError[];
}): ImportTargetBaseResult {
  const changes = candidates.reduce<ImportTargetChanges>(
    (summary, candidate) => ({
      create: summary.create + candidate.changes.create,
      update: summary.update + candidate.changes.update,
      delete: summary.delete + candidate.changes.delete,
      unchanged: summary.unchanged + candidate.changes.unchanged
    }),
    { create: 0, update: 0, delete: 0, unchanged: 0 }
  );
  return {
    ok: errors.length === 0 && candidates.length === selected.length,
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
      delete: changes.delete,
      unchanged: changes.unchanged
    },
    errors
  };
}

function planFailure({
  source,
  target,
  selected,
  errors
}: {
  source: string;
  target: string;
  selected: string[];
  errors: ImportTargetError[];
}): ImportTargetResult {
  return finalizePlan(buildBaseResult({
    source,
    target,
    assignment: null,
    installRoot: null,
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
  entries: DiffEntry[],
  selectedSkillSet: ReadonlySet<string>
): Map<string, DiffEntry[]> {
  const result = new Map<string, DiffEntry[]>();
  for (const entry of entries) {
    if (!selectedSkillSet.has(entry.skill)) {
      continue;
    }
    const bucket = result.get(entry.skill);
    if (bucket === undefined) {
      result.set(entry.skill, [entry]);
      continue;
    }
    bucket.push(entry);
  }
  return result;
}

function countSelected(
  items: Array<{ skill: string }>,
  selectedSkillSet: ReadonlySet<string>
): number {
  return items.filter((entry) => selectedSkillSet.has(entry.skill)).length;
}

function refusedSkillsFromErrors(errors: ImportTargetError[]): string[] {
  return [...new Set(
    errors
      .map((error) => error.skill)
      .filter((skill): skill is string => typeof skill === "string")
  )].sort();
}

type DirectoryTreeValidationResult =
  | { ok: true }
  | { ok: false; error: ImportTargetError };

async function validateDirectoryTree(
  rootPath: string,
  codes: {
    symlinkCode: string;
    unreadableCode: string;
    missingCode: string;
    label: string;
  }
): Promise<DirectoryTreeValidationResult> {
  let info: Stats;
  try {
    info = await lstat(rootPath);
  } catch (error) {
    return {
      ok: false,
      error: importError({
        code: isNodeError(error) && error.code === "ENOENT" ? codes.missingCode : codes.unreadableCode,
        message: `${codes.label} directory ${rootPath} could not be read: ${errorMessage(error)}`,
        path: rootPath
      })
    };
  }

  if (info.isSymbolicLink()) {
    return {
      ok: false,
      error: importError({
        code: codes.symlinkCode,
        message: `${codes.label} directory ${rootPath} is a symlink and cannot be imported safely.`,
        path: rootPath
      })
    };
  }

  if (!info.isDirectory()) {
    return {
      ok: false,
      error: importError({
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
  }
): Promise<DirectoryTreeValidationResult> {
  let entries: Dirent[];
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    return {
      ok: false,
      error: importError({
        code: codes.unreadableCode,
        message: `${codes.label} directory ${rootPath} could not be scanned: ${errorMessage(error)}`,
        path: currentPath
      })
    };
  }

  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isSymbolicLink()) {
      return {
        ok: false,
        error: importError({
          code: codes.symlinkCode,
          message: `${codes.label} tree ${rootPath} contains a symlink at ${entryPath} and cannot be imported safely.`,
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
      error: importError({
        code: codes.symlinkCode,
        message: `${codes.label} tree ${rootPath} contains an unsupported filesystem entry at ${entryPath} and cannot be imported safely.`,
        path: entryPath
      })
    };
  }
  return { ok: true };
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

function compareWrites(left: ImportRepoWrite, right: ImportRepoWrite): number {
  return `${left.relativePath ?? ""}:${left.action}`.localeCompare(`${right.relativePath ?? ""}:${right.action}`);
}

function importError({
  code,
  message,
  skill,
  path: errorPath
}: {
  code: string;
  message: string;
  skill?: string;
  path?: string;
}): ImportTargetError {
  return {
    code,
    message,
    ...(skill !== undefined ? { skill } : {}),
    ...(errorPath !== undefined ? { path: errorPath } : {})
  };
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
