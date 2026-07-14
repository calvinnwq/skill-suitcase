import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { prune, PRUNE_TRANSACTION_SCHEMA } from "../src/prune.js";
import {
  buildInstallRecord,
  buildInstalledFiles,
  LEGACY_RECEIPT_SCHEMA,
  RECEIPT_FILE,
  readReceipt,
  upsertAndWriteReceipt,
  writeReceipt
} from "../src/receipt.js";

type Fixture = {
  sourceRoot: string;
  targetRoot: string;
  directoryTarget: string;
  symlinkTarget: string;
};

async function createFixture(t: { after(fn: () => Promise<void> | void): void }): Promise<Fixture> {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-prune-src-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-prune-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  for (const skill of ["current", "dir-old", "link-old"]) {
    await mkdir(path.join(sourceRoot, "skills", skill), { recursive: true });
    await writeFile(path.join(sourceRoot, "skills", skill, "SKILL.md"), `---\nname: ${skill}\n---\n# ${skill}\n`);
  }
  await writeFile(path.join(sourceRoot, "skill-suitcase.yaml"), `suitcases:
  core:
    skills:
      - current

assignments:
  codex:
    suitcases:
      - core

assignmentPaths:
  codex:
    kind: codex-home
    assignment: codex
    codexHome: ${path.dirname(targetRoot)}
    skillsPath: ${targetRoot}

compatibility:
  current:
    agents:
      - codex
`);

  const directoryTarget = path.join(targetRoot, "dir-old");
  const symlinkTarget = path.join(targetRoot, "link-old");
  await mkdir(directoryTarget);
  await writeFile(path.join(directoryTarget, "SKILL.md"), "---\nname: dir-old\n---\n# dir-old\n");
  const linkSource = path.join(sourceRoot, "skills", "link-old");
  await symlink(linkSource, symlinkTarget);

  await writeReceipt({
    installRoot: targetRoot,
    receipt: {
      installs: {
        "dir-old": buildInstallRecord({
          skill: "dir-old", agent: "codex", target: "codex", mode: "copy",
          sourcePath: path.join(sourceRoot, "skills", "dir-old"), targetPath: directoryTarget,
          sourceHash: "dir-source", installedFiles: await buildInstalledFiles(directoryTarget)
        }),
        "link-old": buildInstallRecord({
          skill: "link-old", agent: "codex", target: "codex", mode: "symlink",
          sourcePath: linkSource, targetPath: symlinkTarget, sourceHash: "link-source",
          installedFiles: await buildInstalledFiles(linkSource)
        })
      }
    }
  });
  return { sourceRoot, targetRoot, directoryTarget, symlinkTarget };
}

test("prune dry-run plans explicit obsolete directory and symlink without mutation", async (t) => {
  const fixture = await createFixture(t);
  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["link-old", "dir-old"],
    dryRun: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.equal("targetIdentity" in result, false);
  assert.equal(result.summary.directories, 1);
  assert.equal(result.summary.symlinks, 1);
  assert.equal(typeof result.plan.id, "string");
  assert.deepEqual(result.candidates.map((candidate) => [candidate.skill, candidate.kind]), [
    ["dir-old", "directory"],
    ["link-old", "symlink"]
  ]);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
  assert.equal(await readlink(fixture.symlinkTarget), path.join(fixture.sourceRoot, "skills", "link-old"));
  assert.equal(result.transactionPath, null);
});

test("flat-target prune refuses a receipt target nested below the skill path", async (t) => {
  const fixture = await createFixture(t);
  const receipt = await readReceipt({ installRoot: fixture.targetRoot });
  const raw = receipt.installs?.["dir-old"];
  assert.notEqual(raw, undefined);
  const record = Array.isArray(raw) ? raw[0]! : raw!;
  record.targetPath = path.join(fixture.targetRoot, "unrelated", "dir-old");
  await writeReceipt({ installRoot: fixture.targetRoot, receipt });

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "missing_receipt_record"), true);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
});

