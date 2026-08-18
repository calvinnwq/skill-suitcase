import { createHash } from "node:crypto";
import os from "node:os";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
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
import { loadCatalog, type TargetOverrides } from "../catalog/index.js";
import {
  externalProjectionsForTarget,
  inspectExternalProjections,
  validateExternalProjectionMetadata
} from "../external-projections.js";
import {
  RECEIPT_FILE,
  RECEIPT_SCHEMA,
  withReceiptLock,
  type Receipt,
  type ReceiptInstallRecord
} from "../receipts/index.js";
import { SYMLINK_MODE } from "../install-modes.js";
import { validateHermesExternalRoot } from "../hermes-external-root.js";

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
    beforeLock?: () => Promise<void> | void;
    afterReceiptSnapshot?: () => Promise<void> | void;
    failAfterMutationForSkill?: string;
    failBeforeReceipt?: boolean;
    beforeMutationForSkill?: (skill: string) => Promise<void> | void;
    afterReceiptPrepared?: () => Promise<void> | void;
    failAfterReceipt?: boolean;
    afterReceiptWrite?: () => Promise<void> | void;
    beforeFailureRecovery?: () => Promise<void> | void;
    afterCandidateRevalidation?: (skill: string) => Promise<void> | void;
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
  kind: "directory" | "symlink" | "missing";
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

export type PruneApplyRefusalResult = PruneBaseResult & {
  dryRun: false;
  readOnly: true;
  pruned: { skills: []; directories: 0; symlinks: 0 };
  transactionPath: null;
  receiptBackupPath: null;
};

export type PruneResult = PrunePlanResult | PruneApplyResult | PruneApplyRefusalResult;

type PlannedPrune = PruneBaseResult & {
  receipt: Receipt | null;
  targetIdentity: string;
};

type TreeEntry = {
  kind: "directory" | "file";
  path: string;
  hash?: string;
};

const PRUNABLE_INSTALL_MODES = new Set(["copy", "import", "reconcile", "repair", "track", SYMLINK_MODE]);

export async function prune(input: PruneInput): Promise<PruneResult> {
  if (!input.source) throw new Error("source is required");
  if (!input.target) throw new Error("target is required");

  const selected = normalizeSkills(input.skills);
  const wantsDryRun = input.dryRun === true;
  const wantsApply = input.apply === true;
  if (selected.length === 0 || input.skills?.some((skill) => skill.trim().length === 0)) {
    return failedValidation(input, selected, wantsApply, "invalid_skill_filter", "prune requires at least one explicit non-blank --skill value.");
  }
  if (wantsDryRun === wantsApply) {
    return failedValidation(input, selected, wantsApply, "invalid_prune_mode", "prune requires exactly one of --dry-run or --apply.");
  }
  if (wantsApply && !normalize(input.planId)) {
    return failedValidation(input, selected, true, "missing_plan_id", "prune --apply requires the exact --plan-id returned by dry-run.");
  }

  const planned = await planPrune(input, selected);
  if (wantsDryRun) return finalizePlan(planned);
  if (!planned.ok) return finalizeApplyRefusal(planned);
  if (planned.plan.id !== input.planId) {
    planned.ok = false;
    planned.errors.push({
      code: "stale_plan",
      message: `Reviewed prune plan ${input.planId} no longer matches current state ${planned.plan.id ?? "unavailable"}. Run a fresh dry-run.`
    });
    return finalizeApplyRefusal(planned);
  }
  await input.__test?.beforeLock?.();
  return executePrune(input, planned);
}

