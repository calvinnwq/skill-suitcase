import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadCatalog, type TargetOverrides } from "../catalog/index.js";
import { resolveTargetRegistryEntries } from "../catalog/target-registry.js";
import { plan, type PlanResult } from "../planning/index.js";
import {
  classifySymlinkInstall,
  SYMLINK_MODE,
  type SymlinkInstallState
} from "../install-modes.js";
import { readSkillVersion } from "../skill-metadata.js";
import { resolvePlatformInstallRoot } from "../platform-adapters.js";
import {
  loadUpstreamLock,
  upstreamLineage,
  type UpstreamLineage
} from "../upstream/index.js";
import {
  collectSourcePolicyDeniedPaths,
  sourcePolicyDecision,
  sourcePolicyHasExcludePatterns,
  sourcePolicyPrunesDirectory,
  type SourcePolicy
} from "../source-policy.js";
import { validateHermesExternalRoot } from "../hermes-external-root.js";
import {
  externalProjectionsForTarget,
  findUndeclaredDirectorySymlinks,
  inspectExternalProjections,
  type ExternalProjectionInspection
} from "../external-projections.js";
import { isCaseInsensitiveFilesystem } from "../filesystem-comparison.js";
import {
  errorMessage,
  isRecord,
  normalizeValue,
  readReceipt,
  selectInstallRecord,
  type InstalledFileRecord,
  type InstallRecord,
  type StatusFinding
} from "./receipt-state.js";

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
type StatusItem = {
  assignment: string;
  assignmentPath: string;
  kind: string;
  skill: string;
  status: StatusValue;
  target: string;
  targetPath: string;
  destination: string;
  reason: string;
  installedVersion: string | null;
  currentVersion: string | null;
  installedCommit: string | null;
  currentCommit: string | null;
  installedHash: string | null;
  currentHash: string | null;
  lineage?: StatusLineage;
  variant?: string;
};
type StatusLineage = Omit<UpstreamLineage, "target"> & {
  target: {
    status: StatusValue;
    receiptHash: string | null;
    receiptCommit: string | null;
  };
};
type StatusAssignment = {
  assignmentPath: string;
  assignment: string | null;
  kind: string | null;
  installRoot: string;
  statusCount: number;
  statuses: StatusItem[];
  externalProjections: ExternalProjectionInspection[];
  errors: StatusFinding[];
};
type StatusResult = {
  ok: boolean;
  source: string;
  manifestPath: string;
  assignments: StatusAssignment[];
  statuses: StatusItem[];
  externalProjections: ExternalProjectionInspection[];
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
type StatusLineageResult = {
  lineageBySkill: Map<string, Omit<UpstreamLineage, "target">>;
  errors: StatusFinding[];
};
const VALID_STATUSES = new Set<StatusValue>(["current", "behind", "version", "dirty", "missing", "unknown", "blocked"]);
type PlanBlockedItem = {
  skill: string;
  destination: string;
  reason?: string;
  variant?: string;
  [key: string]: unknown;
};

export async function status({
  source,
  target,
  targetOverrides
}: {
  source: string;
  target?: string | undefined;
  targetOverrides?: TargetOverrides | undefined;
}): Promise<StatusResult> {
  if (!source) {
    throw new Error("source is required");
  }

  const { manifestPath, sourceRoot, manifest } = await loadCatalog(source, { targetOverrides });
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
  const externalProjections: ExternalProjectionInspection[] = [];
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
      externalProjections,
      summary,
      errors
    };
  }
  const registryEntries = resolveTargetRegistryEntries(manifest, targetOverrides);
  const statusLineage = createStatusLineageLoader(sourceRoot, errors);
  const exactTargetExists = target !== undefined &&
    target.trim().length > 0 &&
    registryEntries.some((entry) => entry.id === target);

  for (const registryEntry of registryEntries) {
    const assignmentPathId = registryEntry.id;
    const assignmentPath = registryEntry.assignmentPath;
    if (!shouldIncludeAssignmentPath({ target, exactTargetExists, assignmentPathId, assignmentPath })) {
      continue;
    }
    const assignmentResult: StatusAssignment = {
      assignmentPath: assignmentPathId,
      assignment: null,
      kind: null,
      installRoot: "",
      statusCount: 0,
      statuses: [],
      externalProjections: [],
      errors: []
    };

    const assignmentName = normalizeValue((assignmentPath as { assignment?: unknown }).assignment);
    const kind = normalizeValue((assignmentPath as { kind?: unknown }).kind);
    const rootResolution = resolvePlatformInstallRoot({ kind, assignmentPath });
    const installRoot = rootResolution.installRoot;

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

    if (registryEntry.readOnly && !manifest.assignments[assignmentName]) {
      assignments.push(assignmentResult);
      continue;
    }

    if (!kind || !installRoot) {
      const message = kind
        ? `Assignment path ${assignmentPathId} is missing required install-root field.`
        : `Assignment path ${assignmentPathId} is missing or uses an unsupported kind.`;
      const pathField = rootResolution.adapter?.installRootField ?? rootResolution.missingFields[0] ?? "kind";
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
      assignmentPlan = await plan({ source: sourceRoot, target: assignmentName, assignmentPath: assignmentPathId });
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
      const pathField = rootResolution.adapter?.installRootField ?? "kind";
      assignmentResult.errors.push(assignmentError);
      errors.push({ ...assignmentError, path: `assignmentPaths.${assignmentPathId}.${pathField}` });
      assignments.push(assignmentResult);
      continue;
    }

    const declaredExternalProjections = externalProjectionsForTarget(
      manifest.externalProjections,
      assignmentPathId
    );
    const projectionInspections = await inspectExternalProjections({
      installRoot,
      projections: declaredExternalProjections,
      ...(targetOverrides?.home !== undefined ? { homeDirectory: targetOverrides.home } : {})
    });
    assignmentResult.externalProjections.push(...projectionInspections);
    externalProjections.push(...projectionInspections);

    if (kind === "hermes-external-skills-root") {
      const home = registryEntry.home;
      if (home === null) {
        const assignmentError = {
          code: "invalid_assignment_path",
          message: `Categorized Hermes target ${assignmentPathId} is missing its explicit home.`
        };
        assignmentResult.errors.push(assignmentError);
        errors.push({ ...assignmentError, path: `assignmentPaths.${assignmentPathId}.home` });
        assignments.push(assignmentResult);
        continue;
      }
      const boundaryErrors = await validateHermesExternalRoot({
        home,
        installRoot,
        planned: assignmentPlan.planned,
        externalProjections: declaredExternalProjections,
        externalProjectionInspections: projectionInspections,
        ...(targetOverrides?.home !== undefined ? { homeDirectory: targetOverrides.home } : {})
      });
      if (boundaryErrors.length > 0) {
        assignmentResult.errors.push(...boundaryErrors);
        errors.push(...boundaryErrors);
        assignments.push(assignmentResult);
        continue;
      }
    } else {
      const projectionErrors: StatusFinding[] = [];
      try {
        const undeclaredSymlinks = await findUndeclaredDirectorySymlinks({
          installRoot,
          declaredTargetPaths: [
            ...assignmentPlan.planned.map((plannedSkill) => path.resolve(installRoot, plannedSkill.destination)),
            ...projectionInspections
              .map((inspection) => inspection.targetPath)
              .filter((targetPath): targetPath is string => targetPath !== null)
          ]
        });
        projectionErrors.push(...undeclaredSymlinks.map((targetPath) => ({
          code: "external_projection_undeclared_symlink",
          message: `Undeclared directory symlink ${targetPath} blocks catalog status.`
        })));
      } catch (error) {
        projectionErrors.push({
          code: "external_projection_inspection_failed",
          message: `External projection safety inspection failed: ${errorMessage(error)}`
        });
      }
      projectionErrors.push(
        ...projectionInspections
          .filter((inspection) => inspection.state !== "external-current")
          .map((inspection) => ({
            code: inspection.state,
            message: inspection.reason,
            skill: inspection.skill
          }))
      );
      assignmentResult.errors.push(...projectionErrors);
      errors.push(...projectionErrors);
      if (projectionErrors.length > 0) {
        assignments.push(assignmentResult);
        continue;
      }
    }

    const upstreamLineageBySkill = await statusLineage.load([
      ...assignmentPlan.blocked.map((item) => item.skill),
      ...assignmentPlan.planned.map((item) => item.skill)
    ]);

    for (const blocked of assignmentPlan.blocked) {
      const blockedStatus = blockedStatusFromPlan({
        blocked,
        assignmentName,
        assignmentPathId,
        kind,
        installRoot
      });
      attachStatusLineage(blockedStatus, upstreamLineageBySkill.get(blocked.skill), {
        receiptHash: null,
        receiptCommit: null
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

    const installRootCaseInsensitive = await isCaseInsensitiveFilesystem(installRoot);
    for (const planned of assignmentPlan.planned) {
      const installRecordResult = selectInstallRecord({
        installRecords: receipt.installs?.[planned.skill],
        installRoot,
        skillName: planned.skill,
        receiptPath,
        targetPath: path.join(installRoot, planned.destination),
        destination: planned.destination,
        caseInsensitive: installRootCaseInsensitive
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
        installRecord: installRecordResult.installRecord,
        sourcePolicy: manifest.sourcePolicy,
        destination: planned.destination
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
        destination: planned.destination,
        reason: check.reason,
        installedVersion: check.installedVersion,
        currentVersion: check.currentVersion,
        installedCommit: check.installedCommit,
        currentCommit: check.currentCommit,
        installedHash: check.installedHash,
        currentHash: check.currentHash,
        variant: planned.variant
      };
      const upstream = upstreamLineageBySkill.get(planned.skill);
      attachStatusLineage(resultStatus, upstream, {
        receiptHash: installRecordResult.installRecord?.sourceHash ?? null,
        receiptCommit: installRecordResult.installRecord?.sourceCommit ?? null
      });

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

  if (target !== undefined && target.trim().length > 0 && assignments.length === 0) {
    errors.push({
      code: "unknown_target",
      message: `No assignment path or assignment found for target ${target}.`
    });
  }

  return {
    ok: errors.length === 0,
    source: sourceRoot,
    manifestPath,
    assignments,
    statuses,
    externalProjections,
    summary,
    errors
  };
}

function createStatusLineageLoader(sourceRoot: string, errors: StatusFinding[]): {
  load: (skillNames: Iterable<string>) => Promise<Map<string, Omit<UpstreamLineage, "target">>>;
} {
  // Status can be target-scoped, so load upstream lineage only for skills that
  // will appear in the selected report instead of hashing every declared
  // upstream-managed catalog skill.
  const lineageBySkill = new Map<string, Omit<UpstreamLineage, "target">>();
  const loadedSkills = new Set<string>();
  let loadFailed = false;

  return {
    async load(skillNames: Iterable<string>): Promise<Map<string, Omit<UpstreamLineage, "target">>> {
      if (loadFailed) {
        return lineageBySkill;
      }

      const missingSkills = [...new Set(skillNames)].filter((skill) => !loadedSkills.has(skill));
      if (missingSkills.length === 0) {
        return lineageBySkill;
      }

      const lineageResult = await loadStatusLineage(sourceRoot, new Set(missingSkills));
      errors.push(...lineageResult.errors);
      for (const [skill, lineage] of lineageResult.lineageBySkill) {
        lineageBySkill.set(skill, lineage);
      }
      for (const skill of missingSkills) {
        loadedSkills.add(skill);
      }
      if (lineageResult.errors.length > 0 && lineageResult.lineageBySkill.size === 0) {
        loadFailed = true;
      }

      return lineageBySkill;
    }
  };
}

async function loadStatusLineage(sourceRoot: string, skillNames: ReadonlySet<string>): Promise<StatusLineageResult> {
  let loaded: Awaited<ReturnType<typeof loadUpstreamLock>>;
  try {
    loaded = await loadUpstreamLock(sourceRoot, { skills: skillNames });
  } catch (error) {
    return {
      lineageBySkill: new Map(),
      errors: [
        {
          code: "upstream_lock_load_failed",
          message: `Unable to load upstream lock lineage: ${errorMessage(error)}`,
          scope: "upstream"
        }
      ]
    };
  }
  const errors = loaded.findings.map((item): StatusFinding => {
    const finding: StatusFinding = {
      code: item.code,
      message: item.message,
      scope: "upstream"
    };
    if (item.path !== null) {
      finding.path = item.path;
    }
    return finding;
  });
  if (!loaded.ok) {
    return {
      lineageBySkill: new Map(),
      errors
    };
  }
  return {
    lineageBySkill: new Map(
      loaded.declarations.map((entry) => {
        const { target: _target, ...lineage } = upstreamLineage(entry);
        return [entry.skill, lineage];
      })
    ),
    errors
  };
}

function attachStatusLineage(
  status: StatusItem,
  upstream: Omit<UpstreamLineage, "target"> | undefined,
  target: Omit<StatusLineage["target"], "status">
): void {
  if (upstream === undefined) {
    return;
  }
  status.lineage = {
    ...upstream,
    target: {
      status: status.status,
      receiptHash: target.receiptHash,
      receiptCommit: target.receiptCommit
    }
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
  const destination = blocked.destination;
  const targetPath = path.join(installRoot, destination);
  const status: StatusItem = {
    assignment: assignmentName,
    assignmentPath: assignmentPathId,
    kind,
    skill: blocked.skill,
    status: "blocked",
    target: installRoot,
    targetPath,
    destination,
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
  installRecord,
  sourcePolicy,
  destination
}: {
  sourceRoot: string;
  sourceSkillPath: string;
  installRoot: string;
  skillName: string;
  installRecord: InstallRecord | null;
  sourcePolicy: SourcePolicy | undefined;
  destination: string;
}): Promise<StatusCheckResult> {
  const targetPath = path.join(installRoot, destination);
  let sourceVersion: string | null;
  let sourceHashValue = "";
  try {
    sourceVersion = await readSkillVersion(sourceSkillPath);
    sourceHashValue = await hashDirectory(sourceSkillPath, sourcePolicy);
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

  if (installRecord.mode === SYMLINK_MODE) {
    return statusSymlinkSkill({
      classification: await classifySymlinkInstall({
        targetPath,
        expectedSourcePath: sourceSkillPath
      }),
      installRoot,
      targetPath,
      sourceVersion,
      sourceHashValue,
      currentCommit,
      installRecord,
      sourcePolicy
    });
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
    if (targetHash !== installedHash && !(await targetMatchesInstalledFiles(targetPath, installRecord.installedFiles))) {
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
      targetDiffers = await targetDiffersFromSource(sourceSkillPath, targetPath, sourcePolicy);
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

function statusSymlinkSkill({
  classification,
  installRoot,
  targetPath,
  sourceVersion,
  sourceHashValue,
  currentCommit,
  installRecord,
  sourcePolicy
}: {
  classification: Awaited<ReturnType<typeof classifySymlinkInstall>>;
  installRoot: string;
  targetPath: string;
  sourceVersion: string | null;
  sourceHashValue: string;
  currentCommit: string | null;
  installRecord: InstallRecord;
  sourcePolicy: SourcePolicy | undefined;
}): StatusCheckResult {
  const installedCommit = installRecord.sourceCommit ?? null;

  if (classification.state === "correct") {
    if (sourcePolicyHasExcludePatterns(sourcePolicy)) {
      return {
        status: "dirty",
        reason: "symlink exposes sourcePolicy exclude patterns",
        target: installRoot,
        targetPath,
        installedVersion: installRecord.version ?? null,
        currentVersion: sourceVersion,
        installedCommit,
        currentCommit,
        installedHash: installRecord.sourceHash ?? null,
        currentHash: sourceHashValue,
        errors: []
      };
    }
    return {
      status: "current",
      reason: "symlink points at the selected source path",
      target: installRoot,
      targetPath,
      installedVersion: sourceVersion,
      currentVersion: sourceVersion,
      installedCommit,
      currentCommit,
      installedHash: sourceHashValue,
      currentHash: sourceHashValue,
      errors: []
    };
  }

  return {
    status: "dirty",
    reason: symlinkDirtyReason(classification.state),
    target: installRoot,
    targetPath,
    installedVersion: installRecord.version ?? null,
    currentVersion: sourceVersion,
    installedCommit,
    currentCommit,
    installedHash: installRecord.sourceHash ?? null,
    currentHash: sourceHashValue,
    errors: []
  };
}

function symlinkDirtyReason(state: SymlinkInstallState): string {
  switch (state) {
    case "broken":
      return "symlink target is missing or broken";
    case "wrong-target":
      return "symlink points at an unexpected target instead of the selected source path";
    case "real-directory":
      return "expected a symlink but found a real directory";
    default:
      return "symlink install does not match the selected source path";
  }
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

async function targetDiffersFromSource(
  source: string,
  target: string,
  sourcePolicy?: SourcePolicy | undefined
): Promise<boolean> {
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

  const sourceEntries = await listFiles(source, "", sourcePolicy);
  const targetEntries = await listFiles(target, "", sourcePolicy, "include");

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

async function targetMatchesInstalledFiles(
  targetPath: string,
  installedFiles: InstalledFileRecord[] | null | undefined
): Promise<boolean> {
  if (!Array.isArray(installedFiles) || installedFiles.length === 0) {
    return false;
  }

  const expected = new Map<string, string>();
  for (const file of installedFiles) {
    const filePath = normalizeValue(file?.path);
    const hash = normalizeValue(file?.hash);
    if (filePath === null || hash === null) {
      return false;
    }
    expected.set(filePath, hash);
  }

  let actualFiles: string[];
  try {
    actualFiles = await listFiles(targetPath);
  } catch {
    return false;
  }

  if (actualFiles.length !== expected.size) {
    return false;
  }

  for (const relativePath of actualFiles) {
    const expectedHash = expected.get(relativePath);
    if (expectedHash === undefined) {
      return false;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(targetPath, relativePath));
    } catch {
      return false;
    }
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== expectedHash) {
      return false;
    }
  }

  return true;
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

async function hashDirectory(root: string, sourcePolicy?: SourcePolicy | undefined): Promise<string> {
  if (sourcePolicy !== undefined) {
    const deniedPaths = await collectSourcePolicyDeniedPaths(root, sourcePolicy);
    if (deniedPaths.length > 0) {
      throw new Error(`source policy denies paths (${deniedPaths.join(", ")})`);
    }
  }
  const files = await listFiles(root, "", sourcePolicy);
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

async function listFiles(
  root: string,
  prefix = "",
  sourcePolicy?: SourcePolicy | undefined,
  denyAction: "throw" | "include" = "throw"
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = prefix.length > 0 ? path.join(prefix, entry.name) : entry.name;
    const policyDecision = sourcePolicy === undefined
      ? { action: "include" as const, pattern: null }
      : sourcePolicyDecision(relativePath, sourcePolicy);
    if (policyDecision.action === "exclude" || entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      continue;
    }
    if (policyDecision.action === "deny" && denyAction === "throw") {
      throw new Error(`source policy denies path ${relativePath}`);
    }

    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (sourcePolicy !== undefined && sourcePolicyPrunesDirectory(relativePath, sourcePolicy)) {
        continue;
      }
      files.push(...(await listFiles(entryPath, relativePath, sourcePolicy, denyAction)));
      continue;
    }
    if (entry.isFile()) {
      files.push(relativePath);
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

function shouldIncludeAssignmentPath({
  target,
  exactTargetExists,
  assignmentPathId,
  assignmentPath
}: {
  target?: string | undefined;
  exactTargetExists: boolean;
  assignmentPathId: string;
  assignmentPath: unknown;
}): boolean {
  if (target === undefined || target.trim().length === 0) {
    return true;
  }

  if (assignmentPathId === target) {
    return true;
  }

  if (exactTargetExists) {
    return false;
  }

  return isRecord(assignmentPath) && normalizeValue(assignmentPath.assignment) === target;
}