test("prune refuses provider read-only policy with a writable adapter", async (t) => {
  const fixture = await createFixture(t);
  const manifestPath = path.join(fixture.sourceRoot, "skill-suitcase.yaml");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    manifest
      .replaceAll("codex", "opencode")
      .replace(
        `    kind: opencode-home\n    assignment: opencode\n    opencodeHome: ${path.dirname(fixture.targetRoot)}\n    skillsPath: ${fixture.targetRoot}`,
        `    kind: agents-skills-root\n    assignment: opencode\n    path: ${fixture.targetRoot}`
      )
  );
  const receipt = await readReceipt({ installRoot: fixture.targetRoot });
  for (const value of Object.values(receipt.installs ?? {})) {
    for (const record of Array.isArray(value) ? value : [value]) {
      record.agent = "opencode";
      record.target = "opencode";
    }
  }
  await writeReceipt({ installRoot: fixture.targetRoot, receipt });

  const result = await prune({
    source: fixture.sourceRoot,
    target: "opencode",
    skills: ["dir-old"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.plan.id, null);
  assert.equal(result.errors.some((error) => error.code === "read_only_target"), true);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
});

test("prune preserves apply refusal semantics for early validation failures", async () => {
  const blankSkill = await prune({
    source: ".",
    target: "codex",
    skills: ["   "],
    planId: "reviewed-plan",
    apply: true
  });
  assert.equal(blankSkill.ok, false);
  assert.equal(blankSkill.dryRun, false);
  assert.equal(blankSkill.readOnly, true);
  assert.equal(blankSkill.errors[0]?.code, "invalid_skill_filter");

  const blankPlanId = await prune({
    source: ".",
    target: "codex",
    skills: ["obsolete"],
    planId: "   ",
    apply: true
  });
  assert.equal(blankPlanId.ok, false);
  assert.equal(blankPlanId.dryRun, false);
  assert.equal(blankPlanId.readOnly, true);
  assert.equal(blankPlanId.errors[0]?.code, "missing_plan_id");
});

test("prune refuses legacy receipts without migrating them", async (t) => {
  const fixture = await createFixture(t);
  const modernReceiptPath = path.join(fixture.targetRoot, RECEIPT_FILE);
  const receipt = JSON.parse(await readFile(modernReceiptPath, "utf8")) as Record<string, unknown>;
  await rm(modernReceiptPath);
  await writeFile(
    path.join(fixture.targetRoot, ".skills-sync.json"),
    `${JSON.stringify({ ...receipt, schema: LEGACY_RECEIPT_SCHEMA }, null, 2)}\n`
  );

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old"],
    dryRun: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "invalid_receipt"), true);
  await assert.rejects(stat(modernReceiptPath), /ENOENT/);
  assert.equal((await stat(path.join(fixture.targetRoot, ".skills-sync.json"))).isFile(), true);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
});

test("prune builds its receipt hash and candidates from one snapshot", async (t) => {
  const fixture = await createFixture(t);
  const receiptPath = path.join(fixture.targetRoot, RECEIPT_FILE);
  const receiptText = await readFile(receiptPath, "utf8");

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old"],
    dryRun: true,
    __test: {
      afterReceiptSnapshot: async () => {
        await writeReceipt({ installRoot: fixture.targetRoot, receipt: { installs: {} } });
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.candidates[0]?.skill, "dir-old");
  assert.equal(result.plan.receiptHash, createHash("sha256").update(receiptText).digest("hex"));
  const currentReceipt = await readReceipt({ installRoot: fixture.targetRoot });
  assert.equal(currentReceipt.installs?.["dir-old"], undefined);
});

test("prune apply quarantines directories, removes symlinks, and updates receipt", async (t) => {
  const fixture = await createFixture(t);
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old", "link-old"], dryRun: true });
  assert.ok(dryRun.plan.id);

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old", "link-old"],
    planId: dryRun.plan.id,
    apply: true
  });

  assert.equal(result.ok, true);
  assert.equal("targetIdentity" in result, false);
  assert.deepEqual(result.pruned, { skills: ["dir-old", "link-old"], directories: 1, symlinks: 1 });
  await assert.rejects(stat(fixture.directoryTarget), /ENOENT/);
  await assert.rejects(stat(fixture.symlinkTarget), /ENOENT/);
  const quarantined = result.candidates.find((candidate) => candidate.skill === "dir-old")?.quarantinePath;
  assert.ok(quarantined);
  assert.equal((await stat(quarantined)).isDirectory(), true);
  const receipt = await readReceipt({ installRoot: fixture.targetRoot });
  assert.equal(receipt.installs?.["dir-old"], undefined);
  assert.equal(receipt.installs?.["link-old"], undefined);
  assert.ok(result.transactionPath);
  const transaction = JSON.parse(await readFile(result.transactionPath, "utf8"));
  assert.equal(transaction.schema, PRUNE_TRANSACTION_SCHEMA);
  assert.equal(transaction.status, "committed");
  assert.ok(result.receiptBackupPath);
});

