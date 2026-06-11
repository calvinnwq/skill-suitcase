import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PLAN_LOCK_SCHEMA } from "../src/plan-lock.js";
import {
  buildInstalledFiles,
  buildInstallRecord,
  buildReceipt,
  RECEIPT_FILE,
  upsertAndWriteReceipt
} from "../src/receipt.js";
import { status } from "../src/status.js";

test("status reports manifest-wide statuses for all assignments and respects receipt state", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-test-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });

  await writeFile(path.join(sourceSkill, "SKILL.md"), [
    "---",
    "name: office-hours",
    "version: 2026.06.10",
    "---",
    "",
    "# Office Hours"
  ].join("\n"));
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  const currentHash = await hashDirectory(sourceSkill);

  const currentRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-current-"));
  const missingRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-missing-"));
  const unknownRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-unknown-"));
  const versionRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-version-"));
  const behindRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-behind-"));
  const dirtyRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-dirty-"));
  t.after(() => rm(currentRoot, { recursive: true, force: true }));
  t.after(() => rm(missingRoot, { recursive: true, force: true }));
  t.after(() => rm(unknownRoot, { recursive: true, force: true }));
  t.after(() => rm(versionRoot, { recursive: true, force: true }));
  t.after(() => rm(behindRoot, { recursive: true, force: true }));
  t.after(() => rm(dirtyRoot, { recursive: true, force: true }));

  await mkdir(path.join(currentRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(currentRoot, "office-hours"), { recursive: true });
  await writeReceipt({
    installRoot: currentRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: currentHash
  });

  await mkdir(path.join(unknownRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(unknownRoot, "office-hours"), { recursive: true });

  await mkdir(path.join(versionRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(versionRoot, "office-hours"), { recursive: true });
  await writeReceipt({
    installRoot: versionRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.05.01",
    sourceHash: currentHash
  });

  await mkdir(path.join(behindRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(behindRoot, "office-hours"), { recursive: true });
  await writeFile(path.join(behindRoot, "office-hours", "runtime.js"), "console.log(\"behind\");\n");
  await writeReceipt({
    installRoot: behindRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(path.join(behindRoot, "office-hours"))
  });

  await mkdir(path.join(dirtyRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(dirtyRoot, "office-hours"), { recursive: true });
  await writeFile(path.join(dirtyRoot, "office-hours", "runtime.js"), "console.log(\"dirty\");\n");
  await writeReceipt({
    installRoot: dirtyRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: currentHash
  });

  const manifestPath = path.join(sourceRoot, "skill-suitcase.yaml");
  await writeFile(
    manifestPath,
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  current-openclaw:
    suitcases:
      - core

  missing-openclaw:
    suitcases:
      - core

  unknown-openclaw:
    suitcases:
      - core

  version-openclaw:
    suitcases:
      - core

  behind-openclaw:
    suitcases:
      - core

  dirty-openclaw:
    suitcases:
      - core

assignmentPaths:
  current-openclaw:
    kind: openclaw-skills-root
    assignment: current-openclaw
    path: ${currentRoot}

  missing-openclaw:
    kind: openclaw-skills-root
    assignment: missing-openclaw
    path: ${missingRoot}

  unknown-openclaw:
    kind: openclaw-skills-root
    assignment: unknown-openclaw
    path: ${unknownRoot}

  version-openclaw:
    kind: openclaw-skills-root
    assignment: version-openclaw
    path: ${versionRoot}

  behind-openclaw:
    kind: openclaw-skills-root
    assignment: behind-openclaw
    path: ${behindRoot}

  dirty-openclaw:
    kind: openclaw-skills-root
    assignment: dirty-openclaw
    path: ${dirtyRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, true);
  assert.equal(result.manifestPath, manifestPath);
  assert.equal(result.assignments.length, 6);
  assert.equal(result.statuses.length, 6);
  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.missing, 1);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.summary.version, 1);
  assert.equal(result.summary.behind, 1);
  assert.equal(result.summary.dirty, 1);

  const byPath = new Map(result.statuses.map((item) => [item.assignmentPath, item.status]));
  assert.equal(byPath.get("current-openclaw"), "current");
  assert.equal(byPath.get("missing-openclaw"), "missing");
  assert.equal(byPath.get("unknown-openclaw"), "unknown");
  assert.equal(byPath.get("version-openclaw"), "version");
  assert.equal(byPath.get("behind-openclaw"), "behind");
  assert.equal(byPath.get("dirty-openclaw"), "dirty");

  const byReason = new Map(result.statuses.map((item) => [item.assignmentPath, item.reason]));
  assert.equal(byReason.get("unknown-openclaw"), "target exists but has no Suitcase receipt");
  assert.equal(byReason.get("dirty-openclaw"), "target files differ from receipt");
});

test("status reads modern suitcase receipts with multi-target install records", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-receipt-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-target-"));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-target-alt-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  await mkdir(path.join(installRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  await mkdir(path.join(otherRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(otherRoot, "office-hours"), { recursive: true });

  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const sourceHash = await hashDirectory(sourceSkill);
  const targetInstallPath = path.join(installRoot, "office-hours");
  const otherInstallPath = path.join(otherRoot, "office-hours");
  const modernReceiptPath = path.join(installRoot, ".skill-suitcase-receipt.json");
  await writeFile(
    modernReceiptPath,
    `${JSON.stringify({
      schema: "calvinnwq.skills.receipt.v0",
      source: {
        repo: sourceRoot,
        ref: "refs/heads/main",
        commit: "deadbeef"
      },
      installs: {
        "office-hours": [
          {
            agent: "openclaw",
            target: "openclaw",
            mode: "copy",
            source: sourcePath,
            targetPath: targetInstallPath,
            sourceCommit: "deadbeef",
            sourceHash,
            version: "2026.06.10",
            installedFiles: [{ path: "SKILL.md", hash: "1234" }],
            priorState: {
              installedCommit: null,
              status: "missing"
            }
          },
          {
            agent: "openclaw",
            target: "openclaw",
            mode: "copy",
            source: sourcePath,
            targetPath: otherInstallPath,
            sourceCommit: "deadbeef",
            sourceHash,
            version: "2026.06.10"
          }
        ]
      }
    })}\n`
  );

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, true);
  assert.equal(result.summary.current, 1);
  assert.equal(result.statuses[0].status, "current");
});

