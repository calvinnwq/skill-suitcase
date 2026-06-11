import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadCatalog } from "./catalog.js";
import { plan, type PlanResult } from "./planner.js";
import {
  LEGACY_RECEIPT_FILE,
  LEGACY_RECEIPT_SCHEMA,
  RECEIPT_FILE,
  RECEIPT_SCHEMA
} from "./receipt.js";

type StatusValue = "current" | "behind" | "version" | "dirty" | "missing" | "unknown" | "blocked";
type StatusSummary = {
  current: number;
  behind: number;
  version: number;
  dirty: number;
  missing: number;
  unknown: number;
  blocked: number;
};
type StatusFinding = {
  code: string;
  message: string;
  path?: string;
  scope?: string;
  skill?: string;
  sourcePath?: string;
  targetPath?: string;
};
type StatusItem = {
  assignment: string;
  assignmentPath: string;
  kind: string;
  skill: string;
  status: StatusValue;
  target: string;
  targetPath: string;
  reason: string;
  installedVersion: string | null;
  currentVersion: string | null;
  installedCommit: string | null;
  currentCommit: string | null;
  installedHash: string | null;
  currentHash: string | null;
  variant?: string;
};
type StatusAssignment = {
  assignmentPath: string;
  assignment: string | null;
  kind: string | null;
  installRoot: string;
  statusCount: number;
  statuses: StatusItem[];
  errors: StatusFinding[];
};
type StatusResult = {
  ok: boolean;
  source: string;
  manifestPath: string;
  assignments: StatusAssignment[];
  statuses: StatusItem[];
  summary: StatusSummary;
  errors: StatusFinding[];
};
type StatusCheckResult = {
  status: StatusValue;
  reason: string;
  target: string;
  targetPath: string;
  installedVersion: string | null;
  currentVersion: string | null;
  installedCommit: string | null;
  currentCommit: string | null;
  installedHash: string | null;
  currentHash: string | null;
  errors: StatusFinding[];
};
type ReceiptReadingResult = {
  found: boolean;
  receipt: {
    schema: string;
    installs: ReceiptInstalls;
  };
  errors: StatusFinding[];
};
type ReceiptInstalls = Record<string, InstallRecord[]>;
type InstallRecord = {
  [key: string]: unknown;
  agent?: string;
  mode?: string;
  source?: string | ({ path: string } & Record<string, unknown>) | null;
  sourcePath?: string;
  targetPath?: string;
  target?: string;
  version?: string;
  sourceCommit?: string;
  sourceHash?: string;
  installedFiles?: InstalledFileRecord[] | null;
  priorState?: Record<string, unknown> | null;
  skill?: string;
};
type NormalizedInstallRecordResult = {
  record: InstallRecord | null;
  errors: StatusFinding[];
};
type InstalledFileRecord = {
  path?: string;
  hash?: string;
  [key: string]: unknown;
};

const PATH_FIELDS_BY_KIND = {
  "openclaw-skills-root": ["path"],
  "claude-skills-root": ["path"],
  "codex-home": ["skillsPath"],
  "nested-home-codex": ["skillsPath"]
} as const;
type AssignmentKind = keyof typeof PATH_FIELDS_BY_KIND;
type AssignmentPathField = (typeof PATH_FIELDS_BY_KIND)[AssignmentKind][number];
const INSTALL_RECORD_SCALAR_FIELDS = [
  "agent",
  "mode",
  "sourcePath",
  "targetPath",
  "version",
  "sourceCommit",
  "sourceHash"
] as const;
const VALID_STATUSES = new Set<StatusValue>(["current", "behind", "version", "dirty", "missing", "unknown", "blocked"]);
type PlanBlockedItem = {
  skill: string;
  reason?: string;
  variant?: string;
  [key: string]: unknown;
};