test("prune apply preserves restrictive receipt permissions for replacement and backup", async (t) => {
  const fixture = await createFixture(t);
  const receiptPath = path.join(fixture.targetRoot, ".skill-suitcase-receipt.json");
  await chmod(receiptPath, 0o640);
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.ok(dryRun.plan.id);

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old"],
    planId: dryRun.plan.id,
    apply: true
  });

  assert.equal(result.ok, true);
  assert.ok(result.receiptBackupPath);
  assert.equal((await stat(receiptPath)).mode & 0o777, 0o640);
  assert.equal((await stat(result.receiptBackupPath)).mode & 0o777, 0o640);
});

test("prune dry-run refuses unreadable candidate files without mutation", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root can read files regardless of mode bits");
    return;
  }
  const fixture = await createFixture(t);
  const skillFile = path.join(fixture.directoryTarget, "SKILL.md");
  await chmod(skillFile, 0o000);
  t.after(() => chmod(skillFile, 0o600).catch(() => undefined));

  const result = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_unreadable"), true);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
  assert.equal(result.transactionPath, null);
});

test("prune dry-run reports readable candidate content drift without mutation", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.directoryTarget, "SKILL.md"), "drift\n");

  const result = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_drift"), true);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
  assert.equal(result.transactionPath, null);
});

test("prune refuses assigned skills", async (t) => {
  const fixture = await createFixture(t);
  const result = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["current"], dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "skill_still_assigned"), true);
  assert.deepEqual(result.preserved.assigned, ["current"]);
});

test("prune preserves assigned skills even when their catalog source cannot be planned", async (t) => {
  const fixture = await createFixture(t);
  await rm(path.join(fixture.sourceRoot, "skills", "current"), { recursive: true });
  const result = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["current"], dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "skill_still_assigned"), true);
  assert.deepEqual(result.preserved.assigned, ["current"]);
});

test("prune refuses malformed target assignments instead of treating them as empty", async (t) => {
  const fixture = await createFixture(t);
  const manifestPath = path.join(fixture.sourceRoot, "skill-suitcase.yaml");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, manifest.replace("assignment: codex", "assignment: missing-assignment"));

  const result = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((error) => error.code === "invalid_target" || error.code === "assignment_unverifiable"),
    true
  );
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
});

test("prune returns a structured refusal when assignment planning throws", async (t) => {
  const fixture = await createFixture(t);
  const manifestPath = path.join(fixture.sourceRoot, "skill-suitcase.yaml");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, manifest.replace("      - core", "      - missing"));

  const result = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "assignment_unverifiable"), true);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
});

test("prune refuses malformed receipt install entries", async (t) => {
  const fixture = await createFixture(t);
  const receiptPath = path.join(fixture.targetRoot, ".skill-suitcase-receipt.json");
  const receipt = await readReceipt({ installRoot: fixture.targetRoot });
  receipt.installs!["dir-old"] = null as never;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  const result = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "invalid_receipt"), true);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
});

test("prune apply refuses drift after review", async (t) => {
  const fixture = await createFixture(t);
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.ok(dryRun.plan.id);
  await writeFile(path.join(fixture.directoryTarget, "extra.txt"), "drift\n");

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old"],
    planId: dryRun.plan.id,
    apply: true
  });
  assert.equal(result.ok, false);
  assert.equal(result.dryRun, false);
  assert.equal(result.readOnly, true);
  assert.equal(result.errors.some((error) => error.code === "target_drift" || error.code === "stale_plan"), true);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
});

test("prune apply refusal preserves apply mode for a stale plan id", async (t) => {
  const fixture = await createFixture(t);
  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old"],
    planId: "not-the-reviewed-plan",
    apply: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.dryRun, false);
  assert.equal(result.readOnly, true);
  assert.equal(result.errors.some((error) => error.code === "stale_plan"), true);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
});

