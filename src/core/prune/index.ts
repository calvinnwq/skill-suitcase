import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { plan } from "../planning/index.js";
import { targets } from "../catalog/targets.js";
import type { TargetOverrides } from "../catalog/index.js";
import {
  buildInstalledFiles,
  readReceipt,
  RECEIPT_FILE,
  RECEIPT_SCHEMA,
  type Receipt,
  type ReceiptInstallRecord
} from "../receipts/index.js";
import { SYMLINK_MODE } from "../install-modes.js";

export const PRUNE_PLAN_SCHEMA = "calvinnwq.skills.prune-plan.v0";
export const PRUNE_TRANSACTION_SCHEMA = "calvinnwq.skills.prune-transaction.v0";

type PruneInput = {
  source: string;
  target: string;
  skills?: string[];
  dryRun?: boolean;
  apply?: boolean;
  planId?: string;
  targetOverrides?: TargetOverrides | undefined;
  __test?: {
    failAfterMutationForSkill?: string;
    failBeforeReceipt?: boolean;
  };
};

type PruneError = {
  code: string;
  message: string;
  skill?: string;
  path?: string;
};

export type PruneCandidate = {
  skill: string;
  kind: "directory" | "symlink";
  targetPath: string;
  fingerprint: string;
  receiptRecordHash: string;
  symlinkTarget: string | null;
  quarantinePath: string | null;
};

type PruneBaseResult = {
  ok: boolean;
  dryRun: boolean;
  readOnly: boolean;
  source: string;
  target: string;
  assignment: string | null;
  installRoot: string | null;
  selected: { skills: string[] };
  plan: {
    schema: typeof PRUNE_PLAN_SCHEMA;
    id: string | null;
    receiptPath: string | null;
    receiptHash: string | null;
    quarantineRoot: string | null;
  };
  candidates: PruneCandidate[];
  preserved: { assigned: string[] };
  refused: { skills: string[] };
  summary: {
    selected: number;
    candidates: number;
    directories: number;
    symlinks: number;
    refused: number;
  };
  errors: PruneError[];
};

export type PrunePlanResult = PruneBaseResult & {
  dryRun: true;
  readOnly: true;
  pruned: { skills: []; directories: 0; symlinks: 0 };
  transactionPath: null;
  receiptBackupPath: null;
};

export type PruneApplyResult = PruneBaseResult & {
  dryRun: false;
  readOnly: false;
  pruned: { skills: string[]; directories: number; symlinks: number };
  transactionPath: string | null;
  receiptBackupPath: string | null;
};

export type PruneResult = PrunePlanResult | PruneApplyResult;

type PlannedPrune = PruneBaseResult & {
  receipt: Receipt | null;
};

export async function prune(input: PruneInput): Promise<PruneResult> {
  if (!input.source) throw new Error("source is required");
  if (!input.target) throw new Error("target is required");

  const selected = normalizeSkills(input.skills);
  const wantsDryRun = input.dryRun === true;
  const wantsApply = input.apply === true;
  if (selected.length === 0 || input.skills?.some((skill) => skill.trim().length === 0)) {
    return failedPlan(input, selected, "invalid_skill_filter", "prune requires at least one explicit non-blank --skill value.");
  }
  if (wantsDryRun === wantsApply) {
    return failedPlan(input, selected, "invalid_prune_mode", "prune requires exactly one of --dry-run or --apply.");
  }
  if (wantsApply && !normalize(input.planId)) {
    return failedPlan(input, selected, "missing_plan_id", "prune --apply requires the exact --plan-id returned by dry-run.");
  }

  const planned = await planPrune(input, selected);
  if (wantsDryRun || !planned.ok) return finalizePlan(planned);
  if (planned.plan.id !== input.planId) {
    planned.ok = false;
    planned.errors.push({
      code: "stale_plan",
      message: `Reviewed prune plan ${input.planId} no longer matches current state ${planned.plan.id ?? "unavailable"}. Run a fresh dry-run.`
    });
    return finalizePlan(planned);
  }
  return executePrune(input, planned);
}