export async function status({ source }: { source: string }): Promise<StatusResult> {
  if (!source) {
    throw new Error("source is required");
  }

  const { manifestPath, sourceRoot, manifest } = await loadCatalog(source);
  const summary: StatusSummary = {
    current: 0,
    behind: 0,
    version: 0,
    dirty: 0,
    missing: 0,
    unknown: 0,
    blocked: 0
  };
  const assignments: StatusAssignment[] = [];
  const statuses: StatusItem[] = [];
  const errors: StatusFinding[] = [];

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
    const assignmentResult: StatusAssignment = {
      assignmentPath: assignmentPathId,
      assignment: null,
      kind: null,
      installRoot: "",
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

    const assignmentName = normalizeValue((assignmentPath as { assignment?: unknown }).assignment);
    const kind = normalizeValue((assignmentPath as { kind?: unknown }).kind);
    const installRoot = resolveAssignmentInstallRoot(assignmentPath, kind);

    assignmentResult.assignment = assignmentName;
    assignmentResult.kind = kind;
    assignmentResult.installRoot = installRoot ?? "";

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
      const pathField = kind && isSupportedKind(kind) ? PATH_FIELDS_BY_KIND[kind][0] : "kind";
      const assignmentError = {
        code: "invalid_assignment_path",
        message
      };
      assignmentResult.errors.push(assignmentError);
      errors.push({ ...assignmentError, path: `assignmentPaths.${assignmentPathId}.${pathField}` });
      assignments.push(assignmentResult);
      continue;
    }

    let assignmentPlan: PlanResult;
    try {
      assignmentPlan = await plan({ source: sourceRoot, target: assignmentName });
    } catch (error) {
      const assignmentError = {
        code: "plan_failed",
        message: `Unable to create install plan for ${assignmentName}: ${errorMessage(error)}`
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
      const pathField = isSupportedKind(kind) ? PATH_FIELDS_BY_KIND[kind][0] : "kind";
      assignmentResult.errors.push(assignmentError);
      errors.push({ ...assignmentError, path: `assignmentPaths.${assignmentPathId}.${pathField}` });
      assignments.push(assignmentResult);
      continue;
    }

    for (const blocked of assignmentPlan.blocked) {
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
      if (check.errors.length > 0) {
        assignmentResult.errors.push(...check.errors);
        errors.push(
          ...check.errors.map((item) => ({
            ...item,
            path: item.sourcePath ?? item.targetPath ?? planned.sourcePath
          }))
        );
      }

      const resultStatus: StatusItem = {
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

type BlockedStatusInput = {
  blocked: PlanBlockedItem;
  assignmentName: string;
  assignmentPathId: string;
  kind: string;
  installRoot: string;
};

function blockedStatusFromPlan({
  blocked,
  assignmentName,
  assignmentPathId,
  kind,
  installRoot
}: BlockedStatusInput): StatusItem {
  const targetPath = path.join(installRoot, blocked.skill);
  const status: StatusItem = {
    assignment: assignmentName,
    assignmentPath: assignmentPathId,
    kind,
    skill: blocked.skill,
    status: "blocked",
    target: installRoot,
    targetPath,
    reason: blocked.reason ?? "blocked",
    installedVersion: null,
    currentVersion: null,
    installedCommit: null,
    currentCommit: null,
    installedHash: null,
    currentHash: null
  };
  if (blocked.variant !== undefined) {
    status.variant = blocked.variant;
  }
  return status;
}

async function statusSkill({
  sourceRoot,
  sourceSkillPath,
  installRoot,
  skillName,
  installRecord
}: {
  sourceRoot: string;
  sourceSkillPath: string;
  installRoot: string;
  skillName: string;
  installRecord: InstallRecord | null;
}): Promise<StatusCheckResult> {
  const targetPath = path.join(installRoot, skillName);
  let sourceVersion: string | null;
  let sourceHashValue = "";
  try {
    sourceVersion = await skillVersion(sourceSkillPath);
    sourceHashValue = await hashDirectory(sourceSkillPath);
  } catch (error) {
    const currentCommit = await readRepoCommit(sourceRoot);
    return {
      status: "unknown",
      reason: `unable to read source skill: ${errorMessage(error)}`,
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
          message: `Unable to read source skill ${sourceSkillPath}: ${errorMessage(error)}`,
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
      currentHash: sourceHashValue,
      errors: []
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
      currentHash: sourceHashValue,
      errors: []
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
        currentHash: sourceHashValue,
        errors: []
      };
    }
  }

  if (installedHash && !targetIsSourceSymlink) {
    let targetHash: string;
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
        currentHash: sourceHashValue,
        errors: []
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
      currentHash: sourceHashValue,
      errors: []
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
      currentHash: sourceHashValue,
      errors: []
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
      currentHash: sourceHashValue,
      errors: []
    };
  }

  let targetDiffers = false;
  if (!installedHash) {
    try {
      targetDiffers = await targetDiffersFromSource(sourceSkillPath, targetPath);
    } catch (error) {
      return {
        status: "unknown",
        reason: `unable to read target skill: ${errorMessage(error)}`,
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
            message: `Unable to read target skill ${targetPath}: ${errorMessage(error)}`,
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
      currentHash: sourceHashValue,
      errors: []
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
    currentHash: sourceHashValue,
    errors: []
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
}: {
  error: unknown;
  sourceVersion: string | null;
  sourceHashValue: string;
  currentCommit: string | null;
  installRoot: string;
  targetPath: string;
  skillName: string;
  installedVersion?: string | null;
  installedHash?: string | null;
  installedCommit?: string | null;
}): StatusCheckResult {
  return {
    status: "unknown",
    reason: `unable to read target skill: ${errorMessage(error)}`,
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
          message: `Unable to read target skill ${targetPath}: ${errorMessage(error)}`,
          skill: skillName,
          targetPath
        }
    ]
  };
}

async function readReceipt(installRoot: string): Promise<{ receipt: { schema: string; installs: ReceiptInstalls }; errors: StatusFinding[]; receiptPath: string }> {
  const receiptPath = path.join(installRoot, RECEIPT_FILE);
  const legacyReceiptPath = path.join(installRoot, LEGACY_RECEIPT_FILE);
  const emptyReceipt = { schema: RECEIPT_SCHEMA, installs: {} as ReceiptInstalls };

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

type ReadReceiptFileInput = {
  legacy: boolean;
};
async function readReceiptFile(receiptPath: string, { legacy }: ReadReceiptFileInput): Promise<ReceiptReadingResult> {
  const emptyReceipt = { schema: RECEIPT_SCHEMA, installs: {} as ReceiptInstalls };
  try {
    const text = await readFile(receiptPath, "utf8");
    const record = JSON.parse(text) as unknown;
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
        schema: RECEIPT_SCHEMA,
        installs: normalized.installs
      },
      errors: normalized.errors
    };
  } catch (error) {
    const maybeNodeError = error as { code?: string };
    if (maybeNodeError.code === "ENOENT") {
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
          message: `Unable to read suitcase receipt ${receiptPath}: ${errorMessage(error)}`
        }
      ]
    };
  }
}

