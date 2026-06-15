import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { test } from "node:test";

function runCli(args: string[]) {
  return spawnSync("node", [join(process.cwd(), "dist", "src", "cli.js"), ...args], {
    encoding: "utf8"
  });
}

function parseJsonOutput(stdout: string): unknown {
  return JSON.parse(stdout.trim());
}

test("cli rejects unsupported track flags before writing receipts", async (t) => {
  const sourceRoot = await mkdtemp(join(os.tmpdir(), "skill-suitcase-cli-track-src-"));
  const targetRoot = await mkdtemp(join(os.tmpdir(), "skill-suitcase-cli-track-target-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));

  await mkdir(join(sourceRoot, "skills", "office-hours"), { recursive: true });
  await mkdir(join(targetRoot, "office-hours"), { recursive: true });
  await writeFile(
    join(sourceRoot, "skill-suitcase.yaml"),
    `suitcases:\n  core:\n    skills:\n      - office-hours\n\nassignments:\n  openclaw:\n    suitcases:\n      - core\n\nassignmentPaths:\n  openclaw:\n    kind: openclaw-skills-root\n    assignment: openclaw\n    path: ${targetRoot}\n`
  );
  const skillFile = "---\nname: office-hours\nversion: 2026.06.15\n---\n# Office Hours\n";
  await writeFile(join(sourceRoot, "skills", "office-hours", "SKILL.md"), skillFile);
  await writeFile(join(targetRoot, "office-hours", "SKILL.md"), skillFile);

  const result = runCli([
    "track",
    "--source",
    sourceRoot,
    "--target",
    "openclaw",
    "--skill",
    "office-hours",
    "--json",
    "--dry-run"
  ]);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes("Unknown argument: --dry-run"), true);
  assert.equal(result.stderr.includes("Usage:"), true);
  await assert.rejects(readFile(join(targetRoot, ".skill-suitcase-receipt.json"), "utf8"), /ENOENT/);
});

test("cli apply requires exactly one approval input", async (t) => {
  const sourceRoot = await mkdtemp(join(os.tmpdir(), "skill-suitcase-cli-apply-missing-input-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const missingApprovalResult = runCli([
    "apply",
    "--source",
    sourceRoot,
    "--target",
    "openclaw",
    "--json"
  ]);

  assert.equal(missingApprovalResult.status, 2);
  const usageOutput = `${missingApprovalResult.stdout}${missingApprovalResult.stderr}`;
  assert.equal(usageOutput.includes("Usage:"), true);

  const dualApprovalResult = runCli([
    "apply",
    "--source",
    sourceRoot,
    "--target",
    "openclaw",
    "--lock",
    join(sourceRoot, "plan-lock.json"),
    "--artifact",
    join(sourceRoot, "skill-suitcase-bundle.json"),
    "--json"
  ]);

  assert.equal(dualApprovalResult.status, 2);
  const dualUsageOutput = `${dualApprovalResult.stdout}${dualApprovalResult.stderr}`;
  assert.equal(dualUsageOutput.includes("Usage:"), true);
});

test("cli apply surfaces lock input validation failures", async (t) => {
  const sourceRoot = await mkdtemp(join(os.tmpdir(), "skill-suitcase-cli-apply-lock-invalid-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const result = runCli([
    "apply",
    "--source",
    sourceRoot,
    "--target",
    "openclaw",
    "--lock",
    join(sourceRoot, "plan-lock.json"),
    "--json"
  ]);

  assert.equal(result.status, 1);
  const parsed = parseJsonOutput(result.stdout);
  assert.equal(typeof parsed, "object");
  assert.equal((parsed as { ok: boolean }).ok, false);
  const errors = (parsed as { errors: Array<{ code: string }> }).errors;
  assert.equal(Array.isArray(errors), true);
  assert.equal(errors[0]?.code, "invalid_apply_input");
});

test("cli apply surfaces artifact input validation failures", async (t) => {
  const sourceRoot = await mkdtemp(join(os.tmpdir(), "skill-suitcase-cli-apply-artifact-invalid-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));

  const missingManifest = join(sourceRoot, "skill-suitcase-bundle.json");
  const missingResult = runCli([
    "apply",
    "--source",
    sourceRoot,
    "--target",
    "openclaw",
    "--artifact",
    missingManifest,
    "--json"
  ]);

  assert.equal(missingResult.status, 1);
  const missingParsed = parseJsonOutput(missingResult.stdout);
  assert.equal(typeof missingParsed, "object");
  assert.equal((missingParsed as { ok: boolean }).ok, false);
  const missingErrors = (missingParsed as { errors: Array<{ code: string }> }).errors;
  assert.equal(Array.isArray(missingErrors), true);
  assert.equal(missingErrors[0]?.code, "invalid_artifact_manifest");

  const malformedManifest = join(sourceRoot, "bad-bundle.json");
  await writeFile(malformedManifest, "not json");

  const malformedResult = runCli([
    "apply",
    "--source",
    sourceRoot,
    "--target",
    "openclaw",
    "--artifact",
    malformedManifest,
    "--json"
  ]);

  assert.equal(malformedResult.status, 1);
  const malformedParsed = parseJsonOutput(malformedResult.stdout);
  assert.equal(typeof malformedParsed, "object");
  assert.equal((malformedParsed as { ok: boolean }).ok, false);
  const malformedErrors = (malformedParsed as { errors: Array<{ code: string }> }).errors;
  assert.equal(Array.isArray(malformedErrors), true);
  assert.equal(malformedErrors[0]?.code, "invalid_artifact_manifest");
});

test("cli rollback accepts receipt paths and writes JSON to stdout", async (t) => {
  const installRoot = await mkdtemp(join(os.tmpdir(), "skill-suitcase-cli-rollback-"));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const receiptPath = join(installRoot, ".skill-suitcase-receipt.json");
  await writeFile(
    receiptPath,
    `${JSON.stringify({
      schema: "calvinnwq.skills.receipt.v0",
      installs: {}
    }, null, 2)}\n`
  );

  const result = runCli([
    "rollback",
    "--receipt",
    receiptPath,
    "--json"
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const parsed = parseJsonOutput(result.stdout) as { ok: boolean; receipt: string };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.receipt, receiptPath);
});

test("cli keeps JSON on stdout and usage errors on stderr", () => {
  const sourceRoot = join(process.cwd(), "tests", "fixtures", "skills-catalog");
  const validResult = runCli([
    "validate",
    "--source",
    sourceRoot,
    "--json"
  ]);

  assert.equal(validResult.status, 0);
  assert.equal(validResult.stderr, "");
  assert.equal((parseJsonOutput(validResult.stdout) as { ok: boolean }).ok, true);

  const usageResult = runCli([
    "validate",
    "--source",
    sourceRoot,
    "--json",
    "--unknown"
  ]);

  assert.equal(usageResult.status, 2);
  assert.equal(usageResult.stdout, "");
  assert.equal(usageResult.stderr.includes("Unknown argument: --unknown"), true);
  assert.equal(usageResult.stderr.includes("Usage:"), true);
});
