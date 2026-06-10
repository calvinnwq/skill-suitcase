import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadCatalog } from "./catalog.js";
import { plan } from "./planner.js";

const KIND_PATH_RULES = {
  "openclaw-skills-root": "path",
  "claude-skills-root": "path",
  "codex-home": "skillsPath",
  "nested-home-codex": "skillsPath"
};

export async function diff({ source, target }) {
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

  const result = {
    ok: false,
    source: sourceRoot,
    target,
    assignment: planTarget,
    installRoot: null,
    planned: planResult.planned ?? [],
    blocked: planResult.blocked ?? [],
    entries: [],
    summary: null,
    errors: [...planResult.errors]
  };

  result.installRoot = installation.installRoot;
  if (!installation.ok) {
    result.errors.push(...installation.errors);
    result.summary = summarizeActions(result.entries);
    return result;
  }

  if (!planResult.ok) {
    for (const blockedEntry of result.blocked) {
      result.entries.push(blockedEntryFromPlan(blockedEntry));
    }
    result.summary = summarizeActions(result.entries);
    result.ok = false;
    return result;
  }

  for (const blockedEntry of result.blocked) {
    result.entries.push(blockedEntryFromPlan(blockedEntry));
  }

  for (const plannedSkill of result.planned) {
    const relativeEntries = await comparePlannedSkill(plannedSkill, result.installRoot);
    result.entries.push(...relativeEntries);
  }

  for (const plannedSkill of result.planned) {
    const targetSkillPath = path.join(result.installRoot, plannedSkill.skill);
    const extraEntries = await collectExtraEntries(
      plannedSkill.skill,
      targetSkillPath,
      new Set(
        result.entries
          .filter((entry) => entry.action !== "extra" && entry.action !== "blocked" && entry.skill === plannedSkill.skill)
          .map((entry) => entry.relativePath)
      )
    );
    result.entries.push(...extraEntries);
  }

  result.summary = summarizeActions(result.entries);
  result.ok = result.errors.length === 0 && result.summary.blocked === 0 && result.summary.missing === 0;

  return result;
}

function blockedEntryFromPlan(blockedEntry) {
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

async function comparePlannedSkill(plannedSkill, installRoot) {
  const sourceRoot = plannedSkill.sourcePath;
  const targetRoot = path.join(installRoot, plannedSkill.skill);
  const sourceEntries = await collectSourceEntries(sourceRoot);
  const plannedEntries = [];

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

  return plannedEntries;
}

async function collectExtraEntries(skill, targetSkillPath, plannedRelativePaths) {
  const files = await collectTargetEntries(targetSkillPath);
  const entries = [];

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

async function collectSourceEntries(root) {
  const files = await listFiles(root);
  const entries = [];

  for (const entry of files) {
    const info = await stat(entry);
    if (info.isFile()) {
      entries.push(entry);
    }
  }

  return entries;
}

async function collectTargetEntries(targetPath) {
  try {
    return await listFiles(targetPath);
  } catch {
    return [];
  }
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

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

async function safeReadFile(filePath) {
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
      code: error.code,
      bytes: null,
      sha256: null
    };
  }
}

function entry(action, skill, relativePath, targetPath, sourcePath, sourceSha256, targetSha256, bytes) {
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

async function resolveAssignmentInstallRoot(manifest, target) {
  const assignmentPaths = manifest.assignmentPaths ?? {};
  const errors = [];

  if (!isRecord(assignmentPaths)) {
    errors.push({
      code: "invalid_assignment_paths",
      message: "Manifest assignmentPaths is not a valid mapping."
    });
    return { ok: false, errors, installRoot: null };
  }

  const assignmentPath = assignmentPaths[target];
  if (!isRecord(assignmentPath)) {
    errors.push({
      code: "missing_target_assignment_path",
      message: `No assignmentPath declared for target ${target}.`
    });
    return { ok: false, errors, installRoot: null, assignment: null };
  }

  const assignment = normalizeValue(assignmentPath.assignment);
  if (!assignment) {
    errors.push({
      code: "invalid_assignment_path",
      message: `Assignment path ${target} is missing assignment.`
    });
    return { ok: false, errors, installRoot: null, assignment: null };
  }

  if (!isRecord(manifest.assignments?.[assignment])) {
    errors.push({
      code: "unknown_assignment_path_target",
      message: `Assignment path ${target} points at unknown assignment ${assignment}.`
    });
    return { ok: false, errors, installRoot: null, assignment };
  }

  const kind = normalizeValue(assignmentPath.kind);
  const field = kind ? KIND_PATH_RULES[kind] : null;

  if (!kind) {
    errors.push({
      code: "invalid_assignment_path",
      message: `Assignment path ${target} is missing kind.`
    });
    return { ok: false, errors, installRoot: null, assignment };
  }

  if (!field) {
    errors.push({
      code: "unsupported_assignment_path_kind",
      message: `Assignment path ${target} has unsupported kind ${kind}.`
    });
    return { ok: false, errors, installRoot: null, assignment };
  }

  const installRoot = normalizeValue(assignmentPath[field]);
  if (!installRoot) {
    errors.push({
      code: "invalid_assignment_path",
      message: `Assignment path ${target} is missing required field ${field}.`
    });
    return { ok: false, errors, installRoot: null, assignment };
  }

  if (!(await isDirectory(installRoot))) {
    errors.push({
      code: "missing_install_root",
      message: `Assignment path ${target} points at missing install root: ${installRoot}.`
    });
    return { ok: false, errors, installRoot, assignment };
  }

  return { ok: true, errors: [], installRoot, assignment };
}

async function isDirectory(candidate) {
  try {
    const info = await stat(candidate);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function summarizeActions(entries) {
  const summary = {
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

function normalizeValue(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
