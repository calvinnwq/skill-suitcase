import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadCatalog } from "./catalog.js";
import { plan } from "./planner.js";
import {
  LEGACY_RECEIPT_FILE,
  LEGACY_RECEIPT_SCHEMA,
  RECEIPT_FILE,
  RECEIPT_SCHEMA
} from "./receipt.js";

const PATH_FIELDS_BY_KIND = {
  "openclaw-skills-root": ["path"],
  "claude-skills-root": ["path"],
  "codex-home": ["skillsPath"],
  "nested-home-codex": ["skillsPath"]
};
const INSTALL_RECORD_SCALAR_FIELDS = [
  "agent",
  "mode",
  "sourcePath",
  "targetPath",
  "version",
  "sourceCommit",
  "sourceHash"
];
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

    if (!(await isDirectory(installRoot))) {
      const assignmentError = {
        code: "missing_install_root",
        message: `Assignment path ${assignmentPathId} points at missing install root: ${installRoot}.`
      };
      const pathField = PATH_FIELDS_BY_KIND[kind]?.[0] ?? "kind";
      assignmentResult.errors.push(assignmentError);
      errors.push({ ...assignmentError, path: `assignmentPaths.${assignmentPathId}.${pathField}` });
      assignments.push(assignmentResult);
      continue;
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
    const receiptPath = receiptResult.receiptPath;
    if (receiptResult.errors.length > 0) {
      assignmentResult.errors.push(...receiptResult.errors);
      errors.push(
        ...receiptResult.errors.map((item) => ({
          ...item,
          path: receiptPath
        }))
      );
    }

    for (const planned of assignmentPlan.planned) {
      const installRecordResult = selectInstallRecord({
        installRecords: receipt.installs?.[planned.skill],
        installRoot,
        skillName: planned.skill,
        receiptPath
      });
      if (installRecordResult.errors.length > 0) {
        assignmentResult.errors.push(...installRecordResult.errors);
        errors.push(
          ...installRecordResult.errors.map((item) => ({
            ...item,
            path: receiptPath
          }))
        );
      }

      const check = await statusSkill({
        sourceRoot,
        sourceSkillPath: planned.sourcePath,
        installRoot,
        skillName: planned.skill,
        installRecord: installRecordResult.installRecord
      });
      if ((check.errors ?? []).length > 0) {
        assignmentResult.errors.push(...check.errors);
        errors.push(
          ...check.errors.map((item) => ({
            ...item,
            path: item.sourcePath ?? item.targetPath ?? planned.sourcePath
          }))
        );
      }

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
  let sourceVersion;
  let sourceHashValue;
  try {
    sourceVersion = await skillVersion(sourceSkillPath);
    sourceHashValue = await hashDirectory(sourceSkillPath);
  } catch (error) {
    const currentCommit = await readRepoCommit(sourceRoot);
    return {
      status: "unknown",
      reason: `unable to read source skill: ${error.message}`,
      target: installRoot,
      targetPath,
      installedVersion: null,
      currentVersion: null,
      installedCommit: null,
      currentCommit,
      installedHash: null,
      currentHash: null,
      errors: [
        {
          code: "source_read_failed",
          message: `Unable to read source skill ${sourceSkillPath}: ${error.message}`,
          skill: skillName,
          sourcePath: sourceSkillPath
        }
      ]
    };
  }
  const installExists = await targetExists(targetPath);
  const currentCommit = await readRepoCommit(sourceRoot);

  if (installExists.error) {
    return targetReadFailureStatus({
      error: installExists.error,
      sourceVersion,
      sourceHashValue,
      currentCommit,
      installRoot,
      targetPath,
      skillName
    });
  }

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

  if (!installExists.isDirectory && !installExists.isSymbolicLink) {
    return {
      status: "unknown",
      reason: "target skill path exists but is not a directory or symlink",
      target: installRoot,
      targetPath,
      installedVersion: null,
      currentVersion: sourceVersion,
      installedCommit: null,
      currentCommit,
      installedHash: null,
      currentHash: sourceHashValue,
      errors: [
        {
          code: "invalid_target",
          message: `Target skill path ${targetPath} exists but is not a directory or symlink.`,
          skill: skillName,
          targetPath
        }
      ]
    };
  }

  if (!installRecord) {
    return {
      status: "unknown",
      reason: "target exists but has no Suitcase receipt",
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
  let targetIsSourceSymlink = false;

  if (installExists.isSymbolicLink) {
    const link = await getSymlinkTarget(targetPath);
    targetIsSourceSymlink = link !== null && path.resolve(link) === path.resolve(sourceSkillPath);
    if (!targetIsSourceSymlink) {
      return {
        status: "dirty",
        reason: "target symlink differs from source",
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

  if (installedHash && !targetIsSourceSymlink) {
    let targetHash;
    try {
      targetHash = await hashInstalledTarget(targetPath);
    } catch (error) {
      return targetReadFailureStatus({
        error,
        sourceVersion,
        sourceHashValue,
        currentCommit,
        installRoot,
        targetPath,
        skillName,
        installedVersion,
        installedHash,
        installedCommit
      });
    }
    if (targetHash !== installedHash) {
      return {
        status: "dirty",
        reason: "target files differ from receipt",
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

  let targetDiffers = false;
  if (!installedHash) {
    try {
      targetDiffers = await targetDiffersFromSource(sourceSkillPath, targetPath);
    } catch (error) {
      return {
        status: "unknown",
        reason: `unable to read target skill: ${error.message}`,
        target: installRoot,
        targetPath,
        installedVersion,
        currentVersion,
        installedCommit,
        currentCommit,
        installedHash,
        currentHash: sourceHashValue,
        errors: [
          {
            code: "target_read_failed",
            message: `Unable to read target skill ${targetPath}: ${error.message}`,
            skill: skillName,
            targetPath
          }
        ]
      };
    }
  }

  if (!installedHash && targetDiffers) {
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

function targetReadFailureStatus({
  error,
  sourceVersion,
  sourceHashValue,
  currentCommit,
  installRoot,
  targetPath,
  skillName,
  installedVersion = null,
  installedHash = null,
  installedCommit = null
}) {
  return {
    status: "unknown",
    reason: `unable to read target skill: ${error.message}`,
    target: installRoot,
    targetPath,
    installedVersion,
    currentVersion: sourceVersion,
    installedCommit,
    currentCommit,
    installedHash,
    currentHash: sourceHashValue,
    errors: [
      {
        code: "target_read_failed",
        message: `Unable to read target skill ${targetPath}: ${error.message}`,
        skill: skillName,
        targetPath
      }
    ]
  };
}

async function readReceipt(installRoot) {
  const receiptPath = path.join(installRoot, RECEIPT_FILE);
  const legacyReceiptPath = path.join(installRoot, LEGACY_RECEIPT_FILE);
  const emptyReceipt = { schema: RECEIPT_SCHEMA, installs: {} };

  const modernReceipt = await readReceiptFile(receiptPath, { legacy: false });
  if (modernReceipt.found) {
    return { receipt: modernReceipt.receipt, errors: modernReceipt.errors, receiptPath };
  }

  const legacyReceipt = await readReceiptFile(legacyReceiptPath, { legacy: true });
  if (legacyReceipt.found) {
    return { receipt: legacyReceipt.receipt, errors: legacyReceipt.errors, receiptPath: legacyReceiptPath };
  }

  return { receipt: emptyReceipt, errors: [], receiptPath };
}

async function readReceiptFile(receiptPath, { legacy }) {
  const emptyReceipt = { schema: RECEIPT_SCHEMA, installs: {} };
  try {
    const text = await readFile(receiptPath, "utf8");
    const record = JSON.parse(text);
    if (!isRecord(record)) {
      return {
        found: true,
        receipt: emptyReceipt,
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt ${receiptPath} must be a JSON object.`
          }
        ]
      };
    }

    if (legacy) {
      if (record.schema !== LEGACY_RECEIPT_SCHEMA) {
        return {
          found: true,
          receipt: emptyReceipt,
          errors: [
            {
              code: "invalid_receipt",
              message: `Suitcase receipt ${receiptPath} has an unsupported legacy schema.`
            }
          ]
        };
      }
      const legacyReceipt = normalizeLegacyReceipt(record);
      return {
        found: true,
        receipt: legacyReceipt.receipt,
        errors: legacyReceipt.errors
      };
    }

    if (record.schema !== RECEIPT_SCHEMA) {
      return {
        found: true,
        receipt: emptyReceipt,
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt ${receiptPath} has an unsupported schema.`
          }
        ]
      };
    }

    const normalized = normalizeReceiptInstalls(record.installs, { receiptPath });
    return {
      found: true,
      receipt: {
        ...record,
        installs: normalized.installs
      },
      errors: normalized.errors
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { found: false, receipt: emptyReceipt, errors: [] };
    }
    if (error instanceof SyntaxError) {
      return {
        found: true,
        receipt: emptyReceipt,
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt ${receiptPath} is not valid JSON.`
          }
        ]
      };
    }
    return {
      found: true,
      receipt: emptyReceipt,
      errors: [
        {
          code: "receipt_read_failed",
          message: `Unable to read suitcase receipt ${receiptPath}: ${error.message}`
        }
      ]
    };
  }
}

function normalizeLegacyReceipt(record) {
  const normalized = {
    ...record,
    schema: RECEIPT_SCHEMA,
    installs: {}
  };
  const normalizedEntries = normalizeReceiptInstalls(record.installs, {
    receiptPath: "legacy suitcase receipt"
  });
  normalized.installs = normalizedEntries.installs;
  return { receipt: normalized, errors: normalizedEntries.errors };
}

function normalizeReceiptInstalls(installs, { receiptPath }) {
  const normalized = {};
  const errors = [];
  if (installs === undefined) {
    return { installs: normalized, errors };
  }
  if (!isRecord(installs)) {
    errors.push({
      code: "invalid_receipt",
      message: `Suitcase receipt ${receiptPath} has an invalid installs mapping.`
    });
    return { installs: normalized, errors };
  }

  for (const [skillName, installEntries] of Object.entries(installs)) {
    const entries = Array.isArray(installEntries) ? installEntries : [installEntries];
    const normalizedEntries = [];
    for (const entry of entries) {
      const normalizedEntry = normalizeReceiptInstallRecord(entry, { skillName });
      if (normalizedEntry.errors.length > 0) {
        errors.push(...normalizedEntry.errors.map((item) => ({ ...item, skill: skillName })));
        continue;
      }
      normalizedEntries.push(normalizedEntry.record);
    }
    if (normalizedEntries.length > 0) {
      normalized[skillName] = normalizedEntries;
    }
  }

  return { installs: normalized, errors };
}

function normalizeReceiptInstallRecord(installRecord, { skillName }) {
  if (!isRecord(installRecord)) {
    return {
      record: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt has an invalid install record for ${skillName}.`
        }
      ]
    };
  }

  const source = normalizeValue(installRecord.source);
  const sourcePath =
    normalizeValue(installRecord.sourcePath) ??
    (isRecord(installRecord.source)
      ? normalizeValue(installRecord.source.path)
      : normalizeValue(source));
  const mode = normalizeValue(installRecord.mode);
  const target = normalizeValue(installRecord.target);
  const targetPath = normalizeValue(installRecord.targetPath);
  const version = normalizeValue(installRecord.version);
  const sourceCommit = normalizeValue(installRecord.sourceCommit);
  const sourceHash = normalizeValue(installRecord.sourceHash);
  const installedFiles = Array.isArray(installRecord.installedFiles) ? installRecord.installedFiles : null;
  const priorState = isRecord(installRecord.priorState) ? installRecord.priorState : null;
  const agent = normalizeValue(installRecord.agent);
  const canonicalSkill = normalizeValue(installRecord.skill) ?? skillName;

  const requiredField = ["agent", "mode", "sourcePath", "targetPath"].find((field) => {
    const value = {
      agent,
      mode,
      sourcePath,
      targetPath
    }[field];
    return typeof value !== "string" || value.length === 0;
  });
  if (requiredField) {
    return {
      record: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt has an invalid ${requiredField} field for ${skillName}.`
        }
      ]
    };
  }

  const invalidScalarField = INSTALL_RECORD_SCALAR_FIELDS.find((field) => {
    const value = installRecord[field];
    if (value === undefined || value === null) {
      return false;
    }
    return typeof value !== "string";
  });
  if (invalidScalarField) {
    return {
      record: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt has an invalid ${invalidScalarField} field for ${skillName}.`
        }
      ]
    };
  }

  const hasProvenance = [version, sourceCommit, sourceHash].some(
    (value) => typeof value === "string" && value.length > 0
  );
  if (!hasProvenance) {
    return {
      record: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt has no source provenance for ${skillName}.`
        }
      ]
    };
  }

  if (installRecord.source !== undefined) {
    if (isRecord(installRecord.source)) {
      if (!normalizeValue(installRecord.source.path)) {
        return {
          record: null,
          errors: [
            {
              code: "invalid_receipt",
              message: `Suitcase receipt has an invalid source.path for ${skillName}.`
            }
          ]
        };
      }
    } else if (typeof installRecord.source !== "string" && installRecord.source !== null) {
      return {
        record: null,
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt has an invalid source for ${skillName}.`
          }
        ]
      };
    }
    if (typeof installRecord.source === "string" && normalizeValue(installRecord.source) === null) {
      return {
        record: null,
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt has an invalid source for ${skillName}.`
          }
        ]
      };
    }
  }

  const normalizedInstalledFiles = validateInstalledFiles(installRecord.installedFiles, {
    skillName
  });
  if (normalizedInstalledFiles.errors.length > 0) {
    return {
      record: null,
      errors: normalizedInstalledFiles.errors
    };
  }

  if (installRecord.priorState !== undefined && !isRecord(installRecord.priorState)) {
    return {
      record: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt has an invalid priorState for ${skillName}.`
        }
      ]
    };
  }

  const sourceRecord = source
    ? isRecord(installRecord.source)
      ? installRecord.source
      : { path: source }
    : { path: sourcePath };

  const canonical = {
    ...installRecord,
    skill: canonicalSkill,
    mode,
    sourcePath,
    target,
    targetPath,
    version,
    sourceCommit,
    sourceHash,
    installedFiles: normalizedInstalledFiles.files,
    priorState,
    source: sourceRecord,
    agent
  };

  return {
    record: canonical,
    errors: []
  };
}

function validateInstalledFiles(installedFiles = [], { skillName }) {
  if (installedFiles === null || installedFiles === undefined) {
    return { files: installedFiles, errors: [] };
  }
  if (!Array.isArray(installedFiles)) {
    return {
      files: [],
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt has invalid installedFiles for ${skillName}.`
        }
      ]
    };
  }

  for (const file of installedFiles) {
    if (!isRecord(file)) {
      return {
        files: [],
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt has invalid installedFiles for ${skillName}.`
          }
        ]
      };
    }
    if (normalizeValue(file.path) === null) {
      return {
        files: [],
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt has invalid installedFiles for ${skillName}.`
          }
        ]
      };
    }
    if (file.hash !== undefined && normalizeValue(file.hash) === null) {
      return {
        files: [],
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt has invalid installedFiles for ${skillName}.`
          }
        ]
      };
    }
  }

  return {
    files: installedFiles,
    errors: []
  };
}