async function planPrune(input: PruneInput, selected: string[]): Promise<PlannedPrune> {
  const source = path.resolve(input.source);
  const errors: PruneError[] = [];
  const targetReport = await targets({ source, targetOverrides: input.targetOverrides });
  const target = targetReport.targets.find((item) => item.id === input.target);
  const installRoot = target?.platform?.installRoot ?? null;
  const assignment = target?.assignment ?? null;
  if (target === undefined) errors.push({ code: "unknown_target", message: `Unknown target ${input.target}.` });
  if (target?.platform?.metadata["readOnly"] === true) errors.push({ code: "read_only_target", message: `Target ${input.target} is read-only.` });
  if (target !== undefined && target.safety.classification !== "live-install-root") {
    errors.push({
      code: "invalid_target",
      message: `Target ${input.target} is not a verified live install root: ${target.safety.reason ?? target.safety.classification}.`
    });
  }
  if (installRoot === null) errors.push({ code: "missing_install_root", message: `Could not resolve install root for ${input.target}.` });

  const assignmentPlan = await plan({ source, target: assignment ?? input.target });
  for (const error of assignmentPlan.errors.filter((item) => item.skill === undefined)) {
    errors.push({ code: "assignment_unverifiable", message: `Cannot verify target assignment: ${error.message}` });
  }
  const assigned = new Set([
    ...assignmentPlan.planned.map((item) => item.skill),
    ...assignmentPlan.blocked.map((item) => item.skill),
    ...assignmentPlan.errors.flatMap((error) => error.skill === undefined ? [] : [error.skill])
  ]);
  const preservedAssigned = selected.filter((skill) => assigned.has(skill));
  for (const skill of preservedAssigned) {
    errors.push({ code: "skill_still_assigned", message: `Skill ${skill} is still assigned to ${assignment ?? input.target} and cannot be pruned.`, skill });
  }

  let receipt: Receipt | null = null;
  let receiptPath: string | null = null;
  let receiptHash: string | null = null;
  if (installRoot !== null) {
    receiptPath = path.join(installRoot, RECEIPT_FILE);
    try {
      const receiptText = await readFile(receiptPath, "utf8");
      receiptHash = sha256(receiptText);
      receipt = await readReceipt({ installRoot });
    } catch (error) {
      errors.push({ code: "invalid_receipt", message: `Could not read prune receipt ${receiptPath}: ${errorMessage(error)}`, path: receiptPath });
    }
  }

  const candidates: PruneCandidate[] = [];
  if (installRoot !== null && receipt !== null) {
    for (const skill of selected) {
      if (assigned.has(skill)) continue;
      if (!isPlainSegment(skill)) {
        errors.push({ code: "unsafe_skill_name", message: `Skill ${skill} is not a plain path segment.`, skill });
        continue;
      }
      const targetPath = path.join(installRoot, skill);
      if (!isDirectChild(targetPath, installRoot)) {
        errors.push({ code: "unsafe_target_path", message: `Target path ${targetPath} escapes ${installRoot}.`, skill, path: targetPath });
        continue;
      }
      const record = selectReceiptRecord(receipt, skill, targetPath, installRoot);
      if (record === null) {
        errors.push({ code: "missing_receipt_record", message: `Skill ${skill} has no matching receipt record for ${targetPath}.`, skill, path: targetPath });
        continue;
      }
      const candidate = await inspectCandidate(skill, targetPath, installRoot, record);
      if ("error" in candidate) errors.push(candidate.error);
      else candidates.push(candidate.value);
    }
  }

  const refused = [...new Set(errors.flatMap((error) => error.skill ? [error.skill] : []))].sort();
  const canHash = errors.length === 0 && receiptHash !== null && receiptPath !== null && installRoot !== null;
  const id = canHash ? sha256(stableJson({
    schema: PRUNE_PLAN_SCHEMA,
    source,
    target: input.target,
    assignment,
    installRoot,
    selected,
    receiptHash,
    candidates: candidates.map(({ quarantinePath: _ignored, ...candidate }) => candidate)
  })) : null;
  const quarantineRoot = id === null || installRoot === null ? null : path.join(installRoot, `.skill-suitcase-prune-${id.slice(0, 16)}`);
  const finalizedCandidates = candidates.map((candidate) => ({
    ...candidate,
    quarantinePath: candidate.kind === "directory" && quarantineRoot !== null
      ? path.join(quarantineRoot, "quarantine", candidate.skill)
      : null
  }));

  return {
    ok: errors.length === 0,
    dryRun: input.dryRun === true,
    readOnly: true,
    source,
    target: input.target,
    assignment,
    installRoot,
    selected: { skills: selected },
    plan: { schema: PRUNE_PLAN_SCHEMA, id, receiptPath, receiptHash, quarantineRoot },
    candidates: finalizedCandidates,
    preserved: { assigned: preservedAssigned },
    refused: { skills: refused },
    summary: {
      selected: selected.length,
      candidates: finalizedCandidates.length,
      directories: finalizedCandidates.filter((candidate) => candidate.kind === "directory").length,
      symlinks: finalizedCandidates.filter((candidate) => candidate.kind === "symlink").length,
      refused: refused.length
    },
    errors,
    receipt
  };
}

