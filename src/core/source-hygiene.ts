import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { sourcePolicyDecision, type SourcePolicy } from "./source-policy.js";

export type PlannedSourceSkill = {
  skill: string;
  sourcePath: string;
};

export type SourceHygieneError = {
  code: "source_untracked_files" | "source_denied_path" | "source_hygiene_failed" | "source_path_outside_repo";
  message: string;
  skill: string;
  paths: string[];
};

export type SourceHygieneResult = {
  ok: boolean;
  errors: SourceHygieneError[];
};

/**
 * Checks selected source skill directories before a command snapshots or
 * installs them. Git-backed catalogs must not materialize untracked,
 * non-ignored files from selected source skills; non-Git sources remain allowed.
 */
export function checkSelectedSourceHygiene({
  sourceRoot,
  plannedSkills,
  sourcePolicy
}: {
  sourceRoot: string;
  plannedSkills: PlannedSourceSkill[];
  sourcePolicy?: SourcePolicy | undefined;
}): SourceHygieneResult {
  const selected = plannedSkills.filter(
    (item) => item.skill.trim().length > 0 && item.sourcePath.trim().length > 0
  );
  if (selected.length === 0) {
    return { ok: true, errors: [] };
  }

  const gitRoot = resolveGitRoot(sourceRoot);
  if (gitRoot === null) {
    return { ok: true, errors: [] };
  }

  const sourceRoots = selected.map((item) => {
    const comparablePath = resolveComparablePath(item.sourcePath);
    return {
      skill: item.skill,
      absolutePath: path.resolve(item.sourcePath),
      comparablePath,
      gitPath: normalizeGitPath(path.relative(gitRoot, comparablePath))
    };
  });
  const outsideRepo = sourceRoots.filter(
    (item) => item.gitPath.length === 0 || item.gitPath.startsWith("..") || path.isAbsolute(item.gitPath)
  );
  if (outsideRepo.length > 0) {
    return {
      ok: false,
      errors: outsideRepo.map((item) => ({
        code: "source_path_outside_repo",
        message: `Refusing to materialize ${item.skill}: source path ${item.absolutePath} is outside git repo ${gitRoot}.`,
        skill: item.skill,
        paths: [item.absolutePath]
      }))
    };
  }

  const gitPaths = sourceRoots
    .map((item) => item.gitPath)
    .filter((item) => item.length > 0);
  if (gitPaths.length === 0) {
    return { ok: true, errors: [] };
  }

  const result = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", ...gitPaths], {
    cwd: gitRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return {
      ok: false,
      errors: selected.map((item) => ({
        code: "source_hygiene_failed",
        message: `Refusing to materialize ${item.skill}: failed to inspect source git status for ${item.sourcePath}.`,
        skill: item.skill,
        paths: [item.sourcePath]
      }))
    };
  }
  if (result.stdout.length === 0) {
    return { ok: true, errors: [] };
  }

  const untrackedPaths = result.stdout.split("\0").filter((item) => item.length > 0);
  const pathsBySkill = new Map<string, string[]>();
  for (const gitPath of untrackedPaths) {
    const absolutePath = path.resolve(gitRoot, gitPath);
    const owner = sourceRoots.find((item) => isInsideOrEqual(absolutePath, item.comparablePath));
    if (owner === undefined) {
      continue;
    }
    const relativePath = normalizeGitPath(path.relative(owner.comparablePath, absolutePath));
    const policyDecision = sourcePolicyDecision(relativePath, sourcePolicy);
    if (policyDecision.action === "exclude") {
      continue;
    }
    const current = pathsBySkill.get(owner.skill) ?? [];
    current.push(relativePath);
    pathsBySkill.set(owner.skill, current);
  }

  const errors: SourceHygieneError[] = [];
  for (const [skill, paths] of [...pathsBySkill.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sortedPaths = [...new Set(paths)].sort();
    const deniedPaths = sortedPaths.filter((relativePath) => sourcePolicyDecision(relativePath, sourcePolicy).action === "deny");
    if (deniedPaths.length > 0) {
      errors.push({
        code: "source_denied_path",
        message: `Refusing to materialize ${skill}: source policy denies paths (${deniedPaths.join(", ")}). Remove them or adjust sourcePolicy before packing/applying.`,
        skill,
        paths: deniedPaths
      });
      continue;
    }
    errors.push({
      code: "source_untracked_files",
      message: `Refusing to materialize ${skill}: source skill contains untracked files (${sortedPaths.join(", ")}). Track or remove them before packing/applying.`,
      skill,
      paths: sortedPaths
    });
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function resolveGitRoot(sourceRoot: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  const gitRoot = result.stdout.trim();
  return gitRoot.length > 0 ? resolveComparablePath(gitRoot) : null;
}

function isInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeGitPath(value: string): string {
  return value.split(path.sep).join("/");
}

function resolveComparablePath(value: string): string {
  const absolutePath = path.resolve(value);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    return absolutePath;
  }
}