function selectInstallRecord({ installRecords, installRoot, skillName, receiptPath }) {
  if (installRecords === undefined) {
    return { installRecord: null, errors: [] };
  }

  if (!Array.isArray(installRecords)) {
    return {
      installRecord: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt ${receiptPath} has an invalid install record for ${skillName}.`
        }
      ]
    };
  }

  const normalizedRoot = normalizeValue(installRoot);
  const normalizedRootPath = normalizedRoot ? path.resolve(normalizedRoot) : null;
  const normalizedSkillTarget =
    installRoot && skillName ? normalizeValue(path.join(normalizedRootPath, skillName)) : null;
  const matching = installRecords.filter(
    (record) => {
      const candidate = normalizeValue(record?.targetPath);
      if (!candidate) {
        return false;
      }
      const resolvedCandidate = path.isAbsolute(candidate)
        ? path.resolve(candidate)
        : path.resolve(normalizedRootPath ?? "", candidate);
      const normalizedCandidate = normalizeValue(resolvedCandidate);
      return (
        normalizedCandidate === normalizedRootPath ||
        (normalizedSkillTarget !== null && normalizedCandidate === normalizedSkillTarget)
      );
    }
  );

  if (matching.length > 1) {
    return {
      installRecord: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt ${receiptPath} has ambiguous install records for ${skillName} at ${installRoot}.`
        }
      ]
    };
  }

  if (matching.length === 1) {
    return { installRecord: matching[0], errors: [] };
  }

  return {
    installRecord: null,
    errors: [
      {
        code: "invalid_receipt",
        message: `Suitcase receipt ${receiptPath} has no matching install record for ${skillName} at ${installRoot}.`
      }
    ]
  };
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
  return hashDirectory(targetPath);
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
      return { exists: true, isDirectory: false, isSymbolicLink: true };
    }
    if (info.isDirectory()) {
      return { exists: true, isDirectory: true, isSymbolicLink: false };
    }
    return { exists: true, isDirectory: false, isSymbolicLink: false };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, isDirectory: false, isSymbolicLink: false };
    }
    return { exists: false, isDirectory: false, isSymbolicLink: false, error };
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
