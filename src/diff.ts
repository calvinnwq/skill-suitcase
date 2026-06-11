import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadCatalog } from "./catalog.js";
import { type PlanResult, plan } from "./planner.js";
import type { Catalog } from "./catalog.js";

type DiffSourceFileRead =
  | {
      ok: true;
      bytes: number;
      sha256: string;
    }
  | {
      ok: false;
      code: string;
      bytes: null;
      sha256: null;
    };

type DiffResultError = {
  code: string;
  message: string;
  candidates?: string[];
};

type DiffEntryAction =
  | "create"
  | "update"
  | "unchanged"
  | "extra"
  | "missing"
  | "blocked";

type DiffEntry = {
  action: DiffEntryAction;
  skill: string;
  relativePath: string | null;
  targetPath: string | null;
  sourcePath: string | null;
  sourceSha256: string | null;
  targetSha256: string | null;
  bytes: number | null;
  reason?: string | undefined;
  variant?: string | undefined;
};

type DiffSummary = {
  create: number;
  update: number;
  unchanged: number;
  extra: number;
  missing: number;
  blocked: number;
};

type DiffResult = {
  ok: boolean;
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  planned: PlanItem[];
  blocked: PlanItem[];
  entries: DiffEntry[];
  summary: DiffSummary;
  errors: DiffResultError[];
};

type PlanItem = PlanResult["planned"][number];

type ResolveAssignmentInstallRootSuccess = {
  ok: true;
  errors: DiffResultError[];
  installRoot: string | null;
  assignment: string | null;
};

type ResolveAssignmentInstallRootFailure = {
  ok: false;
  errors: DiffResultError[];
  installRoot: string | null;
  assignment: string | null;
};

type ResolveAssignmentInstallRootResult =
  | ResolveAssignmentInstallRootSuccess
  | ResolveAssignmentInstallRootFailure;

const KIND_PATH_RULES = {
  "openclaw-skills-root": "path",
  "claude-skills-root": "path",
  "codex-home": "skillsPath",
  "nested-home-codex": "skillsPath"
} as const;

export async function diff(
  { source, target }: { source: string; target: string }
): Promise<DiffResult> {
  if (!source) {
    throw new Error("source is required");
  }
  if (!target) {
    throw new Error("target is required");
  }

  const { manifest } = await loadCatalog(source);
  const installation = await resolveAssignmentInstallRoot(manifest, target);
  const planTarget = installation.assignment ?? target;
  const planResult = await plan({ source, target: planTarget });
  const sourceRoot = planResult.source;

  const result: DiffResult = {
    ok: false,
    source: sourceRoot,
    target,
    assignment: planTarget,
    installRoot: null,
    planned: planResult.planned ?? [],
    blocked: planResult.blocked ?? [],
    entries: [],
    summary: {
      create: 0,
      update: 0,
      unchanged: 0,
      extra: 0,
      missing: 0,
      blocked: 0
    },
    errors: [...planResult.errors]
  };

  result.installRoot = installation.installRoot;
  if (!installation.ok) {
    result.errors.push(...installation.errors);
    for (const blockedEntry of result.blocked) {
      result.entries.push(blockedEntryFromPlan(blockedEntry));
    }
    result.summary = summarizeActions(result.entries);
    return result;
  }

  const installRoot = installation.installRoot;
  if (!installRoot) {
    throw new Error(`diff could not resolve install root for target ${target}.`);
  }
  result.installRoot = installRoot;

  for (const blockedEntry of result.blocked) {
    result.entries.push(blockedEntryFromPlan(blockedEntry));
  }

  const skippedExtraSkillNames = new Set<string>();

  for (const plannedSkill of result.planned) {
    const { entries: relativeEntries, errors: compareErrors } = await comparePlannedSkill(
      plannedSkill,
      installRoot
    );
    result.errors.push(...compareErrors);
    result.entries.push(...relativeEntries);
    if (compareErrors.some((error) => error.code === "source_entry_list_failed")) {
      skippedExtraSkillNames.add(plannedSkill.skill);
    }
  }

  for (const plannedSkill of result.planned) {
    if (skippedExtraSkillNames.has(plannedSkill.skill)) {
      continue;
    }

    const targetSkillPath = path.join(installRoot, plannedSkill.skill);
    const plannedRelativePaths = new Set(
      result.entries
        .filter(
          (entry) =>
            entry.action !== "extra" && entry.action !== "blocked" && entry.skill === plannedSkill.skill
        )
        .map((entry) => entry.relativePath)
        .filter((entryPath): entryPath is string => typeof entryPath === "string")
    );

    const extraEntries = await collectExtraEntries(plannedSkill.skill, targetSkillPath, plannedRelativePaths);
    result.entries.push(...extraEntries);
  }

  result.summary = summarizeActions(result.entries);
  result.ok = result.errors.length === 0 && result.summary.blocked === 0 && result.summary.missing === 0;

  return result;
}