async function inspectCandidate(
  skill: string,
  targetPath: string,
  installRoot: string,
  record: ReceiptInstallRecord
): Promise<{ value: PruneCandidate } | { error: PruneError }> {
  let info;
  try { info = await lstat(targetPath); }
  catch (error) {
    return { error: { code: "target_missing", message: `Cannot prune missing target ${targetPath}: ${errorMessage(error)}`, skill, path: targetPath } };
  }
  const receiptRecordHash = sha256(stableJson(record));
  if (info.isSymbolicLink()) {
    if (record.mode !== SYMLINK_MODE) {
      return { error: { code: "receipt_kind_mismatch", message: `${targetPath} is a symlink but its receipt mode is ${String(record.mode)}.`, skill, path: targetPath } };
    }
    const linkTarget = await readlink(targetPath);
    const sourcePath = receiptSourcePath(record);
    if (sourcePath === null || path.resolve(path.dirname(targetPath), linkTarget) !== path.resolve(sourcePath)) {
      return { error: { code: "target_drift", message: `Symlink ${targetPath} no longer matches its receipt source.`, skill, path: targetPath } };
    }
    return { value: { skill, kind: "symlink", targetPath, fingerprint: sha256(linkTarget), receiptRecordHash, symlinkTarget: linkTarget, quarantinePath: null } };
  }
  if (!info.isDirectory()) {
    return { error: { code: "unsupported_target_kind", message: `${targetPath} is neither a directory nor symlink.`, skill, path: targetPath } };
  }
  if (record.mode === SYMLINK_MODE) {
    return { error: { code: "receipt_kind_mismatch", message: `${targetPath} is a directory but its receipt expects a symlink.`, skill, path: targetPath } };
  }
  const resolvedRoot = await realpath(installRoot);
  const resolvedTarget = await realpath(targetPath);
  if (!isInside(resolvedTarget, resolvedRoot)) {
    return { error: { code: "unsafe_target_path", message: `Directory ${targetPath} resolves outside ${installRoot}.`, skill, path: targetPath } };
  }
  const actualFiles = await buildInstalledFiles(targetPath);
  const expectedFiles = normalizeInstalledFiles(record.installedFiles);
  if (expectedFiles === null || stableJson(actualFiles) !== stableJson(expectedFiles)) {
    return { error: { code: "target_drift", message: `Directory ${targetPath} no longer matches receipt-owned files.`, skill, path: targetPath } };
  }
  return { value: { skill, kind: "directory", targetPath, fingerprint: sha256(stableJson(actualFiles)), receiptRecordHash, symlinkTarget: null, quarantinePath: null } };
}

