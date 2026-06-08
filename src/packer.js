import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCatalog } from "./catalog.js";
import { plan } from "./planner.js";

export async function pack({ source, target, dryRun = false, output = null }) {
  if (dryRun && output) {
    throw new Error("pack accepts either --dry-run or --output, not both");
  }

  if (!dryRun && !output) {
    throw new Error("pack requires --output unless --dry-run is set");
  }

  const planResult = await plan({ source, target });
  const files = [];

  if (planResult.ok) {
    for (const plannedSkill of planResult.planned) {
      files.push(...(await collectSkillFiles(plannedSkill)));
    }
  }

  const result = {
    ok: planResult.ok,
    dryRun,
    source: planResult.source,
    target,
    bundle: {
      action: "pack",
      outputPath: output ? path.resolve(output) : null,
      manifestPath: output ? path.join(path.resolve(output), "skill-suitcase-bundle.json") : null,
      reason: dryRun ? "dry-run" : "written"
    },
    planned: planResult.planned,
    blocked: planResult.blocked,
    files,
    summary: {
      skills: planResult.planned.length,
      blocked: planResult.blocked.length,
      files: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0)
    },
    errors: planResult.errors
  };

  if (!dryRun && result.ok) {
    await writeBundle({ source, output, result });
  }

  return result;
}

async function writeBundle({ source, output, result }) {
  const outputPath = path.resolve(output);
  const { manifest } = await loadCatalog(source);
  assertOutputIsNotInstallRoot(outputPath, manifest);

  await mkdir(outputPath, { recursive: false });

  for (const file of result.files) {
    const bundleFile = path.join(outputPath, file.bundlePath);
    await mkdir(path.dirname(bundleFile), { recursive: true });
    await copyFile(file.sourcePath, bundleFile);
  }

  await writeFile(
    result.bundle.manifestPath,
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8"
  );
}

function assertOutputIsNotInstallRoot(outputPath, manifest) {
  const installRoots = [];

  for (const assignmentPath of Object.values(manifest.assignmentPaths)) {
    for (const key of ["path", "skillsPath"]) {
      if (assignmentPath[key]) {
        installRoots.push(path.resolve(assignmentPath[key]));
      }
    }
  }

  for (const installRoot of installRoots) {
    if (isInsideOrEqual(outputPath, installRoot)) {
      throw new Error(`Refusing to pack into install target path: ${installRoot}`);
    }
  }
}

function isInsideOrEqual(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function collectSkillFiles(plannedSkill) {
  const sourceRoot = plannedSkill.sourcePath;
  const filePaths = await listFiles(sourceRoot);
  const files = [];

  for (const filePath of filePaths) {
    const bytes = await readFile(filePath);
    files.push({
      skill: plannedSkill.skill,
      relativePath: path.relative(sourceRoot, filePath),
      sourcePath: filePath,
      bundlePath: path.join("skills", plannedSkill.skill, path.relative(sourceRoot, filePath)),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }

  files.sort((left, right) => left.bundlePath.localeCompare(right.bundlePath));
  return files;
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      const info = await stat(entryPath);
      if (info.isFile()) {
        files.push(entryPath);
      }
    }
  }

  return files.sort();
}
