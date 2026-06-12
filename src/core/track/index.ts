import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { diff } from "../diffing/index.js";
import { buildInstallRecord, buildInstalledFiles, upsertAndWriteReceipt } from "../receipts/index.js";

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
    records.push({
      skill: planned.skill,
      sourcePath: planned.sourcePath,
      targetPath,
      version: await skillVersion(planned.sourcePath),
      sourceHash: await hashDirectory(planned.sourcePath),
      installedFiles: await buildInstalledFiles(targetPath)
    });
  }

  let trackedFiles = 0;
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
    await upsertAndWriteReceipt({
      installRoot,
      skillName: record.skill,
      installRecord: buildInstallRecord(installRecord)
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

async function skillVersion(skillPath: string): Promise<string | null> {
  const skillFile = path.join(skillPath, "SKILL.md");
  try {
    const info = await stat(skillFile);
    if (!info.isFile()) {
      return null;
    }
    const text = await readFile(skillFile, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
    if (frontmatter === null) {
      return null;
    }
    const body = frontmatter[1] ?? "";
    for (const line of body.split("\n")) {
      const match = /^version:\s*(.+?)\s*$/.exec(line);
      if (match?.[1]) {
        return match[1].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    return null;
  }
  return null;
}
