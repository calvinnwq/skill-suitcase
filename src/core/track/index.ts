import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { diff } from "../diffing/index.js";
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
  planned: Array<{ skill: string; sourcePath: string }>;
  blocked: Array<{ skill: string; reason?: string }>;
  entries: Array<{
    action: "create" | "update" | "unchanged" | "extra" | "missing" | "blocked";
    skill: string;
    sourcePath: string | null;
    targetPath: string | null;
    reason?: string;
  }>;
  errors: Array<{ code: string; message: string }>;
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
  errors: TrackError[];
};

export async function track({ source, target }: TrackInput): Promise<TrackResult> {
  if (!source) {
    throw new Error("source is required");
  }
  if (!target) {
    throw new Error("target is required");
  }

  const diffResult = await diff({ source, target }) as DiffForTrack;
  const installRoot = diffResult.installRoot;
  const errors = collectTrackErrors(diffResult);

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
      planned: diffResult.planned.length,
      blocked: diffResult.blocked.length,
      errors
    });
  }

  const records: Array<{
    skill: string;
    sourcePath: string;
    targetPath: string;
    version: string | null;
    sourceHash: string;
    installedFiles: Awaited<ReturnType<typeof buildInstalledFiles>>;
  }> = [];

  for (const planned of diffResult.planned) {
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
    records.push({
      skill: planned.skill,
      sourcePath: planned.sourcePath,
      targetPath,
      version: await readSkillVersion(planned.sourcePath).catch(() => null),
      sourceHash: sourceHash.hash,
      installedFiles: installedFiles.files
    });
  }

  if (errors.length > 0) {
    return failure({
      source: diffResult.source,
      target,
      assignment: diffResult.assignment,
      installRoot,
      planned: diffResult.planned.length,
      blocked: diffResult.blocked.length,
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
      planned: diffResult.planned.length,
      blocked: diffResult.blocked.length,
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
      planned: diffResult.planned.length,
      blocked: diffResult.blocked.length,
      errors: [trackError({
        code: "receipt_write_failed",
        message: `Failed to write track receipt: ${errorMessage(error)}`,
        path: installRoot
      })]
    });
  }

  const skills = records.map((record) => record.skill).sort();
  return {
    ok: true,
    source: diffResult.source,
    target,
    assignment: diffResult.assignment,
    installRoot,
    summary: {
      planned: diffResult.planned.length,
      tracked: records.length,
      files: trackedFiles,
      refused: 0,
      blocked: diffResult.blocked.length
    },
    tracked: {
      skills,
      files: trackedFiles
    },
    errors: []
  };
}

function collectTrackErrors(diffResult: DiffForTrack): TrackError[] {
  const errors: TrackError[] = diffResult.errors.map((error) => ({
    code: `diff_${error.code}`,
    message: error.message
  }));

  for (const blocked of diffResult.blocked) {
    errors.push({
      code: "blocked_skill",
      message: `Skill ${blocked.skill} is blocked for track: ${blocked.reason ?? "blocked"}`,
      skill: blocked.skill
    });
  }

  for (const entry of diffResult.entries) {
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

  return errors;
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
  errors
}: {
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  planned: number;
  blocked: number;
  errors: TrackError[];
}): TrackResult {
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
    errors
  };
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