test("status prefers valid modern install records when one record in array is invalid", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-mixed-modern-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-mixed-modern-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  const targetPath = path.join(installRoot, "office-hours");
  await mkdir(targetPath, { recursive: true });
  await cp(sourceSkill, targetPath, { recursive: true });

  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const sourceHash = await hashDirectory(sourceSkill);
  await writeFile(
    path.join(installRoot, RECEIPT_FILE),
    `${JSON.stringify({
      schema: "calvinnwq.skills.receipt.v0",
      source: {
        repo: sourceRoot,
        ref: "refs/heads/main",
        commit: "deadbeef"
      },
      installs: {
        "office-hours": [
          {
            agent: "openclaw",
            target: "openclaw",
            mode: "copy",
            source: sourcePath,
            targetPath: targetPath,
            sourceCommit: "deadbeef",
            sourceHash,
            version: "2026.06.10"
          },
          "invalid-record"
        ]
      }
    })}\n`,
    "utf8"
  );

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.unknown, 0);
  assert.equal(result.statuses[0].status, "current");
  assert.equal(result.errors.some((entry) => entry.code === "invalid_receipt"), true);
  const invalidReceiptError = result.errors.find((entry) => entry.code === "invalid_receipt");
  assert.equal(
    typeof invalidReceiptError?.message === "string" &&
      invalidReceiptError.message.includes("invalid install record for office-hours"),
    true
  );
});

test("status prefers valid legacy sync records when one record in array is invalid", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-mixed-legacy-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-mixed-legacy-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  const targetPath = path.join(installRoot, "office-hours");
  await mkdir(targetPath, { recursive: true });
  await cp(sourceSkill, targetPath, { recursive: true });

  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const sourceHash = await hashDirectory(sourceSkill);
  await writeFile(
    path.join(installRoot, ".skills-sync.json"),
    `${JSON.stringify({
      schema: "calvinnwq.skills.sync-lock.v0",
      source: {
        repo: sourceRoot,
        ref: "refs/heads/main",
        commit: "deadbeef"
      },
      installs: {
        "office-hours": [
          {
            agent: "openclaw",
            target: "openclaw",
            mode: "copy",
            source: sourcePath,
            targetPath: targetPath,
            sourceCommit: "deadbeef",
            sourceHash,
            version: "2026.06.10"
          },
          "invalid-record"
        ]
      }
    })}\n`,
    "utf8"
  );

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.unknown, 0);
  assert.equal(result.statuses[0].status, "current");
  assert.equal(result.errors.some((entry) => entry.code === "invalid_receipt"), true);
  const invalidReceiptError = result.errors.find((entry) => entry.code === "invalid_receipt");
  assert.equal(
    typeof invalidReceiptError?.message === "string" &&
      invalidReceiptError.message.includes("invalid install record for office-hours"),
    true
  );
});

test("status reads modern receipts with multiple skills sharing multi-target records", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-receipt-multi-skill-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-multi-skill-target-"));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-multi-skill-alt-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));

  const officeHoursSource = path.join(sourceRoot, "skills", "office-hours");
  const gnhfSource = path.join(sourceRoot, "skills", "gnhf-postflight");
  await mkdir(officeHoursSource, { recursive: true });
  await mkdir(gnhfSource, { recursive: true });
  await writeFile(
    path.join(officeHoursSource, "SKILL.md"),
    "---\nname: office-hours\nversion: 2026.06.10\n---\n"
  );
  await writeFile(
    path.join(gnhfSource, "SKILL.md"),
    "---\nname: gnhf-postflight\nversion: 2026.06.10\n---\n"
  );

  const officeHoursTarget = path.join(installRoot, "office-hours");
  const gnhfTarget = path.join(installRoot, "gnhf-postflight");
  await mkdir(officeHoursTarget, { recursive: true });
  await mkdir(gnhfTarget, { recursive: true });
  await cp(officeHoursSource, officeHoursTarget, { recursive: true });
  await cp(gnhfSource, gnhfTarget, { recursive: true });

  const officeHoursHash = await hashDirectory(officeHoursSource);
  const gnhfHash = await hashDirectory(gnhfSource);

  const officeHoursSourcePath = path.join(sourceRoot, "skills", "office-hours");
  const gnhfSourcePath = path.join(sourceRoot, "skills", "gnhf-postflight");
  const modernReceiptPath = path.join(installRoot, ".skill-suitcase-receipt.json");
  await writeFile(
    modernReceiptPath,
    `${JSON.stringify({
      schema: "calvinnwq.skills.receipt.v0",
      source: {
        repo: sourceRoot,
        ref: "refs/heads/main",
        commit: "deadbeef"
      },
      installs: {
        "office-hours": [
          {
            agent: "openclaw",
            target: "openclaw",
            mode: "copy",
            source: officeHoursSourcePath,
            targetPath: officeHoursTarget,
            sourceCommit: "deadbeef",
            sourceHash: officeHoursHash,
            version: "2026.06.10"
          },
          {
            agent: "openclaw",
            target: "openclaw",
            mode: "copy",
            source: officeHoursSourcePath,
            targetPath: path.join(otherRoot, "office-hours"),
            sourceCommit: "deadbeef",
            sourceHash: officeHoursHash,
            version: "2026.06.10"
          }
        ],
        "gnhf-postflight": [
          {
            agent: "openclaw",
            target: "openclaw",
            mode: "copy",
            source: gnhfSourcePath,
            targetPath: gnhfTarget,
            sourceCommit: "deadbeef",
            sourceHash: gnhfHash,
            version: "2026.06.10"
          },
          {
            agent: "openclaw",
            target: "openclaw",
            mode: "copy",
            source: gnhfSourcePath,
            targetPath: path.join(otherRoot, "gnhf-postflight"),
            sourceCommit: "deadbeef",
            sourceHash: gnhfHash,
            version: "2026.06.10"
          }
        ]
      }
    })}\n`,
    "utf8"
  );

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours
      - gnhf-postflight

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, true);
  assert.equal(result.summary.current, 2);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.unknown, 0);
  assert.equal(result.errors.length, 0);
  const statusesBySkill = new Map(result.statuses.map((entry) => [entry.skill, entry.status]));
  assert.equal(statusesBySkill.get("office-hours"), "current");
  assert.equal(statusesBySkill.get("gnhf-postflight"), "current");
});