async function planPrune(input: PruneInput, selected: string[]): Promise<PlannedPrune> {
  const source = path.resolve(input.source);
  const errors: PruneError[] = [];
  const { manifest } = await loadCatalog(source, { targetOverrides: input.targetOverrides });
  const metadataErrors = validateExternalProjectionMetadata(manifest).map((finding) => ({
    code: finding.code,
    message: finding.message,
    path: finding.path
  }));
  errors.push(...metadataErrors);
  const externalProjections = externalProjectionsForTarget(manifest.externalProjections, input.target);
  const targetReport = await targets({ source, targetOverrides: input.targetOverrides });
  const target = targetReport.targets.find((item) => item.id === input.target);
  const installRoot = target?.platform?.installRoot ?? null;
  const assignment = target?.assignment ?? null;
  const targetIdentity = assignment ?? input.target;
  const categorizedExternalRoot = target?.platform?.metadata["categorizedExternalRoot"] === true;
  const externalProjectionTargetPaths = new Map<string, string>();
  if (installRoot !== null && externalProjections.length > 0) {
    const inspections = await inspectExternalProjections({
      installRoot,
      projections: externalProjections,
      homeDirectory: input.targetOverrides?.home ?? os.homedir()
    });
    for (const inspection of inspections) {
      if (inspection.targetPath !== null) {
        externalProjectionTargetPaths.set(path.resolve(inspection.targetPath), inspection.id);
      }
    }
  }
  if (target === undefined) errors.push({ code: "unknown_target", message: `Unknown target ${input.target}.` });
  if (target?.platform?.metadata["readOnly"] === true) errors.push({ code: "read_only_target", message: `Target ${input.target} is read-only.` });
  if (target !== undefined && target.safety.classification !== "live-install-root") {
    errors.push({
      code: "invalid_target",
      message: `Target ${input.target} is not a verified live install root: ${target.safety.reason ?? target.safety.classification}.`
    });
  }
  if (installRoot === null) errors.push({ code: "missing_install_root", message: `Could not resolve install root for ${input.target}.` });
  if (categorizedExternalRoot && installRoot !== null) {
    if (target?.home === null || target?.home === undefined) {
      errors.push({ code: "invalid_target", message: `Categorized Hermes target ${input.target} is missing its explicit home.` });
    } else {
      errors.push(...await validateHermesExternalRoot({
        home: target.home,
        installRoot,
        planned: [],
        externalProjections,
        ...(input.targetOverrides?.home !== undefined ? { homeDirectory: input.targetOverrides.home } : {})
      }));
    }
  }

  let assignmentPlan: Awaited<ReturnType<typeof plan>>;
  try {
    assignmentPlan = await plan({
      source,
      target: assignment ?? input.target,
      assignmentPath: input.target
    });
  } catch (error) {
    errors.push({
      code: "assignment_unverifiable",
      message: `Cannot verify target assignment: ${errorMessage(error)}`
    });
    assignmentPlan = { ok: false, source, target: assignment ?? input.target, planned: [], blocked: [], errors: [] };
  }
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
      const receiptInfo = await lstat(receiptPath);
      if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink()) {
        throw new Error("Prune receipt must be a regular file.");
      }
      const receiptText = await readFile(receiptPath, "utf8");
      receiptHash = sha256(receiptText);
      await input.__test?.afterReceiptSnapshot?.();
      const loadedReceipt = parseModernReceipt(receiptText);
      const invalidRecord = invalidReceiptRecord(loadedReceipt);
      if (invalidRecord !== null) {
        throw new Error(invalidRecord);
      }
      receipt = loadedReceipt;
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
      const record = selectReceiptRecordForSkill(
        receipt,
        skill,
        targetIdentity,
        installRoot,
        categorizedExternalRoot
      );
      if (record === null) {
        errors.push({ code: "missing_receipt_record", message: `Skill ${skill} has no unambiguous receipt record inside ${installRoot}.`, skill, path: installRoot });
        continue;
      }
      const recordTargetPath = normalize(record.targetPath);
      const targetPath = recordTargetPath === null ? installRoot : path.resolve(installRoot, recordTargetPath);
      if (!isInside(targetPath, installRoot)) {
        errors.push({ code: "unsafe_target_path", message: `Target path ${targetPath} escapes ${installRoot}.`, skill, path: targetPath });
        continue;
      }
      const externalProjectionId = externalProjectionTargetPaths.get(path.resolve(targetPath));
      if (externalProjectionId !== undefined) {
        errors.push({
          code: "external_projection_owned",
          message: `Skill ${skill} receipt record targets declared external projection ${externalProjectionId} at ${targetPath}.`,
          skill,
          path: targetPath
        });
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
  const quarantineRoot = id === null || installRoot === null
    ? null
    : path.join(
      categorizedExternalRoot ? path.join(installRoot, ".archive") : installRoot,
      `.skill-suitcase-prune-${id.slice(0, 16)}`
    );
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
    receipt,
    targetIdentity
  };
}

