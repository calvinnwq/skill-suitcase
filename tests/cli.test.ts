import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