test("status rejects ambiguous modern multi-target installs for an active root", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-receipt-ambiguous-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-ambiguous-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await mkdir(path.join(installRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });

  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const sourceHash = await hashDirectory(sourceSkill);
  const modernReceiptPath = path.join(installRoot, ".skill-suitcase-receipt.json");
  await writeFile(
    modernReceiptPath,
    `${JSON.stringify({
      schema: "calvinnwq.skills.receipt.v0",
      source: {
        repo: sourceRoot,
        ref: "refs/heads/main",
        commit: "deadbeef"
      },
      installs: {
        "office-hours": [
          {
            agent: "openclaw",
            target: "openclaw",
            mode: "copy",
            source: sourcePath,
            targetPath: path.join(installRoot, "office-hours"),
            sourceCommit: "deadbeef",
            sourceHash,
            version: "2026.06.10"
          },
          {
            agent: "openclaw",
            target: "openclaw",
            mode: "copy",
            source: sourcePath,
            targetPath: installRoot,
            sourceCommit: "deadbeef",
            sourceHash,
            version: "2026.06.10"
          }
        ]
      }
    })}\n`
  );

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.statuses[0].status, "unknown");
  assert.equal(result.errors.some((entry) => entry.code === "invalid_receipt"), true);
  const invalidReceiptError = result.errors.find((entry) => entry.code === "invalid_receipt");
  assert.equal(
    typeof invalidReceiptError?.message === "string" &&
      invalidReceiptError.message.includes("ambiguous install records for office-hours"),
    true
  );
});

test("status rejects modern receipts missing source provenance", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-missing-provenance-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-missing-provenance-install-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");
  await mkdir(path.join(installRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });

  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const receiptPath = path.join(installRoot, RECEIPT_FILE);
  const installRecord = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    target: "openclaw",
    sourcePath,
    targetPath: path.join(installRoot, "office-hours"),
    installedFiles: [{ path: "SKILL.md", hash: "1234" }]
  });
  const receipt = buildReceipt({
    sourceRoot,
    sourceCommit: "deadbeef",
    sourceRef: "refs/heads/main",
    installs: {
      "office-hours": installRecord
    }
  });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.errors.some((entry) => entry.code === "invalid_receipt"), true);
});

test("status rejects a single modern receipt when its only record targets another root", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-receipt-mismatch-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-mismatch-target-"));
  const alternateRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-mismatch-alt-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  t.after(() => rm(alternateRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await mkdir(path.join(installRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });

  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const sourceHash = await hashDirectory(sourceSkill);
  const altTarget = path.join(alternateRoot, "office-hours");
  const receiptPath = path.join(installRoot, ".skill-suitcase-receipt.json");
  await writeFile(
    receiptPath,
    `${JSON.stringify({
      schema: "calvinnwq.skills.receipt.v0",
      source: {
        repo: sourceRoot,
        ref: "refs/heads/main",
        commit: "deadbeef"
      },
      installs: {
        "office-hours": {
          agent: "openclaw",
          target: "openclaw",
          mode: "copy",
          source: sourcePath,
          targetPath: altTarget,
          sourceCommit: "deadbeef",
          sourceHash,
          version: "2026.06.10"
        }
      }
    })}\n`,
    "utf8"
  );

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.statuses[0].status, "unknown");
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.summary.current, 0);
  assert.equal(result.summary.missing, 0);
  assert.equal(
    result.errors.some((entry) =>
      entry.code === "invalid_receipt" &&
      entry.message.includes("no matching install record for office-hours")
    ),
    true
  );
});

