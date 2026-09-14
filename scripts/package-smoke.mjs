#!/usr/bin/env node

import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isRegistryUnavailable, parseCliJson } from "./package-smoke-helpers.mjs";
import { parsePackJson, validatePackResult } from "./package-validation.mjs";

const execFileAsync = promisify(execFile);

function runInstalledCli(binPath, args, options) {
  const result = spawnSync(binPath, args, { ...options, encoding: "utf8" });
  return { ...result, json: () => parseCliJson(result) };
}
const root = process.cwd();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-package-smoke-"));

try {
  const packDirectory = path.join(tempRoot, "pack");
  await mkdir(packDirectory);
  const { stdout: packStdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", packDirectory],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 }
  );
  const packResult = parsePackJson(packStdout);
  const validated = await validatePackResult(root, packResult);
  const tarballPath = path.join(packDirectory, validated.filename);

  const installDirectory = path.join(tempRoot, "install");
  await mkdir(installDirectory);
  await writeFile(
    path.join(installDirectory, "package.json"),
    `${JSON.stringify({ name: "skill-suitcase-install-smoke", private: true }, null, 2)}\n`
  );
  await execFileAsync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
    { cwd: installDirectory, maxBuffer: 10 * 1024 * 1024 }
  );

  const catalogDirectory = path.join(installDirectory, "catalog");
  const targetDirectory = path.join(installDirectory, "target");
  await mkdir(catalogDirectory);
  await writeFile(
    path.join(catalogDirectory, "skill-suitcase.yaml"),
    [
      "suitcases:",
      "  smoke:",
      "    skills: []",
      "assignments:",
      "  smoke:",
      "    suitcases:",
      "      - smoke",
      "assignmentPaths:",
      "  smoke:",
      "    kind: agents-skills-root",
      `    path: ${targetDirectory}`,
      "    assignment: smoke",
      ""
    ].join("\n")
  );

  const binPath = path.join(installDirectory, "node_modules", ".bin", "skill-suitcase");
  const { stdout: cliStdout, stderr: cliStderr } = await execFileAsync(
    binPath,
    ["targets", "--source", catalogDirectory, "--json"],
    { cwd: installDirectory, maxBuffer: 10 * 1024 * 1024 }
  );
  if (cliStderr !== "") {
    throw new Error(`installed skill-suitcase wrote unexpected stderr: ${cliStderr.trim()}`);
  }
  const cliResult = JSON.parse(cliStdout);
  if (
    cliResult.ok !== true
      || !Array.isArray(cliResult.targets)
      || !cliResult.targets.some((target) => target.id === "smoke" && target.assignment === "smoke")
  ) {
    throw new Error(`installed skill-suitcase returned an unexpected result: ${cliStdout.trim()}`);
  }

  const installedSampleCatalog = path.join(
    installDirectory,
    "node_modules",
    "skill-suitcase",
    "examples",
    "sample-catalog"
  );
  const { stdout: sampleStdout, stderr: sampleStderr } = await execFileAsync(
    binPath,
    ["validate", "--source", installedSampleCatalog, "--strict", "--json"],
    { cwd: installDirectory, maxBuffer: 10 * 1024 * 1024 }
  );
  if (sampleStderr !== "") {
    throw new Error(`installed sample validation wrote unexpected stderr: ${sampleStderr.trim()}`);
  }
  const sampleResult = JSON.parse(sampleStdout);
  if (
    sampleResult.ok !== true
      || sampleResult.summary?.contractsEvaluated !== 1
      || sampleResult.summary?.contractsComplete !== 1
      || sampleResult.summary?.findings !== 0
  ) {
    throw new Error(`installed sample catalog failed strict validation: ${sampleStdout.trim()}`);
  }
  const { stderr: sampleTestStderr } = await execFileAsync(
    "python3",
    ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
    {
      cwd: installedSampleCatalog,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      maxBuffer: 10 * 1024 * 1024
    }
  );
  if (!sampleTestStderr.includes("Ran 2 tests") || !sampleTestStderr.includes("OK")) {
    throw new Error(`installed sample contract tests returned an unexpected result: ${sampleTestStderr.trim()}`);
  }

  const globalPrefix = path.join(tempRoot, "global-prefix");
  const smokeHome = path.join(tempRoot, "home");
  await mkdir(globalPrefix);
  await mkdir(smokeHome);
  const globalEnv = {
    ...process.env,
    HOME: smokeHome,
    XDG_CACHE_HOME: path.join(smokeHome, ".cache"),
    npm_config_prefix: globalPrefix,
    npm_config_cache: path.join(tempRoot, "npm-cache"),
    npm_config_userconfig: path.join(smokeHome, ".npmrc"),
    npm_config_globalconfig: path.join(smokeHome, "npmrc-global"),
    npm_config_update_notifier: "false"
  };

  const localUpdate = runInstalledCli(binPath, ["update", "--json"], { cwd: installDirectory, env: globalEnv });
  const localUpdateResult = localUpdate.json();
  if (
    localUpdate.status !== 1
      || localUpdate.stderr !== ""
      || localUpdateResult.ok !== false
      || localUpdateResult.status !== "unsupported-installation"
      || localUpdateResult.installation?.reason !== "outside-global-root"
  ) {
    throw new Error(`project-local skill-suitcase did not refuse self-update: ${localUpdate.stdout.trim()} ${localUpdate.stderr.trim()}`);
  }

  await execFileAsync(
    "npm",
    ["install", "--global", "--prefix", globalPrefix, "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
    { cwd: globalPrefix, env: globalEnv, maxBuffer: 10 * 1024 * 1024 }
  );
  const globalBinPath = path.join(globalPrefix, "bin", "skill-suitcase");
  const globalHelp = runInstalledCli(globalBinPath, ["update", "--help"], { cwd: globalPrefix, env: globalEnv });
  if (globalHelp.status !== 0 || globalHelp.stdout !== "" || !globalHelp.stderr.includes("Usage:")) {
    throw new Error(`global skill-suitcase update --help misbehaved: ${globalHelp.stdout.trim()} ${globalHelp.stderr.trim()}`);
  }
  const globalCheck = runInstalledCli(globalBinPath, ["update", "--check", "--json"], { cwd: globalPrefix, env: globalEnv });
  const globalCheckResult = globalCheck.json();
  const checkSucceeded = globalCheck.status === 0 && globalCheckResult.ok === true;
  const checkOffline = isRegistryUnavailable(globalCheck.status, globalCheckResult);
  if (
    globalCheck.stderr !== ""
      || globalCheckResult.action !== "check"
      || globalCheckResult.installation?.kind !== "npm-global"
      || globalCheckResult.installation?.canSelfUpdate !== true
      || !(checkSucceeded || checkOffline)
  ) {
    throw new Error(`global skill-suitcase update --check returned an unexpected result: ${globalCheck.stdout.trim()} ${globalCheck.stderr.trim()}`);
  }

  const installedPackageJson = JSON.parse(
    await readFile(path.join(installDirectory, "node_modules", "skill-suitcase", "package.json"), "utf8")
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    node: process.version,
    npm: (await execFileAsync("npm", ["--version"])).stdout.trim(),
    package: `${installedPackageJson.name}@${installedPackageJson.version}`,
    entries: validated.entryCount,
    bin: validated.bin,
    command: "targets",
    sampleValidation: "strict",
    sampleContractTests: "passed",
    localSelfUpdate: "refused",
    globalSelfUpdateCheck: checkSucceeded ? globalCheckResult.status : globalCheckResult.error.code
  }, null, 2)}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