test("prune does not recreate an install root removed before lock acquisition", async (t) => {
  const fixture = await createFixture(t);
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.ok(dryRun.plan.id);

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old"],
    planId: dryRun.plan.id,
    apply: true,
    __test: {
      beforeLock: () => rm(fixture.targetRoot, { recursive: true })
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "receipt_lock_failed"), true);
  await assert.rejects(stat(fixture.targetRoot), /ENOENT/);
});

test("prune refuses unreceipted directory entry kinds", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(path.join(fixture.directoryTarget, "empty"));
  let result = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "target_drift"), true);

  await rm(path.join(fixture.directoryTarget, "empty"), { recursive: true });
  await symlink("SKILL.md", path.join(fixture.directoryTarget, "linked-skill"));
  result = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "unsupported_target_entry"), true);
});

test("prune requires complete receipt ownership identity", async (t) => {
  const cases: Array<[string, (record: Record<string, unknown>) => void]> = [
    ["skill", (record) => { record["skill"] = "other"; }],
    ["target", (record) => { record["agent"] = "claude"; }],
    ["mode", (record) => { record["mode"] = "provider"; }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const fixture = await createFixture(t);
      const receipt = await readReceipt({ installRoot: fixture.targetRoot });
      const record = receipt.installs?.["dir-old"];
      assert.ok(record && !Array.isArray(record));
      mutate(record);
      await writeReceipt({ installRoot: fixture.targetRoot, receipt });

      const result = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
      assert.equal(result.ok, false);
      assert.equal(result.errors.some((error) => error.code === "missing_receipt_record"), true);
      assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
    });
  }
});

test("prune accepts receipt ownership written by promote", async (t) => {
  const fixture = await createFixture(t);
  const receipt = await readReceipt({ installRoot: fixture.targetRoot });
  const record = receipt.installs?.["link-old"];
  assert.ok(record && !Array.isArray(record));
  record.agent = fixture.targetRoot;
  record.target = fixture.targetRoot;
  await writeReceipt({ installRoot: fixture.targetRoot, receipt });

  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["link-old"], dryRun: true });
  assert.equal(dryRun.ok, true);
  assert.ok(dryRun.plan.id);
  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["link-old"],
    planId: dryRun.plan.id,
    apply: true
  });

  assert.equal(result.ok, true);
  await assert.rejects(stat(fixture.symlinkTarget), /ENOENT/);
});

test("prune revalidates each candidate immediately before mutation", async (t) => {
  const fixture = await createFixture(t);
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.ok(dryRun.plan.id);

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old"],
    planId: dryRun.plan.id,
    apply: true,
    __test: {
      beforeMutationForSkill: async () => {
        await writeFile(path.join(fixture.directoryTarget, "late-drift.txt"), "drift\n");
      }
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "prune_apply_failed"), true);
  assert.equal(await readFile(path.join(fixture.directoryTarget, "late-drift.txt"), "utf8"), "drift\n");
});

test("prune refuses a skill assigned after planning but before mutation", async (t) => {
  const fixture = await createFixture(t);
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.ok(dryRun.plan.id);

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old"],
    planId: dryRun.plan.id,
    apply: true,
    __test: {
      beforeMutationForSkill: async () => {
        const manifestPath = path.join(fixture.sourceRoot, "skill-suitcase.yaml");
        const manifest = await readFile(manifestPath, "utf8");
        await writeFile(manifestPath, manifest.replace("      - current", "      - current\n      - dir-old"));
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.message.includes("became assigned")), true);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
  const receipt = await readReceipt({ installRoot: fixture.targetRoot });
  assert.ok(receipt.installs?.["dir-old"]);
});

test("prune revalidates every assignment before committing the receipt", async (t) => {
  const fixture = await createFixture(t);
  const dryRun = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old", "link-old"],
    dryRun: true
  });
  assert.ok(dryRun.plan.id);

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old", "link-old"],
    planId: dryRun.plan.id,
    apply: true,
    __test: {
      beforeMutationForSkill: async (skill) => {
        if (skill !== "link-old") return;
        const manifestPath = path.join(fixture.sourceRoot, "skill-suitcase.yaml");
        const manifest = await readFile(manifestPath, "utf8");
        await writeFile(manifestPath, manifest.replace("      - current", "      - current\n      - dir-old"));
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.message.includes("dir-old became assigned")), true);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
  assert.equal(await readlink(fixture.symlinkTarget), path.join(fixture.sourceRoot, "skills", "link-old"));
  const receipt = await readReceipt({ installRoot: fixture.targetRoot });
  assert.ok(receipt.installs?.["dir-old"]);
  assert.ok(receipt.installs?.["link-old"]);
});

