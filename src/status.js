import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadCatalog } from "./catalog.js";
import { plan } from "./planner.js";

const SYNC_SCHEMA = "calvinnwq.skills.sync-lock.v0";
const RECEIPT_FILE = ".skills-sync.json";
const PATH_FIELDS_BY_KIND = {
  "openclaw-skills-root": ["path"],
  "claude-skills-root": ["path"],
  "codex-home": ["skillsPath"],
  "nested-home-codex": ["skillsPath"]
};
const VALID_STATUSES = new Set(["current", "behind", "version", "dirty", "missing", "unknown", "blocked"]);

export async function status({ source }) {
  if (!source) {
    throw new Error("source is required");
  }

  const { manifestPath, sourceRoot, manifest } = await loadCatalog(source);
  const summary = {
    current: 0,
    behind: 0,
    version: 0,
    dirty: 0,
    missing: 0,
    unknown: 0,
    blocked: 0
  };
  const assignments = [];
  const statuses = [];
  const errors = [];

  const assignmentPaths = manifest.assignmentPaths ?? {};
  if (!isRecord(assignmentPaths)) {
    errors.push({
      code: "invalid_assignment_paths",
      message: "Manifest assignmentPaths is not a valid mapping."
    });
    return {
      ok: false,
      source: sourceRoot,
      manifestPath,
      assignments,
      statuses,
      summary,
      errors
    };
  }

  for (const [assignmentPathId, assignmentPath] of Object.entries(assignmentPaths)) {
    const assignmentResult = {
      assignmentPath: assignmentPathId,
      assignment: null,
      kind: null,
      installRoot: null,
      statusCount: 0,
      statuses: [],
      errors: []
    };

    if (!isRecord(assignmentPath)) {
      const assignmentError = {
        code: "invalid_assignment_path",
        message: `Assignment path ${assignmentPathId} is malformed and must be an object.`
      };
      assignmentResult.errors.push(assignmentError);
      errors.push({
        ...assignmentError,
        path: `assignmentPaths.${assignmentPathId}`
      });
      assignments.push(assignmentResult);
      continue;
    }

    const assignmentName = normalizeValue(assignmentPath.assignment);
    const kind = normalizeValue(assignmentPath.kind);
    const installRoot = resolveAssignmentInstallRoot(assignmentPath, kind);

    assignmentResult.assignment = assignmentName;
    assignmentResult.kind = kind;
    assignmentResult.installRoot = installRoot;

    if (!assignmentName) {
      const assignmentError = {
        code: "invalid_assignment_path",
        message: `Assignment path ${assignmentPathId} is missing assignment.`
      };
      assignmentResult.errors.push(assignmentError);
      errors.push({ ...assignmentError, path: `assignmentPaths.${assignmentPathId}.assignment` });
      assignments.push(assignmentResult);
      continue;
    }

    if (!kind || !installRoot) {
      const message = kind
        ? `Assignment path ${assignmentPathId} is missing required install-root field.`
        : `Assignment path ${assignmentPathId} is missing or uses an unsupported kind.`;
      const pathField = kind && PATH_FIELDS_BY_KIND[kind]?.[0] ? PATH_FIELDS_BY_KIND[kind][0] : "kind";
      const assignmentError = {
        code: "invalid_assignment_path",
        message
      };
      assignmentResult.errors.push(assignmentError);
      errors.push({ ...assignmentError, path: `assignmentPaths.${assignmentPathId}.${pathField}` });
      assignments.push(assignmentResult);
      continue;
    }

    let assignmentPlan;
    try {
      assignmentPlan = await plan({ source: sourceRoot, target: assignmentName });
    } catch (error) {
      const assignmentError = {
        code: "plan_failed",
        message: `Unable to create install plan for ${assignmentName}: ${error.message}`
      };
      assignmentResult.errors.push({ ...assignmentError, scope: "plan" });
      errors.push({ ...assignmentError, path: `assignmentPaths.${assignmentPathId}.assignment` });
      assignments.push(assignmentResult);
      continue;
    }
    if (!assignmentPlan.ok) {
      assignmentResult.errors.push(...assignmentPlan.errors.map((item) => ({ ...item, scope: "plan" })));
      errors.push(...assignmentPlan.errors);
    }

    for (const blocked of assignmentPlan.blocked ?? []) {
      const blockedStatus = blockedStatusFromPlan({
        blocked,
        assignmentName,
        assignmentPathId,
        kind,
        installRoot
      });
      const blockedError = {
        code: "blocked_skill",
        message: `Skill ${blocked.skill} is blocked for ${assignmentName}: ${blocked.reason}`,
        skill: blocked.skill,
        scope: "plan"
      };

      summary.blocked += 1;
      assignmentResult.statusCount += 1;
      statuses.push(blockedStatus);
      assignmentResult.statuses.push(blockedStatus);
      assignmentResult.errors.push(blockedError);
      errors.push({
        ...blockedError,
        path: `assignmentPaths.${assignmentPathId}.assignment`
      });
    }

    const receiptResult = await readReceipt(installRoot);
    const receipt = receiptResult.receipt;
    if (receiptResult.errors.length > 0) {
      assignmentResult.errors.push(...receiptResult.errors);
      errors.push(
        ...receiptResult.errors.map((item) => ({
          ...item,
          path: path.join(installRoot, RECEIPT_FILE)
        }))
      );
    }

    for (const planned of assignmentPlan.planned) {
      const check = await statusSkill({
        sourceRoot,
        sourceSkillPath: planned.sourcePath,
        installRoot,
        skillName: planned.skill,
        installRecord: receipt.installs?.[planned.skill]
      });

      const resultStatus = {
        assignment: assignmentName,
        assignmentPath: assignmentPathId,
        kind,
        skill: planned.skill,
        status: check.status,
        target: check.target,
        targetPath: check.targetPath,
        reason: check.reason,
        installedVersion: check.installedVersion,
        currentVersion: check.currentVersion,
        installedCommit: check.installedCommit,
        currentCommit: check.currentCommit,
        installedHash: check.installedHash,
        currentHash: check.currentHash
      };

      if (!VALID_STATUSES.has(resultStatus.status)) {
        errors.push({
          code: "invalid_status",
          message: `Unknown status ${resultStatus.status} for ${planned.skill} on ${assignmentPathId}.`
        });
      } else {
        summary[resultStatus.status] += 1;
      }

      assignmentResult.statusCount += 1;
      statuses.push(resultStatus);
      assignmentResult.statuses.push(resultStatus);
    }

    assignments.push(assignmentResult);
  }

  return {
    ok: errors.length === 0,
    source: sourceRoot,
    manifestPath,
    assignments,
    statuses,
    summary,
    errors
  };
}