function blockedEntryFromPlan(blockedEntry: PlanItem): DiffEntry {
  return {
    action: "blocked",
    skill: blockedEntry.skill,
    relativePath: null,
    targetPath: null,
    sourcePath: blockedEntry.sourcePath,
    sourceSha256: null,
    targetSha256: null,
    bytes: null,
    reason: blockedEntry.reason,
    variant: blockedEntry.variant
  };
}

async function comparePlannedSkill(
  plannedSkill: PlanItem,
  installRoot: string
): Promise<{ entries: DiffEntry[]; errors: DiffResultError[] }> {
  const sourceRoot = plannedSkill.sourcePath;
  const targetRoot = path.join(installRoot, plannedSkill.skill);
  const sourceListing = await collectSourceEntries(sourceRoot);
  if (!sourceListing.ok) {
    return { entries: [], errors: sourceListing.errors };
  }

  const sourceEntries = sourceListing.entries;
  const plannedEntries: DiffEntry[] = [];

  for (const sourcePath of sourceEntries) {
    const relativePath = path.relative(sourceRoot, sourcePath);
    const targetPath = path.join(targetRoot, relativePath);
    const sourceRead = await safeReadFile(sourcePath);
    if (!sourceRead.ok) {
      plannedEntries.push(
        entry(
          "missing",
          plannedSkill.skill,
          relativePath,
          targetPath,
          sourcePath,
          null,
          null,
          null
        )
      );
      continue;
    }

    const targetRead = await safeReadFile(targetPath);
    if (!targetRead.ok) {
      if (targetRead.code === "ENOENT") {
        plannedEntries.push(
          entry(
            "create",
            plannedSkill.skill,
            relativePath,
            targetPath,
            sourcePath,
            sourceRead.sha256,
            null,
            sourceRead.bytes
          )
        );
        continue;
      }

      plannedEntries.push(
        entry(
          "missing",
          plannedSkill.skill,
          relativePath,
          targetPath,
          sourcePath,
          sourceRead.sha256,
          null,
          sourceRead.bytes
        )
      );
      continue;
    }

    const action = sourceRead.sha256 === targetRead.sha256 ? "unchanged" : "update";
    plannedEntries.push(
      entry(
        action,
        plannedSkill.skill,
        relativePath,
        targetPath,
        sourcePath,
        sourceRead.sha256,
        targetRead.sha256,
        sourceRead.bytes
      )
    );
  }

  return { entries: plannedEntries, errors: [] };
}

async function collectExtraEntries(
  skill: string,
  targetSkillPath: string,
  plannedRelativePaths: Set<string>
): Promise<DiffEntry[]> {
  const files = await collectTargetEntries(targetSkillPath);
  const entries: DiffEntry[] = [];

  for (const targetPath of files) {
    const relativePath = path.relative(targetSkillPath, targetPath);
    if (plannedRelativePaths.has(relativePath)) {
      continue;
    }

    const targetRead = await safeReadFile(targetPath);
    if (!targetRead.ok) {
      continue;
    }

    entries.push(
      entry(
        "extra",
        skill,
        relativePath,
        targetPath,
        null,
        null,
        targetRead.sha256,
        targetRead.bytes
      )
    );
  }

  return entries;
}

async function collectSourceEntries(
  root: string
): Promise<{ ok: boolean; entries: string[]; errors: DiffResultError[] }> {
  try {
    const files = await listFiles(root);
    const entries: string[] = [];

    for (const entry of files) {
      const info = await stat(entry);
      if (info.isFile()) {
        entries.push(entry);
      }
    }

    return { ok: true, entries, errors: [] };
  } catch (error) {
    if (!(error instanceof Error)) {
      return {
        ok: false,
        entries: [],
        errors: [
          {
            code: "source_entry_list_failed",
            message: "Failed to list source entries for unknown catalog path."
          }
        ]
      };
    }

    return {
      ok: false,
      entries: [],
      errors: [
        {
          code: "source_entry_list_failed",
          message: `Failed to list source entries for ${root}: ${error.message}`
        }
      ]
    };
  }
}