async function inspectCandidate(
  skill: string,
  targetPath: string,
  installRoot: string,
  record: ReceiptInstallRecord
): Promise<{ value: PruneCandidate } | { error: PruneError }> {
  try {
    await assertNoSymlinkedParentComponents(targetPath, installRoot);
  } catch (error) {
    return { error: { code: "unsafe_target_path", message: `Could not safely resolve parent of ${targetPath}: ${errorMessage(error)}`, skill, path: targetPath } };
  }
  let info;
  try {
    info = await lstat(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { value: {
        skill,
        kind: "missing",
        targetPath,
        fingerprint: sha256("missing"),
        receiptRecordHash: sha256(stableJson(record)),
        symlinkTarget: null,
        quarantinePath: null
      } };
    }
    return { error: { code: "target_unreadable", message: `Could not inspect target ${targetPath}: ${errorMessage(error)}`, skill, path: targetPath } };
  }
  try {
    const resolvedRoot = await realpath(installRoot);
    const resolvedParent = await realpath(path.dirname(targetPath));
    if (resolvedParent !== resolvedRoot && !isInside(resolvedParent, resolvedRoot)) {
      return { error: { code: "unsafe_target_path", message: `Parent of ${targetPath} resolves outside ${installRoot}.`, skill, path: targetPath } };
    }
  } catch (error) {
    return { error: { code: "target_unreadable", message: `Could not inspect parent of ${targetPath}: ${errorMessage(error)}`, skill, path: targetPath } };
  }
  try {
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
    const tree = await inspectDirectoryTree(targetPath);
    if ("error" in tree) {
      return { error: { code: "unsupported_target_entry", message: `${targetPath} contains ${tree.error}.`, skill, path: targetPath } };
    }
    const actualFiles = tree.entries.flatMap((entry) => entry.kind === "file"
      ? [{ path: entry.path, hash: entry.hash! }]
      : []);
    const expectedFiles = normalizeInstalledFiles(record.installedFiles);
    const expectedDirectories = expectedFiles === null ? [] : installedFileDirectories(expectedFiles);
    const actualDirectories = tree.entries.flatMap((entry) => entry.kind === "directory" ? [entry.path] : []);
    if (
      expectedFiles === null
      || stableJson(actualFiles) !== stableJson(expectedFiles)
      || stableJson(actualDirectories) !== stableJson(expectedDirectories)
    ) {
      return { error: { code: "target_drift", message: `Directory ${targetPath} no longer matches receipt-owned files.`, skill, path: targetPath } };
    }
    return { value: { skill, kind: "directory", targetPath, fingerprint: sha256(stableJson(tree.entries)), receiptRecordHash, symlinkTarget: null, quarantinePath: null } };
  } catch (error) {
    return { error: { code: "target_unreadable", message: `Could not inspect target ${targetPath}: ${errorMessage(error)}`, skill, path: targetPath } };
  }
}