function normalizeLegacyReceipt(record: Record<string, unknown>): { receipt: { schema: string; installs: ReceiptInstalls; [key: string]: unknown }; errors: StatusFinding[] } {
  const normalized = {
    ...record,
    schema: RECEIPT_SCHEMA,
    installs: {} as ReceiptInstalls
  };
  const normalizedEntries = normalizeReceiptInstalls(record.installs, {
    receiptPath: "legacy suitcase receipt"
  });
  normalized.installs = normalizedEntries.installs;
  return { receipt: normalized, errors: normalizedEntries.errors };
}

function normalizeReceiptInstalls(
  installs: unknown,
  { receiptPath }: { receiptPath: string }
): { installs: ReceiptInstalls; errors: StatusFinding[] } {
  const normalized: ReceiptInstalls = {};
  const errors: StatusFinding[] = [];
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
    const normalizedEntries: InstallRecord[] = [];
    for (const entry of entries) {
    const normalizedEntry = normalizeReceiptInstallRecord(entry, { skillName });
    if (normalizedEntry.errors.length > 0) {
      errors.push(...normalizedEntry.errors.map((item) => ({ ...item, skill: skillName })));
      continue;
    }
    const { record } = normalizedEntry;
    if (record === null) {
      continue;
    }
    normalizedEntries.push(record);
    }
    if (normalizedEntries.length > 0) {
      normalized[skillName] = normalizedEntries;
    }
  }

  return { installs: normalized, errors };
}