async function collectTargetEntries(targetPath: string): Promise<string[]> {
  try {
    return await listFiles(targetPath);
  } catch {
    return [];
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

async function safeReadFile(filePath: string): Promise<DiffSourceFileRead> {
  try {
    const bytes = await readFile(filePath);
    return {
      ok: true,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN",
      bytes: null,
      sha256: null
    };
  }
}

function entry(
  action: DiffEntryAction,
  skill: string,
  relativePath: string,
  targetPath: string,
  sourcePath: string | null,
  sourceSha256: string | null,
  targetSha256: string | null,
  bytes: number | null
): DiffEntry {
  return {
    action,
    skill,
    relativePath,
    targetPath,
    sourcePath,
    sourceSha256,
    targetSha256,
    bytes
  };
}

async function resolveAssignmentInstallRoot(
  manifest: Catalog,
  target: string
): Promise<ResolveAssignmentInstallRootResult> {
  const assignmentPaths = manifest.assignmentPaths ?? {};
  const errors: DiffResultError[] = [];

  if (!isRecord(assignmentPaths)) {
    errors.push({
      code: "invalid_assignment_paths",
      message: "Manifest assignmentPaths is not a valid mapping."
    });
    return { ok: false, errors, installRoot: null, assignment: null };
  }

  const directAssignmentPath = assignmentPaths[target];
  if (directAssignmentPath !== undefined && !isRecord(directAssignmentPath)) {
    errors.push({
      code: "missing_target_assignment_path",
      message: `No assignmentPath declared for target ${target}.`
    });
    return { ok: false, errors, installRoot: null, assignment: null };
  }

  if (isRecord(directAssignmentPath)) {
    return resolveSingleAssignmentPath(manifest, target, directAssignmentPath);
  }

  if (!isRecord(manifest.assignments?.[target])) {
    errors.push({
      code: "missing_target_assignment_path",
      message: `No assignmentPath declared for target ${target}.`
    });
    return { ok: false, errors, installRoot: null, assignment: null };
  }

  const matchingAssignmentPaths = findAssignmentPathByAssignment(assignmentPaths, target);
  if (matchingAssignmentPaths.length === 0) {
    errors.push({
      code: "missing_install_root",
      message: `No install root declared for assignment ${target}.`
    });
    return { ok: false, errors, installRoot: null, assignment: target };
  }

  if (matchingAssignmentPaths.length > 1) {
    errors.push({
      code: "ambiguous_install_root",
      message: `Target ${target} matches multiple assignment paths; pass a concrete assignmentPath target selector.`,
      candidates: matchingAssignmentPaths.map((candidate) => candidate.id)
    });
    return { ok: false, errors, installRoot: null, assignment: target };
  }

  const match = matchingAssignmentPaths[0];
  if (!match) {
    return { ok: false, errors, installRoot: null, assignment: target };
  }

  return resolveSingleAssignmentPath(manifest, match.id, match.path);
}

async function resolveSingleAssignmentPath(
  manifest: Catalog,
  assignmentPathId: string,
  assignmentPath: Record<string, unknown>
): Promise<ResolveAssignmentInstallRootResult> {
  const errors: DiffResultError[] = [];
  const assignment = normalizeValue(assignmentPath.assignment);
  if (!assignment) {
    errors.push({
      code: "invalid_assignment_path",
      message: `Assignment path ${assignmentPathId} is missing assignment.`
    });
    return { ok: false, errors, installRoot: null, assignment: null };
  }

  if (!isRecord(manifest.assignments?.[assignment])) {
    errors.push({
      code: "unknown_assignment_path_target",
      message: `Assignment path ${assignmentPathId} points at unknown assignment ${assignment}.`
    });
    return { ok: false, errors, installRoot: null, assignment };
  }

  const kind = normalizeValue(assignmentPath.kind);
  const field = kind ? KIND_PATH_RULES[kind as keyof typeof KIND_PATH_RULES] : null;

  if (!kind) {
    errors.push({
      code: "invalid_assignment_path",
      message: `Assignment path ${assignmentPathId} is missing kind.`
    });
    return { ok: false, errors, installRoot: null, assignment };
  }

  if (!field) {
    errors.push({
      code: "unsupported_assignment_path_kind",
      message: `Assignment path ${assignmentPathId} has unsupported kind ${kind}.`
    });
    return { ok: false, errors, installRoot: null, assignment };
  }

  const installRoot = normalizeValue(assignmentPath[field]);
  if (!installRoot) {
    errors.push({
      code: "invalid_assignment_path",
      message: `Assignment path ${assignmentPathId} is missing required field ${field}.`
    });
    return { ok: false, errors, installRoot: null, assignment };
  }

  if (!(await isDirectory(installRoot))) {
    errors.push({
      code: "missing_install_root",
      message: `Assignment path ${assignmentPathId} points at missing install root: ${installRoot}.`
    });
    return { ok: false, errors, installRoot, assignment };
  }

  return { ok: true, errors: [], installRoot, assignment };
}

function findAssignmentPathByAssignment(
  assignmentPaths: Record<string, unknown>,
  assignment: string
): { id: string; path: Record<string, unknown> }[] {
  const matches: { id: string; path: Record<string, unknown> }[] = [];

  for (const [pathId, assignmentPath] of Object.entries(assignmentPaths)) {
    if (!isRecord(assignmentPath)) {
      continue;
    }
    if (normalizeValue(assignmentPath.assignment) === assignment) {
      matches.push({ id: pathId, path: assignmentPath });
    }
  }

  return matches;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function summarizeActions(entries: DiffEntry[]): DiffSummary {
  const summary: DiffSummary = {
    create: 0,
    update: 0,
    unchanged: 0,
    extra: 0,
    missing: 0,
    blocked: 0
  };

  for (const entryItem of entries) {
    const value = summary[entryItem.action];
    if (Number.isInteger(value)) {
      summary[entryItem.action] += 1;
    }
  }

  return summary;
}

function normalizeValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