test("status reads modern receipts with structured source metadata", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-structured-source-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-structured-source-install-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  await mkdir(path.join(installRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });

  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const sourceHash = await hashDirectory(sourceSkill);
  const modernReceiptPath = path.join(installRoot, RECEIPT_FILE);
  await writeFile(
    modernReceiptPath,
    `${JSON.stringify({
      schema: "calvinnwq.skills.receipt.v0",
      source: {
        repo: sourceRoot,
        ref: "refs/heads/main",
        commit: "deadbeef"
      },
      installs: {
        "office-hours": {
          agent: "openclaw",
          target: "openclaw",
          mode: "copy",
          source: { path: sourcePath },
          targetPath: path.join(installRoot, "office-hours"),
          sourceCommit: "deadbeef",
          sourceHash,
          version: "2026.06.10",
          installedFiles: [{ path: "SKILL.md", hash: "1234" }],
          priorState: {
            installedCommit: null,
            status: "current"
          }
        }
      }
    })}\n`
  );

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, true);
  assert.equal(result.summary.current, 1);
  assert.equal(result.statuses[0].status, "current");
});

test("status matches modern receipts with installRoot-relative targetPath", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-relative-target-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-relative-target-install-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  const targetPath = path.join(installRoot, "office-hours");
  await mkdir(targetPath, { recursive: true });
  await cp(sourceSkill, targetPath, { recursive: true });

  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const sourceHash = await hashDirectory(sourceSkill);
  await writeFile(
    path.join(installRoot, RECEIPT_FILE),
    `${JSON.stringify({
      schema: "calvinnwq.skills.receipt.v0",
      source: {
        repo: sourceRoot,
        ref: "refs/heads/main",
        commit: "deadbeef"
      },
      installs: {
        "office-hours": {
          agent: "openclaw",
          target: "openclaw",
          mode: "copy",
          source: sourcePath,
          targetPath: "office-hours",
          sourceCommit: "deadbeef",
          sourceHash,
          version: "2026.06.10"
        }
      }
    })}\n`
  );

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, true);
  assert.equal(result.summary.current, 1);
  assert.equal(result.statuses[0].status, "current");
});

test("status reports stale installed content as behind instead of dirty", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-stale-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-stale-install-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"old\");\n");

  const installedHash = await hashDirectory(sourceSkill);
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  await writeReceipt({
    installRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: installedHash
  });

  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"new\");\n");
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, true);
  assert.equal(result.summary.behind, 1);
  assert.equal(result.summary.dirty, 0);
  assert.equal(result.statuses[0].status, "behind");
});

test("status reports stale symlinked installs as behind instead of dirty", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-stale-link-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-stale-link-install-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"old\");\n");

  const installedHash = await hashDirectory(sourceSkill);
  await symlink(sourceSkill, path.join(installRoot, "office-hours"), "dir");
  await writeReceipt({
    installRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: installedHash
  });

  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"new\");\n");
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, true);
  assert.equal(result.summary.behind, 1);
  assert.equal(result.summary.dirty, 0);
  assert.equal(result.statuses[0].status, "behind");
});

test("status marks compatibility-blocked plan entries", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-blocked-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-blocked-install-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const officeHours = path.join(sourceRoot, "skills", "office-hours");
  const blockedSkill = path.join(sourceRoot, "skills", "gnhf-postflight");
  await mkdir(officeHours, { recursive: true });
  await mkdir(blockedSkill, { recursive: true });
  await writeFile(path.join(officeHours, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(blockedSkill, "SKILL.md"), "---\nname: gnhf-postflight\nversion: 2026.06.10\n---\n");

  await cp(officeHours, path.join(installRoot, "office-hours"), { recursive: true });
  await writeReceipt({
    installRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(officeHours)
  });

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours
      - gnhf-postflight

assignments:
  codex:
    suitcases:
      - core

assignmentPaths:
  codex-global:
    kind: codex-home
    assignment: codex
    skillsPath: ${installRoot}

compatibility:
  gnhf-postflight:
    blockedAgents:
      codex: Codex must use the slimmer platform variant.
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.blocked, 1);
  assert.equal(result.errors.some((entry) => entry.code === "blocked_skill"), true);

  const blocked = result.statuses.find((entry) => entry.skill === "gnhf-postflight");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "Codex must use the slimmer platform variant.");
});

test("status requires codex-home skillsPath as the install root", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-codex-root-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-codex-home-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(codexHome, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  codex:
    suitcases:
      - core

assignmentPaths:
  codex-global:
    kind: codex-home
    assignment: codex
    codexHome: ${codexHome}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.statuses.length, 0);
  assert.equal(result.errors[0].code, "invalid_assignment_path");
  assert.equal(result.errors[0].path, "assignmentPaths.codex-global.skillsPath");
});

test("status reports missing install roots as assignment errors", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-missing-root-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");

  const missingRoot = path.join(sourceRoot, "missing-install-root");
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${missingRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.statuses.length, 0);
  assert.equal(result.assignments[0].errors[0].code, "missing_install_root");
  assert.equal(result.errors[0].code, "missing_install_root");
  assert.equal(result.errors[0].path, "assignmentPaths.openclaw.path");
});

test("status reports malformed sync receipts as errors", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-receipt-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-receipt-install-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  await writeFile(path.join(installRoot, ".skills-sync.json"), "{ not json\n");
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.errors.some((entry) => entry.code === "invalid_receipt"), true);
});