test("prune revalidates assignments after preparing the replacement receipt", async (t) => {
  const fixture = await createFixture(t);
  const receiptPath = path.join(fixture.targetRoot, RECEIPT_FILE);
  const receiptBefore = await readFile(receiptPath, "utf8");
  const dryRun = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old", "link-old"],
    dryRun: true
  });
  assert.ok(dryRun.plan.id);

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old", "link-old"],
    planId: dryRun.plan.id,
    apply: true,
    __test: {
      afterReceiptPrepared: async () => {
        const manifestPath = path.join(fixture.sourceRoot, "skill-suitcase.yaml");
        const manifest = await readFile(manifestPath, "utf8");
        await writeFile(manifestPath, manifest.replace("      - current", "      - current\n      - dir-old"));
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.message.includes("dir-old became assigned")), true);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
  assert.equal(await readlink(fixture.symlinkTarget), path.join(fixture.sourceRoot, "skills", "link-old"));
  assert.equal(await readFile(receiptPath, "utf8"), receiptBefore);
});

test("prune preserves a receipt update that starts during apply", async (t) => {
  const fixture = await createFixture(t);
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.ok(dryRun.plan.id);
  let concurrentWrite: Promise<string> | null = null;

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old"],
    planId: dryRun.plan.id,
    apply: true,
    __test: {
      beforeMutationForSkill: () => {
        concurrentWrite = upsertAndWriteReceipt({
          installRoot: fixture.targetRoot,
          skillName: "other",
          installRecord: buildInstallRecord({
            skill: "other",
            agent: "codex",
            target: "codex",
            mode: "copy",
            sourcePath: path.join(fixture.sourceRoot, "skills", "other"),
            targetPath: path.join(fixture.targetRoot, "other"),
            sourceHash: "other-source",
            installedFiles: []
          })
        });
      }
    }
  });
  assert.equal(result.ok, true);
  assert.ok(concurrentWrite);
  await concurrentWrite;
  const receipt = await readReceipt({ installRoot: fixture.targetRoot });
  assert.equal(receipt.installs?.["dir-old"], undefined);
  assert.ok(receipt.installs?.["other"]);
});

test("prune never follows the old deterministic receipt temp path", async (t) => {
  const fixture = await createFixture(t);
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.ok(dryRun.plan.id);
  const victim = path.join(fixture.sourceRoot, "victim.txt");
  await writeFile(victim, "preserve\n");
  const oldTempPath = path.join(
    fixture.targetRoot,
    `.skill-suitcase-receipt.prune-${dryRun.plan.id}.tmp`
  );
  await symlink(victim, oldTempPath);

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old"],
    planId: dryRun.plan.id,
    apply: true
  });
  assert.equal(result.ok, true);
  assert.equal(await readFile(victim, "utf8"), "preserve\n");
  assert.equal(await readlink(oldTempPath), victim);
});

test("prune rolls back a mixed batch when apply fails", async (t) => {
  const fixture = await createFixture(t);
  const receiptBefore = await readFile(path.join(fixture.targetRoot, ".skill-suitcase-receipt.json"), "utf8");
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old", "link-old"], dryRun: true });
  assert.ok(dryRun.plan.id);

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old", "link-old"],
    planId: dryRun.plan.id,
    apply: true,
    __test: { failAfterMutationForSkill: "link-old" }
  });
  assert.equal(result.ok, false);
  assert.equal(result.pruned.skills.length, 0);
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
  assert.equal(await readlink(fixture.symlinkTarget), path.join(fixture.sourceRoot, "skills", "link-old"));
  assert.equal(await readFile(path.join(fixture.targetRoot, ".skill-suitcase-receipt.json"), "utf8"), receiptBefore);
});

