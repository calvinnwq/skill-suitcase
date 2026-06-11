import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { loadCatalog } from "./catalog.js";
import { plan } from "./planner.js";

export const PLAN_LOCK_SCHEMA = "calvinnwq.skills.plan-lock.v0";

export async function buildPlanLock({ source, target, assignmentPath, sourceCommit }) {
  const { sourceRoot } = await loadCatalog(source);
  const planResult = await plan({ source: sourceRoot, target });

  if (!planResult.ok) {
    throw new Error(`Cannot create lock for invalid plan target ${target}: ${planResult.errors[0]?.message}`);
  }

  const normalizedAssignmentPath = normalizeValue(assignmentPath);
  const commit = await resolveSourceCommit(sourceCommit, sourceRoot);
  const fileHashes = await collectPlanFileHashes(planResult.planned);
  const planEntries = planResult.planned.map((item) => stableObject(plannedEntry(item)));
  const selectedSkills = [...new Set(planResult.planned.map((item) => item.skill))].sort();

  const lockRecord = {
    schema: PLAN_LOCK_SCHEMA,
    source: {
      repo: sourceRoot,
      ref: commit,
      commit
    },
    target,
    assignmentPath: normalizedAssignmentPath,
    selectedSkills,
    planEntries,
    fileHashes
  };

  return {
    ...lockRecord,
    planId: computePlanId(lockRecord)
  };
}

export async function assessPlanLock({ source, target, assignmentPath, lock, sourceCommit }) {
  if (!isRecord(lock)) {
    return { valid: false, reasons: ["invalid_lock"], current: null };
  }

  let current;
  try {
    current = await buildPlanLock({ source, target, assignmentPath, sourceCommit });
  } catch {
    return { valid: false, reasons: ["current_plan_unavailable"], current: null };
  }
  const reasons = [];

  if (!isRecord(current.source) || !isRecord(lock.source)) {
    reasons.push("missing_source_metadata");
  }

  if (current.source?.repo !== lock.source?.repo) {
    reasons.push("source_repo_changed");
  }

  if (current.source?.ref !== lock.source?.ref) {
    reasons.push("source_ref_changed");
  }

  if (current.source?.commit !== lock.source?.commit) {
    reasons.push("source_commit_changed");
  }

  if (current.target !== lock.target) {
    reasons.push("target_changed");
  }

  if (current.assignmentPath !== lock.assignmentPath) {
    reasons.push("assignment_path_changed");
  }

  if (!arraysEqual(current.selectedSkills, lock.selectedSkills)) {
    reasons.push("selected_skills_changed");
  }

  if (!objectHashesEqual(current.planEntries, lock.planEntries)) {
    reasons.push("plan_entries_changed");
  }

  if (!objectHashesEqual(current.fileHashes, lock.fileHashes)) {
    reasons.push("file_hashes_changed");
  }

  if (current.planId !== lock.planId) {
    reasons.push("plan_id_changed");
  }

  if (lock.schema !== current.schema) {
    reasons.push("invalid_lock_schema");
  }

  return {
    valid: reasons.length === 0,
    reasons,
    current
  };
}

async function collectPlanFileHashes(plannedSkills) {
  const hashes = {};

  for (const item of plannedSkills) {
    const skillFiles = await listFiles(item.sourcePath);
    const fileHashList = {};

    for (const relativePath of skillFiles) {
      const filePath = path.join(item.sourcePath, relativePath);
      const bytes = await readFile(filePath);
      fileHashList[relativePath] = createHash("sha256").update(bytes).digest("hex");
    }

    hashes[item.skill] = stableObject(fileHashList);
  }

  return stableObject(hashes);
}

function computePlanId(lockRecord) {
  const stablePlanRecord = {
    schema: lockRecord.schema,
    source: {
      repo: lockRecord.source.repo,
      ref: lockRecord.source.ref,
      commit: lockRecord.source.commit
    },
    target: lockRecord.target,
    assignmentPath: lockRecord.assignmentPath,
    selectedSkills: [...lockRecord.selectedSkills],
    planEntries: stableObject(lockRecord.planEntries),
    fileHashes: stableObject(lockRecord.fileHashes)
  };

  const serialized = JSON.stringify(stablePlanRecord);
  return createHash("sha256").update(serialized).digest("hex");
}

async function resolveSourceCommit(explicitSourceCommit, sourceRoot) {
  if (typeof explicitSourceCommit === "string" && explicitSourceCommit.trim().length > 0) {
    return explicitSourceCommit.trim();
  }

  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    cwd: sourceRoot,
    stdio: ["ignore", "pipe", "ignore"]
  });

  if (result.status === 0 && result.stdout) {
    const commit = result.stdout.trim();
    if (commit) {
      return commit;
    }
  }

  return null;
}

function stableObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableObject(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const ordered = {};
  for (const key of Object.keys(value).sort()) {
    ordered[key] = stableObject(value[key]);
  }
  return ordered;
}

function plannedEntry(item) {
  return {
    skill: item.skill,
    action: item.action,
    variant: item.variant,
    evidence: Array.isArray(item.evidence) ? [...item.evidence] : []
  };
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

function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return left === right;
  }

  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function objectHashesEqual(left, right) {
  return JSON.stringify(stableObject(left)) === JSON.stringify(stableObject(right));
}

async function listFiles(root, prefix = "") {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") {
        continue;
      }

      const childPath = path.join(root, entry.name);
      const childEntries = await listFiles(childPath, relativePath);
      files.push(...childEntries);
      continue;
    }

    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files.sort();
}
