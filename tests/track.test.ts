import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RECEIPT_FILE, type Receipt, type ReceiptInstallRecord } from "../src/receipt.js";
import { status } from "../src/status.js";
import { track } from "../src/track.js";

async function writeOpenClawCatalog(sourceRoot: string, targetRoot: string): Promise<void> {
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:\n  core:\n    skills:\n      - office-hours\n  openclaw-builder:\n    skills:\n      - gnhf-postflight\n\nassignments:\n  openclaw:\n    suitcases:\n      - core\n      - openclaw-builder\n\nassignmentPaths:\n  openclaw:\n    kind: openclaw-skills-root\n    assignment: openclaw\n    path: ${targetRoot}\n\ncompatibility:\n  office-hours:\n    agents:\n      - openclaw\n    variant: canonical\n  gnhf-postflight:\n    agents:\n      - openclaw\n    variant: canonical\n`
  );
}

async function createLiveMatchingInstall(t: { after(fn: () => Promise<void> | void): void }): Promise<{
  sourceRoot: string;
  targetRoot: string;
}> {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-track-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  const fixtureRoot = path.join(process.cwd(), "tests", "fixtures", "skills-catalog", "skills");
  await mkdir(path.join(sourceRoot, "skills"), { recursive: true });
  await cp(path.join(fixtureRoot, "office-hours"), path.join(sourceRoot, "skills", "office-hours"), { recursive: true });
  await cp(path.join(fixtureRoot, "gnhf-postflight"), path.join(sourceRoot, "skills", "gnhf-postflight"), { recursive: true });
  await cp(path.join(sourceRoot, "skills", "office-hours"), path.join(targetRoot, "office-hours"), { recursive: true });
  await cp(path.join(sourceRoot, "skills", "gnhf-postflight"), path.join(targetRoot, "gnhf-postflight"), { recursive: true });
  await writeOpenClawCatalog(sourceRoot, targetRoot);

  return { sourceRoot, targetRoot };
}

function singleRecord(receipt: Receipt, skill: string): ReceiptInstallRecord {
  const value = receipt.installs?.[skill];
  if (value === undefined) {
    throw new Error(`Missing receipt for ${skill}.`);
  }
  if (Array.isArray(value)) {
    const first = value[0];
    if (first === undefined || value.length !== 1) {
      throw new Error(`Expected one receipt for ${skill}.`);
    }
    return first;
  }
  return value;
}

test("track records existing matching office-hours and OpenClaw gnhf-postflight installs without rewriting files", async (t) => {
  const { sourceRoot, targetRoot } = await createLiveMatchingInstall(t);
  const officeSkillFile = path.join(targetRoot, "office-hours", "SKILL.md");
  const gnhfSkillFile = path.join(targetRoot, "gnhf-postflight", "SKILL.md");
  const beforeOffice = await stat(officeSkillFile);
  const beforeGnhf = await stat(gnhfSkillFile);

  const result = await track({ source: sourceRoot, target: "openclaw" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.tracked.skills, ["gnhf-postflight", "office-hours"]);
  assert.equal(result.tracked.files > 2, true);
  assert.equal((await stat(officeSkillFile)).mtimeMs, beforeOffice.mtimeMs);
  assert.equal((await stat(gnhfSkillFile)).mtimeMs, beforeGnhf.mtimeMs);

  const receipt = JSON.parse(await readFile(path.join(targetRoot, RECEIPT_FILE), "utf8")) as Receipt;
  const officeRecord = singleRecord(receipt, "office-hours");
  const gnhfRecord = singleRecord(receipt, "gnhf-postflight");
  assert.equal(officeRecord.mode, "track");
  assert.equal(gnhfRecord.mode, "track");
  assert.equal(typeof officeRecord.sourceHash, "string");
  assert.equal(typeof gnhfRecord.sourceHash, "string");
  assert.equal(Array.isArray(officeRecord.installedFiles), true);
  assert.equal(Array.isArray(gnhfRecord.installedFiles), true);

  const statusResult = await status({ source: sourceRoot });
  assert.equal(statusResult.ok, true);
  assert.equal(statusResult.summary.current, 2);
});

test("track refuses dirty targets and does not write receipts", async (t) => {
  const { sourceRoot, targetRoot } = await createLiveMatchingInstall(t);
  await writeFile(path.join(targetRoot, "gnhf-postflight", "failure_patterns.yaml"), "dirty\n");

  const result = await track({ source: sourceRoot, target: "openclaw" });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_mismatch"), true);
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});

test("track refuses missing live installs", async (t) => {
  const { sourceRoot, targetRoot } = await createLiveMatchingInstall(t);
  await rm(path.join(targetRoot, "office-hours"), { recursive: true, force: true });

  const result = await track({ source: sourceRoot, target: "openclaw" });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_missing"), true);
  await assert.rejects(readFile(path.join(targetRoot, RECEIPT_FILE), "utf8"), /ENOENT/);
});