test("status rejects sync receipts with missing or unsupported schemas", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-schema-"));
  const missingSchemaRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-missing-schema-"));
  const foreignSchemaRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-foreign-schema-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(missingSchemaRoot, { recursive: true, force: true }));
  t.after(() => rm(foreignSchemaRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await cp(sourceSkill, path.join(missingSchemaRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(foreignSchemaRoot, "office-hours"), { recursive: true });

  const sourceHash = await hashDirectory(sourceSkill);
  await writeFile(
    path.join(missingSchemaRoot, ".skills-sync.json"),
    `${JSON.stringify({
      installs: {
        "office-hours": {
          agent: "openclaw",
          mode: "copy",
          sourcePath: sourceSkill,
          targetPath: path.join(missingSchemaRoot, "office-hours"),
          sourceCommit: "deadbeef",
          sourceHash,
          version: "2026.06.10"
        }
      }
    })}\n`
  );
  await writeFile(
    path.join(foreignSchemaRoot, ".skills-sync.json"),
    `${JSON.stringify({
      schema: "foreign.schema.v1",
      installs: {
        "office-hours": {
          agent: "openclaw",
          mode: "copy",
          sourcePath: sourceSkill,
          targetPath: path.join(foreignSchemaRoot, "office-hours"),
          sourceCommit: "deadbeef",
          sourceHash,
          version: "2026.06.10"
        }
      }
    })}\n`
  );
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  missing:
    suitcases:
      - core
  foreign:
    suitcases:
      - core

assignmentPaths:
  missing:
    kind: openclaw-skills-root
    assignment: missing
    path: ${missingSchemaRoot}
  foreign:
    kind: openclaw-skills-root
    assignment: foreign
    path: ${foreignSchemaRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 2);
  assert.equal(result.errors.filter((entry) => entry.code === "invalid_receipt").length, 2);
  assert.equal(result.statuses.every((entry) => entry.status === "unknown"), true);
});

test("status rejects plan locks written as sync receipts", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-plan-lock-receipt-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-plan-lock-root-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  await writeFile(
    path.join(installRoot, ".skills-sync.json"),
    `${JSON.stringify({
      schema: PLAN_LOCK_SCHEMA,
      source: {
        repo: sourceRoot,
        ref: "deadbeef",
        commit: "deadbeef"
      },
      target: "openclaw",
      assignmentPath: "openclaw",
      selectedSkills: ["office-hours"],
      planEntries: [],
      fileHashes: {},
      planId: "lock"
    })}\n`
  );
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.errors.some((entry) => entry.code === "invalid_receipt"), true);
});

