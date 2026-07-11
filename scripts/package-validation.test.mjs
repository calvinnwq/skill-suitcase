import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CLI_BIN_PATH,
  parsePackJson,
  recordPackageBuild,
  validatePackageBuild,
  validatePackageMetadata,
  validatePackResult
} from "./package-validation.mjs";

test("public package metadata and files allowlist stay pinned", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.doesNotThrow(() => validatePackageMetadata(packageJson));

  assert.throws(
    () => validatePackageMetadata({ ...packageJson, bin: { suitcase: CLI_BIN_PATH } }),
    /package metadata bin/
  );
  assert.throws(
    () => validatePackageMetadata({ ...packageJson, files: [...packageJson.files, "scripts"] }),
    /package files allowlist/
  );
});

test("build validation rejects changed inputs and missing, stale, or non-executable CLI output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-package-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const inputPath of ["package.json", "pnpm-lock.yaml", "tsconfig.json"]) {
    await cp(inputPath, path.join(root, inputPath));
  }
  await cp("src", path.join(root, "src"), { recursive: true });
  await cp("dist/src", path.join(root, "dist/src"), { recursive: true });

  await recordPackageBuild(root);
  await validatePackageBuild(root);

  for (const inputPath of ["package.json", "pnpm-lock.yaml", "tsconfig.json"]) {
    const fixtureInputPath = path.join(root, inputPath);
    const originalInput = await readFile(fixtureInputPath, "utf8");
    await writeFile(fixtureInputPath, `${originalInput}\n`);
    await assert.rejects(
      validatePackageBuild(root),
      new RegExp(`stale package build: build input changed.*${inputPath.replaceAll(".", "\\.")}`)
    );
    await writeFile(fixtureInputPath, originalInput);
  }

  const cliSourcePath = path.join(root, "src", "cli.ts");
  const originalSource = await readFile(cliSourcePath, "utf8");
  await writeFile(cliSourcePath, `${originalSource}\n`);
  await assert.rejects(validatePackageBuild(root), /stale package build: source changed/);

  await writeFile(cliSourcePath, originalSource);
  const cliOutputPath = path.join(root, CLI_BIN_PATH);
  const originalOutput = await readFile(cliOutputPath, "utf8");
  await writeFile(cliOutputPath, `${originalOutput}\n`);
  await assert.rejects(validatePackageBuild(root), /stale package build: compiled output changed/);

  await writeFile(cliOutputPath, originalOutput);
  const additionalOutputPath = path.join(root, "dist", "src", "unintended.js");
  await writeFile(additionalOutputPath, "export {};\n");
  await assert.rejects(validatePackageBuild(root), /package build manifest mismatch.*unintended\.js/);

  await rm(additionalOutputPath);
  await chmod(path.join(root, CLI_BIN_PATH), 0o644);
  await assert.rejects(validatePackageBuild(root), /not executable/);

  await rm(path.join(root, CLI_BIN_PATH));
  await assert.rejects(validatePackageBuild(root), /package build manifest mismatch|CLI bin is missing/);
});

test("npm pack JSON must describe exactly one package", () => {
  assert.throws(() => parsePackJson("not-json"), /did not emit valid JSON/);
  assert.throws(() => parsePackJson("[]"), /exactly one package/);
  assert.deepEqual(
    parsePackJson(JSON.stringify([{ filename: "skill-suitcase-0.15.0.tgz", files: [] }])),
    { filename: "skill-suitcase-0.15.0.tgz", files: [] }
  );
});

test("packed payload validation rejects a missing bin, lost executable mode, and unintended files", async () => {
  await recordPackageBuild();
  const packResult = parsePackJson(execFileSync(
    "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  ));
  await validatePackResult(process.cwd(), packResult);

  const missingBin = structuredClone(packResult);
  missingBin.files = missingBin.files.filter((file) => file.path !== CLI_BIN_PATH);
  await assert.rejects(validatePackResult(process.cwd(), missingBin), /npm package payload mismatch.*dist\/src\/cli\.js/);

  const nonExecutableBin = structuredClone(packResult);
  nonExecutableBin.files.find((file) => file.path === CLI_BIN_PATH).mode = 0o644;
  await assert.rejects(validatePackResult(process.cwd(), nonExecutableBin), /packed CLI bin is not executable/);

  for (const unexpectedPath of ["docs/internal-private.md", "skills/skill-suitcase/private.txt"]) {
    const unintendedFile = structuredClone(packResult);
    unintendedFile.files.push({ path: unexpectedPath, size: 1, mode: 0o644 });
    await assert.rejects(
      validatePackResult(process.cwd(), unintendedFile),
      new RegExp(`npm package payload mismatch.*${unexpectedPath.replace(/[./]/g, "\\$&")}`)
    );
  }
});
