import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  RECEIPT_FILE,
  rollbackReceiptMutations,
  withReceiptLock,
  type ReceiptLock,
  type ReceiptMutation
} from "./index.js";

/**
 * Shared receipt transaction for live mutation workflows (apply, reconcile,
 * repair, promote, and import-target).
 *
 * Each of those workflows needs the same mechanics around a mutation:
 * hold the receipt-local lock for the whole mutation, accumulate each receipt
 * write as a {@link ReceiptMutation}, and, when the workflow fails partway,
 * revert the accumulated receipt writes and report when that revert could not
 * be completed. This module owns only those mechanics. Workflow policy stays
 * in the owning modules: planning, validation, filesystem unwinding, error
 * codes other than the shared incomplete-rollback report, and result shapes.
 *
 * Deliberately not covered here because their transaction semantics differ:
 * `prune` journals its own quarantine transaction with a receipt backup file,
 * and `rollback` performs a single guarded receipt-state update where receipt
 * rollback state is the product rather than an unwind mechanism.
 */
export type ReceiptTransaction = {
  /** The held receipt lock; pass to receipt writers inside the transaction. */
  receiptLock: ReceiptLock;
  /** Accumulate a receipt write so a later failure can revert it. */
  recordMutation: (mutation: ReceiptMutation) => void;
  /**
   * Revert every recorded receipt write, newest first. Returns false when the
   * receipt could not be fully restored (for example after a concurrent
   * conflicting edit), in which case the workflow should report the shared
   * incomplete-rollback finding alongside its own failure.
   */
  rollbackRecordedMutations: () => Promise<boolean>;
};

export const RECEIPT_ROLLBACK_FAILED = "receipt_rollback_failed";

export function receiptRollbackIncompleteMessage(context: string): string {
  return `Receipt rollback was incomplete after ${context}.`;
}

export async function withReceiptTransaction<T>(
  { installRoot, createInstallRoot }: { installRoot: string; createInstallRoot?: boolean },
  action: (receiptTransaction: ReceiptTransaction) => Promise<T>
): Promise<T> {
  const lockInput = createInstallRoot === undefined
    ? { installRoot }
    : { installRoot, createInstallRoot };
  return withReceiptLock(lockInput, (receiptLock) => {
    const mutations: ReceiptMutation[] = [];
    return action({
      receiptLock,
      recordMutation: (mutation) => {
        mutations.push(mutation);
      },
      rollbackRecordedMutations: () =>
        rollbackReceiptMutations({ installRoot, mutations, receiptLock })
    });
  });
}

/**
 * Read the modern receipt text at the install root, or null when absent.
 * Reconcile, repair, promote, and import-target call this before their first
 * write so an unreadable receipt refuses the mutation instead of failing after
 * target files moved.
 */
export async function readOptionalReceiptText(installRoot: string): Promise<string | null> {
  try {
    return await readFile(path.join(installRoot, RECEIPT_FILE), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