test("status reads legacy sync receipts with multi-target records", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-legacy-multi-target-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-legacy-target-"));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-legacy-target-alt-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");

  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const primaryTarget = path.join(installRoot, "office-hours");
  const alternateTarget = path.join(otherRoot, "office-hours");

  await mkdir(primaryTarget, { recursive: true });
  await mkdir(alternateTarget, { recursive: true });
  await cp(sourceSkill, primaryTarget, { recursive: true });
  await cp(sourceSkill, alternateTarget, { recursive: true });

  const sourceHash = await hashDirectory(sourceSkill);
  const legacyReceipt = {
    schema: "calvinnwq.skills.sync-lock.v0",
    source: {
      repo: sourceRoot,
      commit: "deadbeef",
      ref: "refs/heads/main"
    },
    installs: {
      "office-hours": [
        {
          agent: "openclaw",
          mode: "copy",
          sourcePath,
          targetPath: primaryTarget,
          sourceCommit: "deadbeef",
          sourceHash,
          version: "2026.06.10"
        },
        {
          agent: "openclaw",
          mode: "copy",
          sourcePath,
          targetPath: alternateTarget,
          sourceCommit: "deadbeef",
          sourceHash,
          version: "2026.06.10"
        }
      ]
    }
  };

  await writeFile(
    path.join(installRoot, ".skills-sync.json"),
    `${JSON.stringify(legacyReceipt, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, true);
  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.unknown, 0);
  assert.equal(result.statuses[0].status, "current");
});

test("status matches legacy sync receipts with installRoot-relative targetPath", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-legacy-relative-target-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-legacy-relative-install-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");

  const targetPath = path.join(installRoot, "office-hours");
  await mkdir(targetPath, { recursive: true });
  await cp(sourceSkill, targetPath, { recursive: true });

  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const sourceHash = await hashDirectory(sourceSkill);
  await writeFile(
    path.join(installRoot, ".skills-sync.json"),
    `${JSON.stringify({
      schema: "calvinnwq.skills.sync-lock.v0",
      source: {
        repo: sourceRoot,
        ref: "refs/heads/main",
        commit: "deadbeef"
      },
      installs: {
        "office-hours": {
          agent: "openclaw",
          mode: "copy",
          source: sourcePath,
          targetPath: "office-hours",
          sourceCommit: "deadbeef",
          sourceHash,
          version: "2026.06.10"
        }
      }
    })}\n`
  );

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, true);
  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.unknown, 0);
  assert.equal(result.statuses[0].status, "current");
});

test("status evaluates current state from receipts written by upsertAndWriteReceipt", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-write-status-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-write-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log(\"current\");\n");

  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const installedFiles = await buildInstalledFiles(sourceSkill);
  const sourceHash = await hashDirectory(sourceSkill);

  let receipt = buildReceipt({
    sourceRoot,
    sourceRef: "refs/heads/main",
    sourceCommit: "deadbeef"
  });
  const installRecord = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    source: sourcePath,
    targetPath: path.join(installRoot, "office-hours"),
    sourceCommit: "deadbeef",
    sourceHash,
    version: "2026.06.10",
    installedFiles,
    priorState: { installedCommit: null, status: "current" }
  });
  const receiptPath = await upsertAndWriteReceipt({
    installRoot,
    receipt,
    skillName: "office-hours",
    installRecord
  });

  const written = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(written.installs["office-hours"].version, "2026.06.10");
  assert.equal(written.installs["office-hours"].source, sourcePath);

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, true);
  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.unknown, 0);
  assert.equal(result.statuses.length, 1);
  assert.equal(result.statuses[0].status, "current");
});

test("status prefers modern receipts over legacy sync receipts", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-over-legacy-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-over-legacy-root-"));
  const legacyRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-modern-over-legacy-alt-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  t.after(() => rm(legacyRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");

  const targetPath = path.join(installRoot, "office-hours");
  await mkdir(targetPath, { recursive: true });
  await cp(sourceSkill, targetPath, { recursive: true });

  await writeReceipt({
    installRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceCommit: "modern-commit"
  });

  const legacyReceipt = {
    schema: "calvinnwq.skills.sync-lock.v0",
    source: {
      repo: sourceRoot,
      commit: "legacy-commit",
      ref: "refs/heads/main"
    },
    installs: {
      "office-hours": {
        agent: "openclaw",
        mode: "copy",
        sourcePath: sourceSkill,
        targetPath: path.join(legacyRoot, "office-hours"),
        sourceCommit: "legacy-commit",
        version: "2000.01.01"
      }
    }
  };
  await writeFile(
    path.join(installRoot, ".skills-sync.json"),
    `${JSON.stringify(legacyReceipt, null, 2)}\n`,
    "utf8"
  );

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, true);
  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.unknown, 0);
  assert.equal(result.errors.length, 0);
});

test("status rejects malformed per-skill install records", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-install-record-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-install-record-root-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  await writeFile(
    path.join(installRoot, ".skills-sync.json"),
    `${JSON.stringify({ schema: "calvinnwq.skills.sync-lock.v0", installs: { "office-hours": "bad" } })}\n`
  );
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.statuses[0].status, "unknown");
  assert.equal(result.errors.some((entry) => entry.code === "invalid_receipt"), true);
});

test("status rejects malformed installedFiles entries in modern receipts", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-installed-files-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-installed-files-root-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  await writeReceipt({
    installRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(sourceSkill),
    installedFiles: ["bad-entry"]
  });

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.errors.some((entry) => entry.code === "invalid_receipt"), true);
});

test("status rejects modern receipts with empty installed file hashes", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-empty-installed-hash-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-empty-installed-hash-root-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  await writeReceipt({
    installRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(sourceSkill),
    installedFiles: [{ path: "SKILL.md", hash: "" }]
  });

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.errors.some((entry) => entry.code === "invalid_receipt"), true);
  const invalid = result.errors.find((entry) => entry.code === "invalid_receipt");
  assert.equal(
    typeof invalid?.message === "string" && invalid.message.includes("invalid installedFiles"),
    true
  );
});

test("status rejects modern receipts with invalid structured source metadata", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-source-meta-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-source-meta-root-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const sourceHash = await hashDirectory(sourceSkill);
  await writeFile(
    path.join(installRoot, RECEIPT_FILE),
    `${JSON.stringify({
      schema: "calvinnwq.skills.receipt.v0",
      source: {
        repo: sourceRoot,
        ref: "refs/heads/main",
        commit: "deadbeef"
      },
      installs: {
        "office-hours": {
          agent: "openclaw",
          target: "openclaw",
          mode: "copy",
          sourcePath: path.join(sourceRoot, "skills", "office-hours"),
          source: { path: 123 },
          targetPath: path.join(installRoot, "office-hours"),
          sourceCommit: "deadbeef",
          sourceHash,
          version: "2026.06.10"
        }
      }
    })}\n`,
    "utf8"
  );

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.errors.some((entry) => entry.code === "invalid_receipt"), true);
  const invalid = result.errors.find((entry) => entry.code === "invalid_receipt");
  assert.equal(
    typeof invalid?.message === "string" && invalid.message.includes("invalid source.path"),
    true
  );
});

test("status rejects modern receipts with non-string provenance fields", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-provenance-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-provenance-root-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const sourceHash = await hashDirectory(sourceSkill);
  await writeFile(
    path.join(installRoot, RECEIPT_FILE),
    `${JSON.stringify({
      schema: "calvinnwq.skills.receipt.v0",
      source: {
        repo: sourceRoot,
        ref: "refs/heads/main",
        commit: "deadbeef"
      },
      installs: {
        "office-hours": {
          agent: "openclaw",
          target: "openclaw",
          mode: "copy",
          source: sourcePath,
          targetPath: path.join(installRoot, "office-hours"),
          sourceCommit: "deadbeef",
          sourceHash,
          version: 20260612
        }
      }
    })}\n`,
    "utf8"
  );

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.errors.some((entry) => entry.code === "invalid_receipt"), true);
  const invalid = result.errors.find((entry) => entry.code === "invalid_receipt");
  assert.equal(
    typeof invalid?.message === "string" && invalid.message.includes("invalid version field for office-hours"),
    true
  );
});

test("status rejects modern receipts with invalid priorState", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-priorstate-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-bad-priorstate-root-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  const sourcePath = path.join(sourceRoot, "skills", "office-hours");
  const sourceHash = await hashDirectory(sourceSkill);
  await writeFile(
    path.join(installRoot, RECEIPT_FILE),
    `${JSON.stringify({
      schema: "calvinnwq.skills.receipt.v0",
      source: {
        repo: sourceRoot,
        ref: "refs/heads/main",
        commit: "deadbeef"
      },
      installs: {
        "office-hours": {
          agent: "openclaw",
          target: "openclaw",
          mode: "copy",
          source: sourcePath,
          targetPath: path.join(installRoot, "office-hours"),
          sourceCommit: "deadbeef",
          sourceHash,
          version: "2026.06.10",
          priorState: "bad"
        }
      }
    })}\n`
  );

  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.errors.some((entry) => entry.code === "invalid_receipt"), true);
  const invalid = result.errors.find((entry) => entry.code === "invalid_receipt");
  assert.equal(
    typeof invalid?.message === "string" && invalid.message.includes("invalid priorState"),
    true
  );
});

test("status reports assignment-level validation errors while still evaluating valid assignments", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-invalid-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");

  const validRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-valid-"));
  const brokenRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-broken-"));
  t.after(() => rm(validRoot, { recursive: true, force: true }));
  t.after(() => rm(brokenRoot, { recursive: true, force: true }));

  await mkdir(path.join(validRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(validRoot, "office-hours"), { recursive: true });

  await mkdir(path.join(brokenRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(brokenRoot, "office-hours"), { recursive: true });

  await writeReceipt({
    installRoot: validRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(sourceSkill)
  });

  const manifestPath = path.join(sourceRoot, "skill-suitcase.yaml");
  await writeFile(
    manifestPath,
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${validRoot}

  bad-kind:
    kind: not-a-live-root
    assignment: openclaw
    path: ${brokenRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.assignments.length, 2);

  const validAssignment = result.assignments.find((entry) => entry.assignmentPath === "openclaw");
  const invalidAssignment = result.assignments.find((entry) => entry.assignmentPath === "bad-kind");

  assert.equal(validAssignment.assignment, "openclaw");
  assert.equal(validAssignment.statusCount, 1);
  assert.equal(validAssignment.statuses.length, 1);
  assert.equal(validAssignment.statuses[0].status, "current");

  assert.equal(invalidAssignment.statusCount, 0);
  assert.equal(invalidAssignment.statuses.length, 0);
  assert.equal(invalidAssignment.errors.length, 1);
  assert.equal(invalidAssignment.errors[0].code, "invalid_assignment_path");

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "invalid_assignment_path");
  assert.equal(result.errors[0].path, "assignmentPaths.bad-kind.kind");

  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.unknown, 0);
  assert.equal(result.summary.version, 0);
  assert.equal(result.summary.behind, 0);
  assert.equal(result.summary.dirty, 0);
});

test("status surfaces plan failures and continues evaluating other assignment paths", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-plan-fail-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");

  const validRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-valid-plan-"));
  const failingRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-plan-"));
  t.after(() => rm(validRoot, { recursive: true, force: true }));
  t.after(() => rm(failingRoot, { recursive: true, force: true }));

  await mkdir(path.join(validRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(validRoot, "office-hours"), { recursive: true });

  await mkdir(path.join(failingRoot, "office-hours"), { recursive: true });
  await cp(sourceSkill, path.join(failingRoot, "office-hours"), { recursive: true });

  await writeReceipt({
    installRoot: validRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(sourceSkill)
  });

  const manifestPath = path.join(sourceRoot, "skill-suitcase.yaml");
  await writeFile(
    manifestPath,
    `suitcases:
  core:
    skills:
      - office-hours
  portable:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

  broken:
    suitcases:
      - missing-suitcase

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${validRoot}

  broken:
    kind: openclaw-skills-root
    assignment: broken
    path: ${failingRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.assignments.length, 2);
  assert.equal(result.errors.some((entry) => entry.code === "plan_failed"), true);

  const validAssignment = result.assignments.find((entry) => entry.assignmentPath === "openclaw");
  const brokenAssignment = result.assignments.find((entry) => entry.assignmentPath === "broken");

  assert.equal(validAssignment.assignment, "openclaw");
  assert.equal(validAssignment.statusCount, 1);
  assert.equal(validAssignment.statuses[0].status, "current");

  assert.equal(brokenAssignment.assignment, "broken");
  assert.equal(brokenAssignment.statusCount, 0);
  assert.equal(brokenAssignment.statuses.length, 0);
  assert.equal(brokenAssignment.errors.length, 1);
  assert.equal(brokenAssignment.errors[0].code, "plan_failed");
});