function blockedStatusFromPlan({ blocked, assignmentName, assignmentPathId, kind, installRoot }) {
  const targetPath = path.join(installRoot, blocked.skill);
  return {
    assignment: assignmentName,
    assignmentPath: assignmentPathId,
    kind,
    skill: blocked.skill,
    status: "blocked",
    target: installRoot,
    targetPath,
    reason: blocked.reason,
    installedVersion: null,
    currentVersion: null,
    installedCommit: null,
    currentCommit: null,
    installedHash: null,
    currentHash: null,
    variant: blocked.variant
  };
}

async function statusSkill({
  sourceRoot,
  sourceSkillPath,
  installRoot,
  skillName,
  installRecord
}) {
  const targetPath = path.join(installRoot, skillName);
  const sourceVersion = await skillVersion(sourceSkillPath);
  const sourceHashValue = await hashDirectory(sourceSkillPath);
  const installExists = await targetExists(targetPath);
  const currentCommit = await readRepoCommit(sourceRoot);

  if (!installExists.exists) {
    return {
      status: "missing",
      reason: "target skill is not installed",
      target: installRoot,
      targetPath,
      installedVersion: null,
      currentVersion: sourceVersion,
      installedCommit: null,
      currentCommit,
      installedHash: null,
      currentHash: sourceHashValue
    };
  }

  if (!installRecord) {
    return {
      status: "unknown",
      reason: "target exists but has no sync receipt",
      target: installRoot,
      targetPath,
      installedVersion: null,
      currentVersion: sourceVersion,
      installedCommit: null,
      currentCommit,
      installedHash: null,
      currentHash: sourceHashValue
    };
  }

  const currentVersion = sourceVersion;
  const installedVersion = installRecord.version ?? null;
  const installedHash = installRecord.sourceHash ?? null;
  const installedCommit = installRecord.sourceCommit ?? null;

  if (installedHash) {
    const targetHash = await hashInstalledTarget(targetPath);
    if (targetHash !== installedHash) {
      return {
        status: "dirty",
        reason: "target files differ from sync receipt",
        target: installRoot,
        targetPath,
        installedVersion,
        currentVersion,
        installedCommit,
        currentCommit,
        installedHash,
        currentHash: sourceHashValue
      };
    }
  }

  if (installedVersion !== currentVersion) {
    return {
      status: "version",
      reason: "skill frontmatter version changed",
      target: installRoot,
      targetPath,
      installedVersion,
      currentVersion: sourceVersion,
      installedCommit,
      currentCommit,
      installedHash,
      currentHash: sourceHashValue
    };
  }

  if (installedHash && installedHash !== sourceHashValue) {
    return {
      status: "behind",
      reason: "installed skill content hash differs from source",
      target: installRoot,
      targetPath,
      installedVersion,
      currentVersion,
      installedCommit,
      currentCommit,
      installedHash,
      currentHash: sourceHashValue
    };
  }

  if (!installedHash && installedCommit && currentCommit && installedCommit !== currentCommit) {
    return {
      status: "behind",
      reason: "installed receipt has no content hash and commit differs from repo HEAD",
      target: installRoot,
      targetPath,
      installedVersion,
      currentVersion,
      installedCommit,
      currentCommit,
      installedHash,
      currentHash: sourceHashValue
    };
  }

  if (!installedHash && (await targetDiffersFromSource(sourceSkillPath, targetPath))) {
    return {
      status: "dirty",
      reason: "target files differ from source and receipt has no content hash",
      target: installRoot,
      targetPath,
      installedVersion,
      currentVersion,
      installedCommit,
      currentCommit,
      installedHash,
      currentHash: sourceHashValue
    };
  }

  return {
    status: "current",
    reason: "installed skill matches source version and content hash",
    target: installRoot,
    targetPath,
    installedVersion,
    currentVersion,
    installedCommit,
    currentCommit,
    installedHash,
    currentHash: sourceHashValue
  };
}