async function assertNoSymlinkedParentComponents(targetPath: string, installRoot: string): Promise<void> {
  const root = path.resolve(installRoot);
  const parent = path.resolve(path.dirname(targetPath));
  if (parent !== root && !isInside(parent, root)) {
    throw new Error(`Parent of ${targetPath} escapes ${installRoot}.`);
  }
  let current = root;
  for (const part of path.relative(root, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Parent component ${current} is a symlink.`);
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  const resolvedRoot = await realpath(root);
  let existingParent = parent;
  while (true) {
    try {
      existingParent = await realpath(existingParent);
      break;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const ancestor = path.dirname(existingParent);
      if (ancestor === existingParent) throw error;
      existingParent = ancestor;
    }
  }
  if (existingParent !== resolvedRoot && !isInside(existingParent, resolvedRoot)) {
    throw new Error(`Parent of ${targetPath} resolves outside ${installRoot}.`);
  }
}

async function executePrune(input: PruneInput, planned: PlannedPrune): Promise<PruneApplyResult> {
  const installRoot = planned.installRoot!;
  try {
    return await withReceiptLock(
      { installRoot, createInstallRoot: false },
      () => executePruneLocked(input, planned)
    );
  } catch (error) {
    const failed = stripReceipt(planned);
    return {
      ...failed,
      ok: false,
      dryRun: false,
      readOnly: false,
      pruned: { skills: [], directories: 0, symlinks: 0 },
      transactionPath: null,
      receiptBackupPath: null,
      errors: [...failed.errors, {
        code: "receipt_lock_failed",
        message: errorMessage(error)
      }]
    };
  }
}

async function executePruneLocked(input: PruneInput, planned: PlannedPrune): Promise<PruneApplyResult> {
  const installRoot = planned.installRoot!;
  const receiptPath = planned.plan.receiptPath!;
  const quarantineRoot = planned.plan.quarantineRoot!;
  const transactionPath = path.join(quarantineRoot, "transaction.json");
  const receiptBackupPath = path.join(quarantineRoot, "receipt.before.json");
  const receiptTempPath = path.join(quarantineRoot, "receipt.after.tmp");
  const receiptRestorePath = path.join(quarantineRoot, "receipt.restore.tmp");
  const movedDirectories: PruneCandidate[] = [];
  const removedSymlinks: PruneCandidate[] = [];
  let ownsQuarantineRoot = false;
  let receiptReplaced = false;
  try {
    await ensureQuarantineParent(quarantineRoot, installRoot);
    await mkdir(quarantineRoot, { recursive: false });
    ownsQuarantineRoot = true;
    await mkdir(path.join(quarantineRoot, "quarantine"), { recursive: false });
    const receiptInfo = await lstat(receiptPath);
    if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink()) {
      throw new Error("Prune receipt must be a regular file.");
    }
    const receiptText = await readFile(receiptPath, "utf8");
    if (sha256(receiptText) !== planned.plan.receiptHash) {
      throw new Error("Receipt changed after prune preflight.");
    }
    const receiptMode = (receiptInfo.mode & 0o777) || 0o600;
    await writeFile(receiptBackupPath, receiptText, { encoding: "utf8", flag: "wx", mode: receiptMode });
    await chmod(receiptBackupPath, receiptMode);
    await writeTransaction(transactionPath, planned, "prepared");
    for (const candidate of planned.candidates) {
      await input.__test?.beforeMutationForSkill?.(candidate.skill);
      await revalidateAssignments(input, planned, [candidate.skill]);
      await revalidateCandidate(planned, candidate);
      await input.__test?.afterCandidateRevalidation?.(candidate.skill);
      if (candidate.kind === "directory") {
        await assertNoSymlinkedParentComponents(candidate.quarantinePath!, installRoot);
        await assertNoSymlinkedParentComponents(candidate.targetPath, installRoot);
        await rename(candidate.targetPath, candidate.quarantinePath!);
        movedDirectories.push(candidate);
      } else if (candidate.kind === "symlink") {
        await assertNoSymlinkedParentComponents(candidate.targetPath, installRoot);
        await rm(candidate.targetPath);
        removedSymlinks.push(candidate);
      }
      if (input.__test?.failAfterMutationForSkill === candidate.skill) throw new Error(`Injected failure after ${candidate.skill}`);
    }
    const nextReceipt = removeCandidateRecords(
      planned.receipt!,
      planned.candidates,
      planned.targetIdentity,
      installRoot
    );
    await writeFile(receiptTempPath, `${JSON.stringify(nextReceipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: receiptMode });
    await chmod(receiptTempPath, receiptMode);
    await input.__test?.afterReceiptPrepared?.();
    await revalidateAssignments(
      input,
      planned,
      planned.candidates.map((candidate) => candidate.skill)
    );
    if (input.__test?.failBeforeReceipt) throw new Error("Injected failure before receipt write");
    await rename(receiptTempPath, receiptPath);
    receiptReplaced = true;
    await input.__test?.afterReceiptWrite?.();
    if (input.__test?.failAfterReceipt) throw new Error("Injected failure after receipt write");
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
    await input.__test?.beforeFailureRecovery?.();
    if (receiptReplaced) {
      try {
        const backup = await readFile(receiptBackupPath);
        const backupInfo = await lstat(receiptBackupPath);
        const backupMode = (backupInfo.mode & 0o777) || 0o600;
        await writeFile(receiptRestorePath, backup, { flag: "wx", mode: backupMode });
        await chmod(receiptRestorePath, backupMode);
        await rename(receiptRestorePath, receiptPath);
      }
      catch (rollbackError) { rollbackErrors.push(`receipt restore: ${errorMessage(rollbackError)}`); }
    } else {
      await rm(receiptTempPath, { force: true }).catch(() => undefined);
    }
    for (const candidate of [...removedSymlinks].reverse()) {
      try {
        await assertNoSymlinkedParentComponents(candidate.targetPath, installRoot);
        await symlink(candidate.symlinkTarget!, candidate.targetPath);
      }
      catch (rollbackError) { rollbackErrors.push(`${candidate.skill} symlink restore: ${errorMessage(rollbackError)}`); }
    }
    for (const candidate of [...movedDirectories].reverse()) {
      try {
        await assertNoSymlinkedParentComponents(candidate.targetPath, installRoot);
        await assertNoSymlinkedParentComponents(candidate.quarantinePath!, installRoot);
        await rename(candidate.quarantinePath!, candidate.targetPath);
      }
      catch (rollbackError) { rollbackErrors.push(`${candidate.skill} directory restore: ${errorMessage(rollbackError)}`); }
    }
    if (ownsQuarantineRoot && rollbackErrors.length === 0) {
      await rm(quarantineRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    const retainedTransactionPath = rollbackErrors.length > 0 && await pathExists(transactionPath)
      ? transactionPath
      : null;
    const retainedReceiptBackupPath = rollbackErrors.length > 0 && await pathExists(receiptBackupPath)
      ? receiptBackupPath
      : null;
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
      transactionPath: retainedTransactionPath,
      receiptBackupPath: retainedReceiptBackupPath
    };
  }
}

async function ensureQuarantineParent(quarantineRoot: string, installRoot: string): Promise<void> {
  const root = path.resolve(installRoot);
  const parent = path.resolve(path.dirname(quarantineRoot));
  if (parent === root) return;
  if (path.dirname(parent) !== root) {
    throw new Error(`Prune quarantine parent ${parent} must be a direct child of ${root}.`);
  }
  try {
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Prune quarantine parent ${parent} must be a real directory.`);
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    await mkdir(parent, { recursive: false });
  }
  await assertNoSymlinkedParentComponents(quarantineRoot, root);
}

async function revalidateAssignments(input: PruneInput, planned: PlannedPrune, skills: string[]): Promise<void> {
  const targetReport = await targets({ source: planned.source, targetOverrides: input.targetOverrides });
  const target = targetReport.targets.find((item) => item.id === planned.target);
  if (
    target === undefined
    || target.assignment !== planned.assignment
    || target.platform?.installRoot !== planned.installRoot
    || target.platform.metadata["readOnly"] === true
    || target.safety.classification !== "live-install-root"
  ) {
    throw new Error(`Target assignment changed for ${skills.join(", ")} during prune transaction.`);
  }
  let assignmentPlan: Awaited<ReturnType<typeof plan>>;
  try {
    assignmentPlan = await plan({
      source: planned.source,
      target: planned.assignment ?? planned.target,
      assignmentPath: planned.target
    });
  } catch (error) {
    throw new Error(`Cannot revalidate assignments for ${skills.join(", ")}: ${errorMessage(error)}`);
  }
  if (assignmentPlan.errors.some((error) => error.skill === undefined)) {
    throw new Error(`Cannot revalidate assignments for ${skills.join(", ")} during prune transaction.`);
  }
  const assigned = new Set([
    ...assignmentPlan.planned.map((item) => item.skill),
    ...assignmentPlan.blocked.map((item) => item.skill),
    ...assignmentPlan.errors.flatMap((error) => error.skill === undefined ? [] : [error.skill])
  ]);
  const newlyAssigned = skills.find((skill) => assigned.has(skill));
  if (newlyAssigned !== undefined) {
    throw new Error(`Skill ${newlyAssigned} became assigned during prune transaction.`);
  }
}

function removeCandidateRecords(
  receipt: Receipt,
  candidates: PruneCandidate[],
  targetIdentity: string,
  installRoot: string
): Receipt {
  const installs = { ...(receipt.installs ?? {}) };
  for (const candidate of candidates) {
    const raw = installs[candidate.skill];
    const records = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const remaining = records.filter((record) => !recordMatches(
      record,
      candidate.skill,
      targetIdentity,
      candidate.targetPath,
      installRoot
    ));
    if (remaining.length === 0) delete installs[candidate.skill];
    else installs[candidate.skill] = remaining.length === 1 ? remaining[0]! : remaining;
  }
  return { ...receipt, schema: RECEIPT_SCHEMA, installs };
}

function selectReceiptRecord(
  receipt: Receipt,
  skill: string,
  targetIdentity: string,
  targetPath: string,
  installRoot: string
): ReceiptInstallRecord | null {
  const raw = receipt.installs?.[skill];
  const records = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const matches = records.filter((record) => recordMatches(record, skill, targetIdentity, targetPath, installRoot));
  return matches.length === 1 ? matches[0]! : null;
}

function selectReceiptRecordForSkill(
  receipt: Receipt,
  skill: string,
  targetIdentity: string,
  installRoot: string,
  categorizedExternalRoot: boolean
): ReceiptInstallRecord | null {
  const raw = receipt.installs?.[skill];
  const records = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const matches = records.filter((record) => {
    const value = normalize(record.targetPath);
    if (value === null) return false;
    const targetPath = path.resolve(installRoot, value);
    return receiptDestinationMatches(record, skill, targetPath, installRoot, categorizedExternalRoot)
      && recordMatches(record, skill, targetIdentity, targetPath, installRoot);
  });
  return matches.length === 1 ? matches[0]! : null;
}

function receiptDestinationMatches(
  record: ReceiptInstallRecord,
  skill: string,
  targetPath: string,
  installRoot: string,
  categorizedExternalRoot: boolean
): boolean {
  const destination = normalize(record.destination);
  if (!categorizedExternalRoot) {
    return path.resolve(targetPath) === path.resolve(installRoot, skill)
      && (destination === null || destination === skill);
  }
  if (destination === null) return false;
  const category = path.dirname(destination);
  return isPlainSegment(category)
    && path.basename(destination) === skill
    && destination === path.join(category, skill)
    && path.resolve(targetPath) === path.resolve(installRoot, destination);
}

function recordMatches(
  record: ReceiptInstallRecord,
  skill: string,
  targetIdentity: string,
  targetPath: string,
  installRoot: string
): boolean {
  const value = normalize(record.targetPath);
  const recordTarget = normalize(record.target);
  const recordAgent = normalize(record.agent);
  const standardIdentity = recordAgent === targetIdentity
    && (recordTarget === null || recordTarget === targetIdentity);
  const promotedIdentity = identityPathMatches(recordAgent, installRoot)
    && identityPathMatches(recordTarget, installRoot);
  return value !== null
    && normalize(record.skill) === skill
    && (standardIdentity || promotedIdentity)
    && PRUNABLE_INSTALL_MODES.has(normalize(record.mode) ?? "")
    && path.resolve(installRoot, value) === path.resolve(targetPath);
}

function identityPathMatches(value: string | null, expected: string): boolean {
  return value !== null && path.isAbsolute(value) && path.resolve(value) === path.resolve(expected);
}

function invalidReceiptRecord(receipt: Receipt): string | null {
  if (receipt.installs === undefined) return null;
  if (!receipt.installs || typeof receipt.installs !== "object" || Array.isArray(receipt.installs)) {
    return "Receipt installs must be an object.";
  }
  for (const [skill, raw] of Object.entries(receipt.installs)) {
    const records = Array.isArray(raw) ? raw : [raw];
    if (records.length === 0 || records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) {
      return `Receipt install records for ${skill} must be objects.`;
    }
  }
  return null;
}

function parseModernReceipt(text: string): Receipt {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Receipt payload must be an object.");
  }
  const receipt = parsed as Receipt;
  if (receipt.schema !== RECEIPT_SCHEMA) {
    throw new Error("Prune receipt has an unsupported schema.");
  }
  return receipt;
}

async function revalidateCandidate(planned: PlannedPrune, candidate: PruneCandidate): Promise<void> {
  const receiptText = await readFile(planned.plan.receiptPath!, "utf8");
  if (sha256(receiptText) !== planned.plan.receiptHash) {
    throw new Error("Receipt changed during prune transaction.");
  }
  const receipt = JSON.parse(receiptText) as Receipt;
  const record = selectReceiptRecord(
    receipt,
    candidate.skill,
    planned.targetIdentity,
    candidate.targetPath,
    planned.installRoot!
  );
  if (record === null || sha256(stableJson(record)) !== candidate.receiptRecordHash) {
    throw new Error(`Receipt ownership changed for ${candidate.skill} during prune transaction.`);
  }
  const inspected = await inspectCandidate(candidate.skill, candidate.targetPath, planned.installRoot!, record);
  if ("error" in inspected || !sameCandidate(candidate, inspected.value)) {
    throw new Error(`Target changed for ${candidate.skill} during prune transaction.`);
  }
}

function sameCandidate(expected: PruneCandidate, actual: PruneCandidate): boolean {
  return expected.skill === actual.skill
    && expected.kind === actual.kind
    && expected.targetPath === actual.targetPath
    && expected.fingerprint === actual.fingerprint
    && expected.receiptRecordHash === actual.receiptRecordHash
    && expected.symlinkTarget === actual.symlinkTarget;
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

async function inspectDirectoryTree(root: string): Promise<
  { entries: TreeEntry[] } | { error: string }
> {
  const entries: TreeEntry[] = [];
  const pending = [""];
  while (pending.length > 0) {
    const relativeRoot = pending.pop()!;
    const children = await readdir(path.join(root, relativeRoot), { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = path.join(relativeRoot, child.name);
      const absolutePath = path.join(root, relativePath);
      if (child.isDirectory()) {
        entries.push({ kind: "directory", path: relativePath });
        pending.push(relativePath);
        continue;
      }
      if (child.isFile()) {
        entries.push({ kind: "file", path: relativePath, hash: sha256(await readFile(absolutePath)) });
        continue;
      }
      return { error: `unsupported ${child.isSymbolicLink() ? "symlink" : "filesystem entry"} ${relativePath}` };
    }
  }
  return { entries: entries.sort((left, right) => left.path.localeCompare(right.path)) };
}

function installedFileDirectories(files: Array<{ path: string; hash: string }>): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let directory = path.dirname(file.path);
    while (directory !== ".") {
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  return [...directories].sort((left, right) => left.localeCompare(right));
}

async function writeTransaction(transactionPath: string, planned: PlannedPrune, status: "prepared" | "committed"): Promise<void> {
  const payload = `${JSON.stringify({
    schema: PRUNE_TRANSACTION_SCHEMA,
    planId: planned.plan.id,
    status,
    source: planned.source,
    target: planned.target,
    installRoot: planned.installRoot,
    receiptPath: planned.plan.receiptPath,
    receiptBackupPath: path.join(planned.plan.quarantineRoot!, "receipt.before.json"),
    candidates: planned.candidates
  }, null, 2)}\n`;
  if (status === "prepared") {
    await writeFile(transactionPath, payload, { encoding: "utf8", flag: "wx" });
    return;
  }
  const tempPath = path.join(planned.plan.quarantineRoot!, "transaction.committed.tmp");
  await writeFile(tempPath, payload, { encoding: "utf8", flag: "wx" });
  await rename(tempPath, transactionPath);
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

function finalizeApplyRefusal(planned: PlannedPrune): PruneApplyRefusalResult {
  return {
    ...stripReceipt(planned),
    dryRun: false,
    readOnly: true,
    pruned: { skills: [], directories: 0, symlinks: 0 },
    transactionPath: null,
    receiptBackupPath: null
  };
}

function stripReceipt(planned: PlannedPrune): PruneBaseResult {
  const { receipt: _receipt, targetIdentity: _targetIdentity, ...result } = planned;
  return result;
}

function failedValidation(
  input: PruneInput,
  selected: string[],
  wantsApply: boolean,
  code: string,
  message: string
): PrunePlanResult | PruneApplyRefusalResult {
  const planned: PlannedPrune = {
    ok: false, dryRun: true, readOnly: true, source: path.resolve(input.source), target: input.target,
    assignment: null, installRoot: null, selected: { skills: selected },
    plan: { schema: PRUNE_PLAN_SCHEMA, id: null, receiptPath: null, receiptHash: null, quarantineRoot: null },
    candidates: [], preserved: { assigned: [] }, refused: { skills: selected },
    summary: { selected: selected.length, candidates: 0, directories: 0, symlinks: 0, refused: selected.length },
    errors: [{ code, message }], receipt: null, targetIdentity: input.target
  };
  return wantsApply ? finalizeApplyRefusal(planned) : finalizePlan(planned);
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
function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}
function sha256(value: string | Buffer): string {
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

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
