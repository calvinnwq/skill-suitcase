import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("package exposes architecture guardrail script", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
  assert.equal(packageJson.scripts?.["architecture:check"], "node scripts/check-architecture.mjs");
});

test("package exposes skill-suitcase as the only CLI bin", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { bin?: Record<string, string> };
  assert.deepEqual(packageJson.bin, { "skill-suitcase": "dist/src/cli.js" });
});

test("architecture guardrails pass on the current source tree", () => {
  const result = spawnSync("node", ["scripts/check-architecture.mjs"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout.includes("Architecture guardrails passed."), true);
  assert.equal(result.stderr, "");
});
