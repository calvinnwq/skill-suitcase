import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  RECEIPT_FILE,
  RECEIPT_LOCK_FILE,
  buildInstallRecord,
  readReceipt,
  upsertAndWriteReceipt,
  type ReceiptInstallRecord
} from "../src/receipt.js";
import {
  RECEIPT_ROLLBACK_FAILED,
  readOptionalReceiptText,
  receiptRollbackIncompleteMessage,
  withReceiptTransaction
} from "../src/core/receipts/transaction.js";

function installRecordFor(root: string, skill: string, provenance: Record<string, string>): ReceiptInstallRecord {
  return buildInstallRecord({
    skill,
    agent: "codex",
    mode: "copy",
    targetPath: path.join(root, skill),
    sourcePath: `/repo/skills/${skill}`,
    ...provenance
  });
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

test("receipt transaction returns the action result and releases the lock", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-receipt-transaction-success-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const value = await withReceiptTransaction({ installRoot: root }, async (receiptTransaction) => {
    assert.equal(receiptTransaction.receiptLock.active, true);
    assert.equal(receiptTransaction.receiptLock.installRoot, root);
    assert.equal(await pathExists(path.join(root, RECEIPT_LOCK_FILE)), true);
    return "transaction-result";
  });

  assert.equal(value, "transaction-result");
  assert.equal(await pathExists(path.join(root, RECEIPT_LOCK_FILE)), false);
});

test("receipt transaction rollback restores an absent receipt after a recorded write", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-receipt-transaction-unwind-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await withReceiptTransaction({ installRoot: root }, async (receiptTransaction) => {
    await upsertAndWriteReceipt({
      installRoot: root,
      skillName: "transaction-skill",
      installRecord: installRecordFor(root, "transaction-skill", { sourceHash: "transaction-hash" }),
      onWritten: receiptTransaction.recordMutation,
      receiptLock: receiptTransaction.receiptLock
    });
    assert.equal(await pathExists(path.join(root, RECEIPT_FILE)), true);
    assert.equal(await receiptTransaction.rollbackRecordedMutations(), true);
  });

  assert.equal(await pathExists(path.join(root, RECEIPT_FILE)), false);
});

test("receipt transaction rollback restores the exact previous receipt text", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-receipt-transaction-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await upsertAndWriteReceipt({
    installRoot: root,
    skillName: "existing-skill",
    installRecord: installRecordFor(root, "existing-skill", { version: "1.0.0" })
  });
  const previousText = await readFile(path.join(root, RECEIPT_FILE), "utf8");

  await withReceiptTransaction({ installRoot: root }, async (receiptTransaction) => {
    await upsertAndWriteReceipt({
      installRoot: root,
      skillName: "existing-skill",
      installRecord: installRecordFor(root, "existing-skill", { version: "2.0.0" }),
      onWritten: receiptTransaction.recordMutation,
      receiptLock: receiptTransaction.receiptLock
    });
    await upsertAndWriteReceipt({
      installRoot: root,
      skillName: "second-skill",
      installRecord: installRecordFor(root, "second-skill", { sourceHash: "second-hash" }),
      onWritten: receiptTransaction.recordMutation,
      receiptLock: receiptTransaction.receiptLock
    });
    assert.equal(await receiptTransaction.rollbackRecordedMutations(), true);
  });

  assert.equal(await readFile(path.join(root, RECEIPT_FILE), "utf8"), previousText);
});

test("receipt transaction rollback with no recorded mutations leaves the receipt untouched", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-receipt-transaction-noop-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await upsertAndWriteReceipt({
    installRoot: root,
    skillName: "existing-skill",
    installRecord: installRecordFor(root, "existing-skill", { version: "1.0.0" })
  });
  const previousText = await readFile(path.join(root, RECEIPT_FILE), "utf8");

  await withReceiptTransaction({ installRoot: root }, async (receiptTransaction) => {
    assert.equal(await receiptTransaction.rollbackRecordedMutations(), true);
  });

  assert.equal(await readFile(path.join(root, RECEIPT_FILE), "utf8"), previousText);
});

test("receipt transaction reports an incomplete rollback after a conflicting concurrent edit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-receipt-transaction-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await withReceiptTransaction({ installRoot: root }, async (receiptTransaction) => {
    await upsertAndWriteReceipt({
      installRoot: root,
      skillName: "shared-skill",
      installRecord: installRecordFor(root, "shared-skill", { version: "1.0.0" }),
      onWritten: receiptTransaction.recordMutation,
      receiptLock: receiptTransaction.receiptLock
    });
    await upsertAndWriteReceipt({
      installRoot: root,
      skillName: "shared-skill",
      installRecord: installRecordFor(root, "shared-skill", { version: "2.0.0" }),
      receiptLock: receiptTransaction.receiptLock
    });
    assert.equal(await receiptTransaction.rollbackRecordedMutations(), false);
  });

  const receipt = await readReceipt({ installRoot: root });
  const record = receipt.installs?.["shared-skill"];
  assert.ok(record !== undefined && !Array.isArray(record));
  assert.equal(record.version, "2.0.0");
  assert.equal(RECEIPT_ROLLBACK_FAILED, "receipt_rollback_failed");
  assert.equal(
    receiptRollbackIncompleteMessage("repair failed"),
    "Receipt rollback was incomplete after repair failed."
  );
});

test("receipt transaction serializes concurrent mutation attempts on the same root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-receipt-transaction-serialize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let secondFinished = false;
  let secondTransaction: Promise<void> | null = null;

  await withReceiptTransaction({ installRoot: root }, async (receiptTransaction) => {
    await upsertAndWriteReceipt({
      installRoot: root,
      skillName: "first-skill",
      installRecord: installRecordFor(root, "first-skill", { sourceHash: "first-hash" }),
      onWritten: receiptTransaction.recordMutation,
      receiptLock: receiptTransaction.receiptLock
    });
    secondTransaction = withReceiptTransaction({ installRoot: root }, async (concurrentTransaction) => {
      await upsertAndWriteReceipt({
        installRoot: root,
        skillName: "second-skill",
        installRecord: installRecordFor(root, "second-skill", { sourceHash: "second-hash" }),
        onWritten: concurrentTransaction.recordMutation,
        receiptLock: concurrentTransaction.receiptLock
      });
    }).then(() => {
      secondFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(secondFinished, false);
    assert.equal(await receiptTransaction.rollbackRecordedMutations(), true);
  });

  assert.ok(secondTransaction);
  await secondTransaction;
  const receipt = await readReceipt({ installRoot: root });
  assert.equal(receipt.installs?.["first-skill"], undefined);
  assert.ok(receipt.installs?.["second-skill"]);
});

test("readOptionalReceiptText returns null when absent and the receipt text when present", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-receipt-transaction-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(await readOptionalReceiptText(root), null);
  await writeFile(path.join(root, RECEIPT_FILE), "{}\n", "utf8");
  assert.equal(await readOptionalReceiptText(root), "{}\n");
});