async function executePrune(input: PruneInput, planned: PlannedPrune): Promise<PruneApplyResult> {
  const installRoot = planned.installRoot!;
  const receiptPath = planned.plan.receiptPath!;
  const quarantineRoot = planned.plan.quarantineRoot!;
  const transactionPath = path.join(quarantineRoot, "transaction.json");
  const receiptBackupPath = path.join(quarantineRoot, "receipt.before.json");
  const receiptTempPath = path.join(installRoot, `.skill-suitcase-receipt.prune-${planned.plan.id}.tmp`);
  const movedDirectories: PruneCandidate[] = [];
  const removedSymlinks: PruneCandidate[] = [];
  let receiptReplaced = false;
  try {
    await mkdir(quarantineRoot, { recursive: false });
    await mkdir(path.join(quarantineRoot, "quarantine"), { recursive: false });
    const receiptText = await readFile(receiptPath, "utf8");
    if (sha256(receiptText) !== planned.plan.receiptHash) {
      throw new Error("Receipt changed after prune preflight.");
    }
    await writeFile(receiptBackupPath, receiptText, "utf8");
    await writeTransaction(transactionPath, planned, "prepared");
    for (const candidate of planned.candidates) {
      if (candidate.kind === "directory") {
        await rename(candidate.targetPath, candidate.quarantinePath!);
        movedDirectories.push(candidate);
      } else {
        await rm(candidate.targetPath);
        removedSymlinks.push(candidate);
      }
      if (input.__test?.failAfterMutationForSkill === candidate.skill) throw new Error(`Injected failure after ${candidate.skill}`);
    }
    if (input.__test?.failBeforeReceipt) throw new Error("Injected failure before receipt write");
    const nextReceipt = removeCandidateRecords(planned.receipt!, planned.candidates, installRoot);
    await writeFile(receiptTempPath, `${JSON.stringify(nextReceipt, null, 2)}\n`, "utf8");
    await rename(receiptTempPath, receiptPath);
    receiptReplaced = true;
    await writeTransaction(transactionPath, planned, "committed");
    return {
      ...stripReceipt(planned),
      ok: true,
      dryRun: false,
      readOnly: false,
      pruned: {
        skills: planned.candidates.map((candidate) => candidate.skill),
        directories: movedDirectories.length,
        symlinks: removedSymlinks.length
      },
      transactionPath,
      receiptBackupPath
    };
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (receiptReplaced) {
      try { await rename(receiptBackupPath, receiptPath); }
      catch (rollbackError) { rollbackErrors.push(`receipt restore: ${errorMessage(rollbackError)}`); }
    } else {
      await rm(receiptTempPath, { force: true }).catch(() => undefined);
    }
    for (const candidate of [...removedSymlinks].reverse()) {
      try { await symlink(candidate.symlinkTarget!, candidate.targetPath); }
      catch (rollbackError) { rollbackErrors.push(`${candidate.skill} symlink restore: ${errorMessage(rollbackError)}`); }
    }
    for (const candidate of [...movedDirectories].reverse()) {
      try { await rename(candidate.quarantinePath!, candidate.targetPath); }
      catch (rollbackError) { rollbackErrors.push(`${candidate.skill} directory restore: ${errorMessage(rollbackError)}`); }
    }
    if (rollbackErrors.length === 0) await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined);
    const failed = stripReceipt(planned);
    failed.ok = false;
    failed.errors = [...failed.errors, {
      code: "prune_apply_failed",
      message: `Prune transaction failed: ${errorMessage(error)}${rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join("; ")}` : ""}`
    }];
    return {
      ...failed,
      dryRun: false,
      readOnly: false,
      pruned: { skills: [], directories: 0, symlinks: 0 },
      transactionPath: rollbackErrors.length === 0 ? null : transactionPath,
      receiptBackupPath: rollbackErrors.length === 0 ? null : receiptBackupPath
    };
  }
}

function removeCandidateRecords(receipt: Receipt, candidates: PruneCandidate[], installRoot: string): Receipt {
  const installs = { ...(receipt.installs ?? {}) };
  for (const candidate of candidates) {
    const raw = installs[candidate.skill];
    const records = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const remaining = records.filter((record) => !recordMatches(record, candidate.targetPath, installRoot));
    if (remaining.length === 0) delete installs[candidate.skill];
    else installs[candidate.skill] = remaining.length === 1 ? remaining[0]! : remaining;
  }
  return { ...receipt, schema: RECEIPT_SCHEMA, installs };
}

function selectReceiptRecord(receipt: Receipt, skill: string, targetPath: string, installRoot: string): ReceiptInstallRecord | null {
  const raw = receipt.installs?.[skill];
  const records = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const matches = records.filter((record) => recordMatches(record, targetPath, installRoot));
  return matches.length === 1 ? matches[0]! : null;
}

function recordMatches(record: ReceiptInstallRecord, targetPath: string, installRoot: string): boolean {
  const value = normalize(record.targetPath);
  if (value === null) return false;
  return path.resolve(installRoot, value) === path.resolve(targetPath);
}

function receiptSourcePath(record: ReceiptInstallRecord): string | null {
  if (normalize(record.sourcePath)) return normalize(record.sourcePath);
  if (typeof record.source === "string") return normalize(record.source);
  if (record.source && typeof record.source === "object" && !Array.isArray(record.source)) return normalize(record.source.path);
  return null;
}

function normalizeInstalledFiles(value: unknown): Array<{ path: string; hash: string }> | null {
  if (!Array.isArray(value)) return null;
  const files: Array<{ path: string; hash: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const filePath = normalize(record["path"]);
    const hash = normalize(record["hash"]);
    if (filePath === null || hash === null) return null;
    files.push({ path: filePath, hash });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeTransaction(transactionPath: string, planned: PlannedPrune, status: "prepared" | "committed"): Promise<void> {
  await writeFile(transactionPath, `${JSON.stringify({
    schema: PRUNE_TRANSACTION_SCHEMA,
    planId: planned.plan.id,
    status,
    source: planned.source,
    target: planned.target,
    installRoot: planned.installRoot,
    receiptPath: planned.plan.receiptPath,
    receiptBackupPath: path.join(planned.plan.quarantineRoot!, "receipt.before.json"),
    candidates: planned.candidates
  }, null, 2)}\n`, "utf8");
}

function finalizePlan(planned: PlannedPrune): PrunePlanResult {
  return {
    ...stripReceipt(planned),
    dryRun: true,
    readOnly: true,
    pruned: { skills: [], directories: 0, symlinks: 0 },
    transactionPath: null,
    receiptBackupPath: null
  };
}

function stripReceipt(planned: PlannedPrune): PruneBaseResult {
  const { receipt: _receipt, ...result } = planned;
  return result;
}

function failedPlan(input: PruneInput, selected: string[], code: string, message: string): PrunePlanResult {
  return finalizePlan({
    ok: false, dryRun: true, readOnly: true, source: path.resolve(input.source), target: input.target,
    assignment: null, installRoot: null, selected: { skills: selected },
    plan: { schema: PRUNE_PLAN_SCHEMA, id: null, receiptPath: null, receiptHash: null, quarantineRoot: null },
    candidates: [], preserved: { assigned: [] }, refused: { skills: selected },
    summary: { selected: selected.length, candidates: 0, directories: 0, symlinks: 0, refused: selected.length },
    errors: [{ code, message }], receipt: null
  });
}

function normalizeSkills(skills: string[] | undefined): string[] {
  return [...new Set((skills ?? []).map((skill) => skill.trim()).filter(Boolean))].sort();
}
function normalize(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function isPlainSegment(value: string): boolean {
  return value !== "." && value !== ".." && path.basename(value) === value && !value.includes("/") && !value.includes("\\");
}
function isDirectChild(candidate: string, root: string): boolean {
  return path.dirname(path.resolve(candidate)) === path.resolve(root);
}
function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
