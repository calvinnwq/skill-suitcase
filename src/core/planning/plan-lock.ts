import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { loadCatalog, type Catalog } from "../catalog/index.js";
import { plan, type PlanResult } from "./index.js";
import { checkSelectedSourceHygiene } from "../source-hygiene.js";
import { sourcePolicyDecision, sourcePolicyPrunesDirectory } from "../source-policy.js";

export const PLAN_LOCK_SCHEMA = "calvinnwq.skills.plan-lock.v0";

type PlanLockSource = {
  repo: string;
  ref: string | null;
  commit: string | null;
};

type PlanEntry = {
  skill: string;
  action: "install" | "blocked";
  variant: string;
  evidence: string[];
};

export type PlanLock = {
  schema: typeof PLAN_LOCK_SCHEMA;
  source: PlanLockSource;
  target: string;
  assignmentPath: string | null;
  selectedSkills: string[];
  planEntries: PlanEntry[];
  fileHashes: Record<string, Record<string, string>>;
};

type PlanLockRecord = PlanLock & {
  planId: string;
};

type PlanLockInput = {
  source: string;
  target: string;
  assignmentPath: string;
  sourceCommit?: string;
};

type PlanLockAssessInput = PlanLockInput & {
  lock: unknown;
};

export type PlanLockAssessResult = {
  valid: boolean;
  reasons: string[];
  current: PlanLockRecord | null;
};

export async function buildPlanLock({
  source,
  target,
  assignmentPath,
  sourceCommit
}: PlanLockInput): Promise<PlanLockRecord> {
  const { sourceRoot, manifest } = await loadCatalog(source);
  const planResult: PlanResult = await plan({ source: sourceRoot, target });

  if (!planResult.ok) {
    throw new Error(
      `Cannot create lock for invalid plan target ${target}: ${planResult.errors[0]?.message}`
    );
  }

  const hygiene = checkSelectedSourceHygiene({
    sourceRoot,
    plannedSkills: planResult.planned,
    sourcePolicy: manifest.sourcePolicy
  });
  if (!hygiene.ok) {
    throw new Error(`Cannot create lock for unclean source: ${hygiene.errors[0]?.message}`);
  }

  const normalizedAssignmentPath = normalizeValue(assignmentPath);
  const commit = await resolveSourceCommit(sourceCommit, sourceRoot);
  const fileHashes = await collectPlanFileHashes(planResult.planned, manifest.sourcePolicy);
  const planEntries = planResult.planned.map((item) => stableObject(plannedEntry(item)) as PlanEntry);
  const selectedSkills = [...new Set(planResult.planned.map((item) => item.skill))].sort();

  const lockRecord: Omit<PlanLockRecord, "planId"> = {
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

export async function assessPlanLock({
  source,
  target,
  assignmentPath,
  lock,
  sourceCommit
}: PlanLockAssessInput): Promise<PlanLockAssessResult> {
  if (!isRecord(lock)) {
    return { valid: false, reasons: ["invalid_lock"], current: null };
  }

  const prior: Partial<PlanLockRecord> = lock;

  let current: PlanLockRecord;
  try {
    const buildArgs: PlanLockInput = {
      source,
      target,
      assignmentPath
    };
    if (sourceCommit !== undefined) {
      buildArgs.sourceCommit = sourceCommit;
    }
    current = await buildPlanLock(buildArgs);
  } catch {
    return { valid: false, reasons: ["current_plan_unavailable"], current: null };
  }

  const reasons: string[] = [];

  if (!isRecord(current.source) || !isRecord(prior.source)) {
    reasons.push("missing_source_metadata");
  }

  if (current.source.repo !== prior.source?.repo) {
    reasons.push("source_repo_changed");
  }

  if (current.source.ref !== prior.source?.ref) {
    reasons.push("source_ref_changed");
  }

  if (current.source.commit !== prior.source?.commit) {
    reasons.push("source_commit_changed");
  }

  if (current.target !== prior.target) {
    reasons.push("target_changed");
  }

  if (current.assignmentPath !== prior.assignmentPath) {
    reasons.push("assignment_path_changed");
  }

  if (!arraysEqual(current.selectedSkills, prior.selectedSkills ?? [])) {
    reasons.push("selected_skills_changed");
  }

  if (!objectHashesEqual(current.planEntries, prior.planEntries ?? null)) {
    reasons.push("plan_entries_changed");
  }

  if (!objectHashesEqual(current.fileHashes, prior.fileHashes ?? null)) {
    reasons.push("file_hashes_changed");
  }

  if (current.planId !== prior.planId) {
    reasons.push("plan_id_changed");
  }

  if (prior.schema !== current.schema) {
    reasons.push("invalid_lock_schema");
  }

  return {
    valid: reasons.length === 0,
    reasons,
    current
  };
}

async function collectPlanFileHashes(
  plannedSkills: PlanResult["planned"],
  sourcePolicy: Catalog["sourcePolicy"]
): Promise<PlanLock["fileHashes"]> {
  const hashes: PlanLock["fileHashes"] = {};

  for (const item of plannedSkills) {
    const skillFiles = await listFiles(item.sourcePath, "", sourcePolicy);
    const fileHashList: Record<string, string> = {};

    for (const relativePath of skillFiles) {
      const policyDecision = sourcePolicyDecision(relativePath, sourcePolicy);
      if (policyDecision.action === "deny") {
        throw new Error(`Cannot create lock for denied source path: ${item.skill}/${relativePath}`);
      }
      if (policyDecision.action === "exclude") {
        continue;
      }

      const filePath = path.join(item.sourcePath, relativePath);
      const bytes = await readFile(filePath);
      fileHashList[relativePath] = createHash("sha256").update(bytes).digest("hex");
    }

    hashes[item.skill] = stableObject(fileHashList) as Record<string, string>;
  }

  return stableObject(hashes) as PlanLock["fileHashes"];
}

function computePlanId(lockRecord: Omit<PlanLockRecord, "planId">): string {
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

async function resolveSourceCommit(explicitSourceCommit: string | undefined, sourceRoot: string) {
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

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableObject(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    ordered[key] = stableObject(value[key]);
  }
  return ordered;
}

function plannedEntry(item: PlanResult["planned"][number]): PlanEntry {
  return {
    skill: item.skill,
    action: item.action,
    variant: item.variant,
    evidence: Array.isArray(item.evidence) ? [...item.evidence] : []
  };
}

function normalizeValue(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arraysEqual(left: string[], right: string[]): boolean;
function arraysEqual(left: unknown[] | null, right: unknown[] | null): boolean;
function arraysEqual(left: readonly unknown[] | null, right: readonly unknown[] | null): boolean {
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

function objectHashesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableObject(left)) === JSON.stringify(stableObject(right));
}

async function listFiles(root: string, prefix = "", sourcePolicy?: Catalog["sourcePolicy"]): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") {
        continue;
      }
      if (sourcePolicyPrunesDirectory(relativePath, sourcePolicy)) {
        continue;
      }

      const childPath = path.join(root, entry.name);
      const childEntries = await listFiles(childPath, relativePath, sourcePolicy);
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
