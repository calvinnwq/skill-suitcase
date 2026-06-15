import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { diff } from "../diffing/index.js";
import type { TargetOverrides } from "../catalog/index.js";
import {
  buildInstallRecord,
  buildInstalledFiles,
  readReceipt,
  upsertInstallRecord,
  writeReceipt,
  type Receipt
} from "../receipts/index.js";
import { readSkillVersion } from "../skill-metadata.js";

type TrackInput = {
  source: string;
  target: string;
  skills?: string[];
  targetOverrides?: TargetOverrides | undefined;
};

type TrackError = {
  code: string;
  message: string;
  skill?: string;
  path?: string;
};

type DiffForTrack = {
  ok: boolean;
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  planned: Array<{ skill: string; sourcePath: string; variant?: string }>;
  blocked: Array<{ skill: string; reason?: string }>;
  entries: Array<{
    action: "create" | "update" | "unchanged" | "extra" | "missing" | "blocked";
    skill: string;
    sourcePath: string | null;
    targetPath: string | null;
    reason?: string;
  }>;
  errors: Array<{ code: string; message: string; skill?: string }>;
};

type InstalledFilesResult =
  | { ok: true; files: Awaited<ReturnType<typeof buildInstalledFiles>> }
  | { ok: false; error: TrackError };

type SourceHashResult =
  | { ok: true; hash: string }
  | { ok: false; error: TrackError };

type TargetTreeValidationResult =
  | { ok: true }
  | { ok: false; error: TrackError };

export type TrackResult = {
  ok: boolean;
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  summary: {
    planned: number;
    tracked: number;
    files: number;
    refused: number;
    blocked: number;
  };
  tracked: {
    skills: string[];
    files: number;
  };
  selected: {
    skills: string[];
  };
  refused: {
    skills: string[];
  };
  errors: TrackError[];
};