function normalizeReceiptInstallRecord(
  installRecord: unknown,
  { skillName }: { skillName: string }
): NormalizedInstallRecordResult {
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
      : normalizeValue(source))
    ?? undefined;
  const mode = normalizeValue(installRecord.mode) ?? undefined;
  const target = normalizeValue(installRecord.target) ?? undefined;
  const targetPath = normalizeValue(installRecord.targetPath) ?? undefined;
  const version = normalizeValue(installRecord.version) ?? undefined;
  const sourceCommit = normalizeValue(installRecord.sourceCommit) ?? undefined;
  const sourceHash = normalizeValue(installRecord.sourceHash) ?? undefined;
  const installedFiles = Array.isArray(installRecord.installedFiles) ? installRecord.installedFiles : null;
  const priorState = isRecord(installRecord.priorState) ? installRecord.priorState : null;
  const agent = normalizeValue(installRecord.agent) ?? undefined;
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

  if (sourcePath === undefined || mode === undefined || targetPath === undefined || agent === undefined) {
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

  const normalizedSourcePath = sourcePath;
  const normalizedMode = mode;
  const normalizedTargetPath = targetPath;
  const normalizedAgent = agent;

  const invalidScalarField = Array.from(INSTALL_RECORD_SCALAR_FIELDS).find((field) => {
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

  const sourceRecord = isRecord(installRecord.source)
    ? ({
      ...(installRecord.source as Record<string, unknown>),
      path: source ?? normalizedSourcePath
    } as ({ path: string } & Record<string, unknown>))
    : {
      path: source ?? normalizedSourcePath
    };

  const canonical: InstallRecord = {
    ...installRecord,
    skill: canonicalSkill,
    mode: normalizedMode,
    sourcePath: normalizedSourcePath,
    targetPath: normalizedTargetPath,
    installedFiles: normalizedInstalledFiles.files,
    priorState,
    source: sourceRecord,
    agent: normalizedAgent
  };
  if (target !== undefined) {
    canonical.target = target;
  }
  if (version !== undefined) {
    canonical.version = version;
  }
  if (sourceCommit !== undefined) {
    canonical.sourceCommit = sourceCommit;
  }
  if (sourceHash !== undefined) {
    canonical.sourceHash = sourceHash;
  }

  return {
    record: canonical,
    errors: []
  };
}

function validateInstalledFiles(
  installedFiles: unknown,
  { skillName }: { skillName: string }
): { files: InstalledFileRecord[] | null; errors: StatusFinding[] } {
  if (installedFiles === null || installedFiles === undefined) {
    return { files: null, errors: [] };
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
    files: installedFiles as InstalledFileRecord[],
    errors: []
  };
}

function selectInstallRecord({
  installRecords,
  installRoot,
  skillName,
  receiptPath
}: {
  installRecords: unknown;
  installRoot: string;
  skillName: string;
  receiptPath: string;
}): { installRecord: InstallRecord | null; errors: StatusFinding[] } {
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

  const normalizedRootPath = path.resolve(installRoot);
  const normalizedSkillTarget =
    normalizeValue(path.join(normalizedRootPath, skillName));
  const matching: InstallRecord[] = [];

  for (const entry of installRecords) {
    if (!isRecord(entry)) {
      continue;
    }
    const candidate = normalizeValue(entry.targetPath);
    if (!candidate) {
      continue;
    }
    const resolvedCandidate = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(normalizedRootPath, candidate);
    const normalizedCandidate = normalizeValue(resolvedCandidate);
    if (
      normalizedCandidate === normalizedRootPath ||
      (normalizedSkillTarget !== null && normalizedCandidate === normalizedSkillTarget)
    ) {
      matching.push(entry as InstallRecord);
    }
  }

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
    const [matchingRecord] = matching;
    return { installRecord: matchingRecord ?? null, errors: [] };
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
function resolveAssignmentInstallRoot(assignmentPath: Record<string, unknown>, kind: string | null): string | null {
  if (!isSupportedKind(kind)) {
    return null;
  }
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

async function targetDiffersFromSource(source: string, target: string): Promise<boolean> {
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

async function hashInstalledTarget(targetPath: string): Promise<string> {
  return hashDirectory(targetPath);
}

async function getSymlinkTarget(target: string): Promise<string | null> {
  const linkPath = await readlinkSafe(target);
  if (!linkPath) {
    return null;
  }
  return path.resolve(path.dirname(target), linkPath);
}

async function readlinkSafe(target: string): Promise<string | null> {
  try {
    return await readlink(target);
  } catch {
    return null;
  }
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.compare(right) === 0;
}

async function skillVersion(skillPath: string): Promise<string | null> {
  const sourceSkill = await readFile(path.join(skillPath, "SKILL.md"), "utf8");
  return parseFrontmatterVersion(sourceSkill);
}

function parseFrontmatterVersion(text: string): string | null {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    return null;
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "---") {
      break;
    }
    if (trimmed.startsWith("version:")) {
      return trimmed.slice("version:".length).trim();
    }
  }

  return null;
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

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

type TargetExistsResult = {
  exists: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  error?: unknown;
};
async function targetExists(candidate: string): Promise<TargetExistsResult> {
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
    const maybeFsError = error as { code?: string };
    if (maybeFsError.code === "ENOENT") {
      return { exists: false, isDirectory: false, isSymbolicLink: false };
    }
    return { exists: false, isDirectory: false, isSymbolicLink: false, error };
  }
}

async function readRepoCommit(sourceRoot: string): Promise<string | null> {
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

function arraysEqual(left: string[], right: string[]): boolean {
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

function isSupportedKind(value: string | null): value is AssignmentKind {
  return value !== null && Object.hasOwn(PATH_FIELDS_BY_KIND, value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "An unexpected error occurred";
}