test("status captures source read failures and continues other assignments", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-source-read-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const validSkill = path.join(sourceRoot, "skills", "office-hours");
  const brokenSkill = path.join(sourceRoot, "skills", "missing-skill-file");
  await mkdir(validSkill, { recursive: true });
  await mkdir(brokenSkill, { recursive: true });
  await writeFile(path.join(validSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");

  const validRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-source-valid-"));
  const brokenRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-source-broken-"));
  t.after(() => rm(validRoot, { recursive: true, force: true }));
  t.after(() => rm(brokenRoot, { recursive: true, force: true }));

  await cp(validSkill, path.join(validRoot, "office-hours"), { recursive: true });
  await mkdir(path.join(brokenRoot, "missing-skill-file"), { recursive: true });
  await writeReceipt({
    installRoot: validRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(validSkill)
  });
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours
  broken:
    skills:
      - missing-skill-file

assignments:
  openclaw:
    suitcases:
      - core
  broken:
    suitcases:
      - broken

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${validRoot}
  broken:
    kind: openclaw-skills-root
    assignment: broken
    path: ${brokenRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.errors.some((entry) => entry.code === "source_read_failed"), true);

  const validAssignment = result.assignments.find((entry) => entry.assignmentPath === "openclaw");
  const brokenAssignment = result.assignments.find((entry) => entry.assignmentPath === "broken");

  assert.equal(validAssignment.statuses[0].status, "current");
  assert.equal(brokenAssignment.statuses[0].status, "unknown");
  assert.equal(brokenAssignment.errors[0].code, "source_read_failed");
});

test("status reports file targets as blocking target errors", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-file-target-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-file-target-root-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(installRoot, "office-hours"), "not a directory\n");
  await writeReceipt({
    installRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(sourceSkill)
  });
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.statuses[0].status, "unknown");
  const invalidTargetError = result.errors.find((entry) => entry.code === "invalid_target");
  assert.equal(invalidTargetError.path, path.join(installRoot, "office-hours"));
});

