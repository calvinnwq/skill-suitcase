#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parsePackJson, validatePackResult } from "./package-validation.mjs";

const execFileAsync = promisify(execFile);
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
    command: "targets"
  }, null, 2)}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
