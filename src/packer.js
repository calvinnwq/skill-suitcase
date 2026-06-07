import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { plan } from "./planner.js";

export async function pack({ source, target, dryRun }) {
  if (!dryRun) {
    throw new Error("pack currently supports --dry-run only");
  }

  const planResult = await plan({ source, target });
  const files = [];

  if (planResult.ok) {
    for (const plannedSkill of planResult.planned) {
      files.push(...(await collectSkillFiles(plannedSkill)));
    }
  }

  return {
    ok: planResult.ok,
    dryRun: true,
    source: planResult.source,
    target,
    bundle: {
      action: "pack",
      outputPath: null,
      reason: "dry-run"
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