async function readReceipt(installRoot) {
  const receiptPath = path.join(installRoot, RECEIPT_FILE);
  const emptyReceipt = { schema: SYNC_SCHEMA, installs: {} };

  try {
    const text = await readFile(receiptPath, "utf8");
    const record = JSON.parse(text);
    if (!isRecord(record)) {
      return {
        receipt: emptyReceipt,
        errors: [
          {
            code: "invalid_receipt",
            message: `Sync receipt ${receiptPath} must be a JSON object.`
          }
        ]
      };
    }
    if (record.installs !== undefined && !isRecord(record.installs)) {
      return {
        receipt: emptyReceipt,
        errors: [
          {
            code: "invalid_receipt",
            message: `Sync receipt ${receiptPath} has an invalid installs mapping.`
          }
        ]
      };
    }
    return {
      receipt: {
        ...record,
        installs: record.installs ?? {}
      },
      errors: []
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { receipt: emptyReceipt, errors: [] };
    }
    if (error instanceof SyntaxError) {
      return {
        receipt: emptyReceipt,
        errors: [
          {
            code: "invalid_receipt",
            message: `Sync receipt ${receiptPath} is not valid JSON.`
          }
        ]
      };
    }
    return {
      receipt: emptyReceipt,
      errors: [
        {
          code: "receipt_read_failed",
          message: `Unable to read sync receipt ${receiptPath}: ${error.message}`
        }
      ]
    };
  }
}

function resolveAssignmentInstallRoot(assignmentPath, kind) {
  const fields = PATH_FIELDS_BY_KIND[kind];
  if (!fields) {
    return null;
  }

  for (const field of fields) {
    const value = normalizeValue(assignmentPath[field]);
    if (value) {
      return value;
    }
  }
  return null;
}

async function targetDiffersFromSource(source, target) {
  try {
    const targetStats = await lstat(target);
    if (targetStats.isSymbolicLink()) {
      const link = await getSymlinkTarget(target);
      if (!link) {
        return true;
      }
      return path.resolve(link) !== path.resolve(source);
    }
  } catch {
    return true;
  }

  if (!(await isDirectory(target))) {
    return true;
  }

  const sourceEntries = await listFiles(source);
  const targetEntries = await listFiles(target);

  if (!arraysEqual(sourceEntries, targetEntries)) {
    return true;
  }

  for (const relative of sourceEntries) {
    const sourceFile = await readFile(path.join(source, relative));
    const targetFile = await readFile(path.join(target, relative));
    if (!buffersEqual(sourceFile, targetFile)) {
      return true;
    }
  }

  return false;
}

async function hashInstalledTarget(targetPath) {
  try {
    return await hashDirectory(targetPath);
  } catch {
    return null;
  }
}

async function getSymlinkTarget(target) {
  const linkPath = await readlinkSafe(target);
  if (!linkPath) {
    return null;
  }
  return path.resolve(path.dirname(target), linkPath);
}

async function readlinkSafe(target) {
  try {
    return await readlink(target);
  } catch {
    return null;
  }
}

function buffersEqual(left, right) {
  return left.compare(right) === 0;
}

async function skillVersion(skillPath) {
  const sourceSkill = await readFile(path.join(skillPath, "SKILL.md"), "utf8");
  return parseFrontmatterVersion(sourceSkill);
}

function parseFrontmatterVersion(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    return null;
  }

  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "---") {
      break;
    }
    if (trimmed.startsWith("version:")) {
      return trimmed.slice("version:".length).trim();
    }
  }

  return null;
}

async function hashDirectory(root) {
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

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

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

async function isDirectory(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function targetExists(candidate) {
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      return { exists: true, isSymbolicLink: true };
    }
    if (info.isDirectory()) {
      return { exists: true, isSymbolicLink: false };
    }
    return { exists: false, isSymbolicLink: false };
  } catch {
    return { exists: false, isSymbolicLink: false };
  }
}

async function readRepoCommit(sourceRoot) {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      cwd: sourceRoot,
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    const commit = result.stdout.trim();
    return commit.length > 0 ? commit : null;
  } catch {
    return null;
  }
}

function arraysEqual(left, right) {
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