export async function track({ source, target, skills, targetOverrides }: TrackInput): Promise<TrackResult> {
  if (!source) {
    throw new Error("source is required");
  }
  if (!target) {
    throw new Error("target is required");
  }

  const skillFilterWasProvided = skills !== undefined;
  const selectedSkills = normalizeSelectedSkills(skills);
  if (skillFilterWasProvided && (selectedSkills.length === 0 || hasBlankSkillFilter(skills))) {
    return failure({
      source,
      target,
      assignment: null,
      installRoot: null,
      planned: 0,
      blocked: 0,
      selected: selectedSkills,
      errors: [trackError({
        code: "invalid_skill_filter",
        message: "At least one non-blank skill filter is required for targeted track."
      })]
    });
  }
  const selectedSkillSet = selectedSkills.length > 0 ? new Set(selectedSkills) : null;
  const diffResult = await diff({
    source,
    target,
    targetOverrides,
    ...(selectedSkillSet !== null ? { skills: selectedSkills } : {})
  }) as DiffForTrack;
  const installRoot = diffResult.installRoot;
  const plannedForTrack = selectPlannedForTrack(diffResult.planned, selectedSkillSet);
  const blockedForTrack = countBlockedForTrack(diffResult.blocked, selectedSkillSet);
  const errors = collectTrackErrors(diffResult, selectedSkillSet, selectedSkills);

  if (installRoot === null) {
    errors.push({
      code: "missing_install_root",
      message: "could not resolve install root for track"
    });
  }

  if (errors.length > 0 || installRoot === null) {
    return failure({
      source: diffResult.source,
      target,
      assignment: diffResult.assignment,
      installRoot,
      planned: plannedForTrack.length,
      blocked: blockedForTrack,
      selected: selectedSkills,
      errors
    });
  }

  const records: Array<{
    skill: string;
    sourcePath: string;
    variant?: string;
    targetPath: string;
    version: string | null;
    sourceHash: string;
    installedFiles: Awaited<ReturnType<typeof buildInstalledFiles>>;
  }> = [];

  for (const planned of plannedForTrack) {
    const targetPath = path.join(installRoot, planned.skill);
    const installedFiles = await readInstalledFiles(targetPath, planned.skill);
    if (!installedFiles.ok) {
      errors.push(installedFiles.error);
      continue;
    }
    const sourceHash = await readSourceHash(planned.sourcePath, planned.skill);
    if (!sourceHash.ok) {
      errors.push(sourceHash.error);
      continue;
    }
    const record: {
      skill: string;
      sourcePath: string;
      variant?: string;
      targetPath: string;
      version: string | null;
      sourceHash: string;
      installedFiles: Awaited<ReturnType<typeof buildInstalledFiles>>;
    } = {
      skill: planned.skill,
      sourcePath: planned.sourcePath,
      targetPath,
      version: await readSkillVersion(planned.sourcePath).catch(() => null),
      sourceHash: sourceHash.hash,
      installedFiles: installedFiles.files
    };
    if (typeof planned.variant === "string" && planned.variant.trim().length > 0) {
      record.variant = planned.variant;
    }
    records.push(record);
  }

  if (errors.length > 0) {
    return failure({
      source: diffResult.source,
      target,
      assignment: diffResult.assignment,
      installRoot,
      planned: plannedForTrack.length,
      blocked: blockedForTrack,
      selected: selectedSkills,
      errors
    });
  }

  let trackedFiles = 0;
  let nextReceipt: Receipt;
  try {
    nextReceipt = await readReceipt({ installRoot });
  } catch (error) {
    return failure({
      source: diffResult.source,
      target,
      assignment: diffResult.assignment,
      installRoot,
      planned: plannedForTrack.length,
      blocked: blockedForTrack,
      selected: selectedSkills,
      errors: [trackError({
        code: "invalid_receipt",
        message: `Could not read receipt for track: ${errorMessage(error)}`
      })]
    });
  }

  for (const record of records) {
    trackedFiles += record.installedFiles.length;
    const installRecord: Record<string, unknown> = {
      skill: record.skill,
      agent: diffResult.assignment ?? target,
      target: diffResult.assignment ?? target,
      mode: "track",
      source: {
        path: record.sourcePath
      },
      sourcePath: record.sourcePath,
      targetPath: record.targetPath,
      sourceHash: record.sourceHash,
      installedFiles: record.installedFiles,
      priorState: {
        status: "unknown",
        reason: "target existed before Suitcase tracking"
      }
    };
    if (record.variant !== undefined) {
      installRecord.variant = record.variant;
    }
    if (record.version !== null) {
      installRecord.version = record.version;
    }
    nextReceipt = upsertInstallRecord(nextReceipt, {
      installRoot,
      skillName: record.skill,
      installRecord: buildInstallRecord(installRecord)
    });
  }

  try {
    await writeReceipt({
      installRoot,
      receipt: nextReceipt
    });
  } catch (error) {
    return failure({
      source: diffResult.source,
      target,
      assignment: diffResult.assignment,
      installRoot,
      planned: plannedForTrack.length,
      blocked: blockedForTrack,
      selected: selectedSkills,
      errors: [trackError({
        code: "receipt_write_failed",
        message: `Failed to write track receipt: ${errorMessage(error)}`,
        path: installRoot
      })]
    });
  }

  const trackedSkills = records.map((record) => record.skill).sort();
  return {
    ok: true,
    source: diffResult.source,
    target,
    assignment: diffResult.assignment,
    installRoot,
    summary: {
      planned: plannedForTrack.length,
      tracked: records.length,
      files: trackedFiles,
      refused: 0,
      blocked: blockedForTrack
    },
    tracked: {
      skills: trackedSkills,
      files: trackedFiles
    },
    selected: {
      skills: selectedSkills
    },
    refused: {
      skills: []
    },
    errors: []
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

function selectPlannedForTrack(
  planned: DiffForTrack["planned"],
  selectedSkillSet: ReadonlySet<string> | null
): DiffForTrack["planned"] {
  if (selectedSkillSet === null) {
    return planned;
  }
  return planned.filter((entry) => selectedSkillSet.has(entry.skill));
}

function countBlockedForTrack(
  blocked: DiffForTrack["blocked"],
  selectedSkillSet: ReadonlySet<string> | null
): number {
  if (selectedSkillSet === null) {
    return blocked.length;
  }
  return blocked.filter((entry) => selectedSkillSet.has(entry.skill)).length;
}

function collectTrackErrors(
  diffResult: DiffForTrack,
  selectedSkillSet: ReadonlySet<string> | null,
  selectedSkills: string[]
): TrackError[] {
  const errors: TrackError[] = diffResult.errors
    .filter((error) => selectedSkillSet === null || error.skill === undefined || selectedSkillSet.has(error.skill))
    .map((error) => trackError({
      code: trackCodeForDiffError(error.code),
      message: error.message,
      ...(error.skill !== undefined ? { skill: error.skill } : {})
    }));

  for (const blocked of diffResult.blocked) {
    if (selectedSkillSet !== null && !selectedSkillSet.has(blocked.skill)) {
      continue;
    }
    errors.push({
      code: "blocked_skill",
      message: `Skill ${blocked.skill} is blocked for track: ${blocked.reason ?? "blocked"}`,
      skill: blocked.skill
    });
  }

  for (const entry of diffResult.entries) {
    if (selectedSkillSet !== null && !selectedSkillSet.has(entry.skill)) {
      continue;
    }

    if (entry.action === "unchanged") {
      continue;
    }

    if (entry.action === "create") {
      errors.push(trackError({
        code: "target_missing",
        message: `Target file is missing for ${entry.skill}.`,
        skill: entry.skill,
        path: entry.targetPath
      }));
      continue;
    }

    if (entry.action === "update" || entry.action === "extra") {
      errors.push(trackError({
        code: "target_mismatch",
        message: `Target files do not match source for ${entry.skill}.`,
        skill: entry.skill,
        path: entry.targetPath
      }));
      continue;
    }

    if (entry.action === "missing") {
      errors.push(trackError({
        code: "source_missing",
        message: `Source file is missing for ${entry.skill}.`,
        skill: entry.skill,
        path: entry.sourcePath
      }));
      continue;
    }
  }

  if (selectedSkillSet !== null) {
    const knownSkills = new Set([
      ...diffResult.planned.map((entry) => entry.skill),
      ...diffResult.blocked.map((entry) => entry.skill),
      ...diffResult.entries.map((entry) => entry.skill),
      ...diffResult.errors
        .map((error) => error.skill)
        .filter((skill): skill is string => typeof skill === "string")
    ]);
    for (const skill of selectedSkills) {
      if (!knownSkills.has(skill)) {
        errors.push(trackError({
          code: "skill_not_planned",
          message: `Skill ${skill} is not planned for target ${diffResult.assignment ?? diffResult.target}.`,
          skill
        }));
      }
    }
  }

  return errors;
}

function trackCodeForDiffError(code: string): string {
  if (code === "source_missing" || code === "source_unreadable") {
    return code;
  }
  return `diff_${code}`;
}

function trackError({
  code,
  message,
  skill,
  path: errorPath
}: {
  code: string;
  message: string;
  skill?: string;
  path?: string | null;
}): TrackError {
  return {
    code,
    message,
    ...(skill !== undefined ? { skill } : {}),
    ...(typeof errorPath === "string" ? { path: errorPath } : {})
  };
}

function failure({
  source,
  target,
  assignment,
  installRoot,
  planned,
  blocked,
  selected,
  errors
}: {
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  planned: number;
  blocked: number;
  selected: string[];
  errors: TrackError[];
}): TrackResult {
  const refusedSkills = refusedSkillsFromErrors(errors);
  return {
    ok: false,
    source,
    target,
    assignment,
    installRoot,
    summary: {
      planned,
      tracked: 0,
      files: 0,
      refused: errors.length,
      blocked
    },
    tracked: {
      skills: [],
      files: 0
    },
    selected: {
      skills: selected
    },
    refused: {
      skills: refusedSkills
    },
    errors
  };
}

function refusedSkillsFromErrors(errors: TrackError[]): string[] {
  return [...new Set(
    errors
      .map((error) => error.skill)
      .filter((skill): skill is string => typeof skill === "string")
  )].sort();
}

async function readInstalledFiles(
  targetPath: string,
  skill: string
): Promise<InstalledFilesResult> {
  const validation = await validateTargetTree(targetPath, skill);
  if (!validation.ok) {
    return validation;
  }

  try {
    return { ok: true, files: await buildInstalledFiles(targetPath) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        ok: false,
        error: trackError({
          code: "target_missing",
          message: `Target directory is missing for ${skill}.`,
          skill,
          path: targetPath
        })
      };
    }
    return {
      ok: false,
      error: trackError({
        code: "target_unreadable",
        message: `Target directory could not be read for ${skill}: ${errorMessage(error)}`,
        skill,
        path: targetPath
      })
    };
  }
}

async function validateTargetTree(targetPath: string, skill: string): Promise<TargetTreeValidationResult> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        ok: false,
        error: trackError({
          code: "target_missing",
          message: `Target directory is missing for ${skill}.`,
          skill,
          path: targetPath
        })
      };
    }
    return unreadableTargetTree(targetPath, skill, error);
  }

  if (info.isSymbolicLink()) {
    return symlinkedTargetTree(targetPath, skill, targetPath);
  }
  if (!info.isDirectory()) {
    return unreadableTargetTree(targetPath, skill, new Error("target is not a directory"));
  }

  return validateTargetTreeEntries(targetPath, skill, targetPath);
}