test("status reports target access errors instead of missing", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-target-access-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-target-access-root-"));
  t.after(async () => {
    await chmod(installRoot, 0o700).catch(() => {});
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  });

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  await chmod(installRoot, 0);
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.statuses[0].status, "unknown");
  assert.equal(result.errors.some((entry) => entry.code === "target_read_failed"), true);
});

test("status captures target read failures and continues other assignments", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-target-read-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const validSkill = path.join(sourceRoot, "skills", "office-hours");
  const brokenSkill = path.join(sourceRoot, "skills", "missing-skill-file");
  await mkdir(validSkill, { recursive: true });
  await mkdir(brokenSkill, { recursive: true });
  await writeFile(path.join(validSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await writeFile(path.join(brokenSkill, "SKILL.md"), "---\nname: missing-skill-file\nversion: 2026.06.10\n---\n");

  const validRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-target-valid-"));
  const brokenRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-target-broken-"));
  const lockedDir = path.join(brokenRoot, "missing-skill-file", "locked");
  t.after(async () => {
    await chmod(lockedDir, 0o700).catch(() => {});
    await rm(validRoot, { recursive: true, force: true });
    await rm(brokenRoot, { recursive: true, force: true });
  });

  await cp(validSkill, path.join(validRoot, "office-hours"), { recursive: true });
  await cp(brokenSkill, path.join(brokenRoot, "missing-skill-file"), { recursive: true });
  await mkdir(lockedDir);
  await chmod(lockedDir, 0);
  await writeReceipt({
    installRoot: validRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(validSkill)
  });
  await writeReceipt({
    installRoot: brokenRoot,
    sourceRoot,
    skillName: "missing-skill-file",
    version: "2026.06.10",
    sourceCommit: null,
    sourceHash: null
  });
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours
  broken:
    skills:
      - missing-skill-file

assignments:
  openclaw:
    suitcases:
      - core
  broken:
    suitcases:
      - broken

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${validRoot}
  broken:
    kind: openclaw-skills-root
    assignment: broken
    path: ${brokenRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.current, 1);
  assert.equal(result.summary.unknown, 1);
  const targetReadError = result.errors.find((entry) => entry.code === "target_read_failed");
  assert.equal(targetReadError.path, path.join(brokenRoot, "missing-skill-file"));

  const validAssignment = result.assignments.find((entry) => entry.assignmentPath === "openclaw");
  const brokenAssignment = result.assignments.find((entry) => entry.assignmentPath === "broken");

  assert.equal(validAssignment.statuses[0].status, "current");
  assert.equal(brokenAssignment.statuses[0].status, "unknown");
  assert.equal(brokenAssignment.errors[0].code, "target_read_failed");
});

test("status reports receipt-hash target read failures instead of dirty", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-target-hash-"));
  const installRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-status-target-hash-root-"));
  const lockedDir = path.join(installRoot, "office-hours", "locked");
  t.after(async () => {
    await chmod(lockedDir, 0o700).catch(() => {});
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });
  });

  const sourceSkill = path.join(sourceRoot, "skills", "office-hours");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\nversion: 2026.06.10\n---\n");
  await cp(sourceSkill, path.join(installRoot, "office-hours"), { recursive: true });
  await mkdir(lockedDir);
  await chmod(lockedDir, 0);
  await writeReceipt({
    installRoot,
    sourceRoot,
    skillName: "office-hours",
    version: "2026.06.10",
    sourceHash: await hashDirectory(sourceSkill)
  });
  await writeFile(
    path.join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - office-hours

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    kind: openclaw-skills-root
    assignment: openclaw
    path: ${installRoot}
`
  );

  const result = await status({ source: sourceRoot });

  assert.equal(result.ok, false);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.summary.dirty, 0);
  assert.equal(result.statuses[0].status, "unknown");
  assert.equal(result.statuses[0].installedHash, await hashDirectory(sourceSkill));
  const targetReadError = result.errors.find((entry) => entry.code === "target_read_failed");
  assert.equal(targetReadError.path, path.join(installRoot, "office-hours"));
});

async function writeReceipt({
  installRoot,
  sourceRoot,
  skillName,
  version,
  sourceCommit = "deadbeef",
  sourceHash,
  installedFiles
}) {
  const installRecord = buildInstallRecord({
    agent: "openclaw",
    mode: "copy",
    sourcePath: path.join(sourceRoot, "skills", skillName),
    targetPath: path.join(installRoot, skillName),
    version,
    sourceCommit,
    sourceHash,
    installedFiles
  });
  const receipt = buildReceipt({
    sourceRoot,
    sourceCommit,
    installs: { [skillName]: installRecord },
    sourceRef: "refs/heads/main"
  });

  await writeFile(
    path.join(installRoot, RECEIPT_FILE),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8"
  );
}

async function hashDirectory(root) {
  const digest = createHash("sha256");
  const entries = await listFiles(root);
  for (const entry of entries) {
    const bytes = await readFile(entry, "utf8");
    const relativePath = path.relative(root, entry);
    digest.update(relativePath);
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function listFiles(root) {
  const entries = [];
  const files = await readdir(root, { withFileTypes: true });
  for (const item of files) {
    const itemPath = path.join(root, item.name);
    if (item.isDirectory()) {
      entries.push(...(await listFiles(itemPath)));
      continue;
    }
    if (item.isFile()) {
      entries.push(itemPath);
    }
  }
  return entries.sort();
}