test("prune preserves a pre-existing quarantine root when setup fails", async (t) => {
  const fixture = await createFixture(t);
  const receiptPath = path.join(fixture.targetRoot, ".skill-suitcase-receipt.json");
  const receiptBefore = await readFile(receiptPath, "utf8");
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.ok(dryRun.plan.id);
  assert.ok(dryRun.plan.quarantineRoot);
  const sentinelPath = path.join(dryRun.plan.quarantineRoot, "sentinel.txt");
  await mkdir(dryRun.plan.quarantineRoot);
  await writeFile(sentinelPath, "preserve\n");

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["dir-old"],
    planId: dryRun.plan.id,
    apply: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.code === "prune_apply_failed"), true);
  assert.equal(await readFile(sentinelPath, "utf8"), "preserve\n");
  assert.equal((await stat(fixture.directoryTarget)).isDirectory(), true);
  assert.equal(await readFile(receiptPath, "utf8"), receiptBefore);
  assert.equal(result.transactionPath, null);
  assert.equal(result.receiptBackupPath, null);
});

test("prune retains receipt backup when later rollback work fails", async (t) => {
  const fixture = await createFixture(t);
  const receiptPath = path.join(fixture.targetRoot, ".skill-suitcase-receipt.json");
  const receiptBefore = await readFile(receiptPath, "utf8");
  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["link-old"], dryRun: true });
  assert.ok(dryRun.plan.id);

  const result = await prune({
    source: fixture.sourceRoot,
    target: "codex",
    skills: ["link-old"],
    planId: dryRun.plan.id,
    apply: true,
    __test: {
      afterReceiptWrite: async () => {
        await writeFile(fixture.symlinkTarget, "blocks symlink rollback\n");
      },
      failAfterReceipt: true
    }
  });

  assert.equal(result.ok, false);
  assert.equal(await readFile(receiptPath, "utf8"), receiptBefore);
  assert.ok(result.receiptBackupPath);
  assert.equal(await readFile(result.receiptBackupPath, "utf8"), receiptBefore);
  assert.ok(result.transactionPath);
  assert.equal((await stat(result.transactionPath)).isFile(), true);
});

test("prune removes only the selected target record from a multi-target receipt", async (t) => {
  const fixture = await createFixture(t);
  const receipt = await readReceipt({ installRoot: fixture.targetRoot });
  const current = receipt.installs?.["dir-old"];
  assert.ok(current && !Array.isArray(current));
  const otherTargetPath = path.join(path.dirname(fixture.targetRoot), "other-root", "dir-old");
  receipt.installs!["dir-old"] = [
    current,
    buildInstallRecord({
      skill: "dir-old", agent: "claude", target: "claude", mode: "copy",
      sourcePath: path.join(fixture.sourceRoot, "skills", "dir-old"), targetPath: otherTargetPath,
      sourceHash: "other-source", installedFiles: current.installedFiles
    })
  ];
  await writeReceipt({ installRoot: fixture.targetRoot, receipt });

  const dryRun = await prune({ source: fixture.sourceRoot, target: "codex", skills: ["dir-old"], dryRun: true });
  assert.ok(dryRun.plan.id);
  const result = await prune({
    source: fixture.sourceRoot, target: "codex", skills: ["dir-old"],
    planId: dryRun.plan.id, apply: true
  });
  assert.equal(result.ok, true);
  const after = await readReceipt({ installRoot: fixture.targetRoot });
  const remaining = after.installs?.["dir-old"];
  assert.ok(remaining && !Array.isArray(remaining));
  assert.equal(remaining.targetPath, otherTargetPath);
});

test("prune CLI keeps dry-run JSON on stdout and requires plan id for apply", async (t) => {
  const fixture = await createFixture(t);
  const cli = path.join(process.cwd(), "dist", "src", "cli.js");
  const dryRun = spawnSync("node", [
    cli, "prune", "--source", fixture.sourceRoot, "--target", "codex",
    "--skill", "dir-old", "--dry-run", "--json"
  ], { encoding: "utf8" });
  assert.equal(dryRun.status, 0);
  assert.equal(dryRun.stderr, "");
  const payload = JSON.parse(dryRun.stdout) as { ok: boolean; plan: { id: string } };
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.plan.id, "string");

  const missingPlan = spawnSync("node", [
    cli, "prune", "--source", fixture.sourceRoot, "--target", "codex",
    "--skill", "dir-old", "--apply", "--json"
  ], { encoding: "utf8" });
  assert.equal(missingPlan.status, 2);
  assert.equal(missingPlan.stdout, "");
  assert.equal(missingPlan.stderr.includes("Usage:"), true);
});