async function validateTargetTreeEntries(
  rootPath: string,
  skill: string,
  currentPath: string
): Promise<TargetTreeValidationResult> {
  try {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        return symlinkedTargetTree(rootPath, skill, entryPath);
      }
      if (entry.isDirectory()) {
        const result = await validateTargetTreeEntries(rootPath, skill, entryPath);
        if (!result.ok) {
          return result;
        }
      }
    }
  } catch (error) {
    return unreadableTargetTree(rootPath, skill, error);
  }

  return { ok: true };
}

function symlinkedTargetTree(targetPath: string, skill: string, symlinkPath: string): TargetTreeValidationResult {
  return {
    ok: false,
    error: trackError({
      code: "target_symlink",
      message: `Target tree for ${skill} contains a symlink and cannot be tracked safely.`,
      skill,
      path: symlinkPath === targetPath ? targetPath : symlinkPath
    })
  };
}

function unreadableTargetTree(targetPath: string, skill: string, error: unknown): TargetTreeValidationResult {
  return {
    ok: false,
    error: trackError({
      code: "target_unreadable",
      message: `Target directory could not be read for ${skill}: ${errorMessage(error)}`,
      skill,
      path: targetPath
    })
  };
}

async function readSourceHash(sourcePath: string, skill: string): Promise<SourceHashResult> {
  try {
    return { ok: true, hash: await hashDirectory(sourcePath) };
  } catch (error) {
    return {
      ok: false,
      error: trackError({
        code: "source_unreadable",
        message: `Source directory could not be read for ${skill}: ${errorMessage(error)}`,
        skill,
        path: sourcePath
      })
    };
  }
}

async function hashDirectory(root: string): Promise<string> {
  const files = await collectFiles(root, root);
  const digest = createHash("sha256");
  for (const relativePath of files.sort()) {
    const bytes = await readFile(path.join(root, relativePath));
    digest.update(relativePath);
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function collectFiles(root: string, baseRoot: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      continue;
    }
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(entryPath, baseRoot));
      continue;
    }
    if (entry.isFile()) {
      files.push(path.relative(baseRoot, entryPath));
    }
  }
  return files;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
