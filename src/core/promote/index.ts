import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SKILLS_DIRECTORY } from "../../config/defaults.js";
import { isPathWithinRoot } from "../install-modes.js";

/**
 * Machine-readable conflict categories a read-only promote plan can surface
 * before any mutation. These mirror the promote/import-target conflict list in
 * ARCHITECTURE.md and the NGX-457 acceptance criteria.
 */
export type PromoteConflictCode =
  | "existing_repo_skill"
  | "unsafe_path"
  | "dirty_target"
  | "unsupported_layout";

export type PromoteConflict = {
  code: PromoteConflictCode;
  message: string;
  path: string | null;
};

/**
 * One declarative step in the promote workflow. The dry-run plan describes the
 * intended copy -> verify -> symlink -> receipt sequence without performing it.
 */
export type PromotePlanStep = {
  action: "copy" | "verify" | "symlink" | "receipt";
  description: string;
  from?: string;
  to?: string;
};

export type PromotePlanResult = {
  ok: boolean;
  dryRun: boolean;
  readOnly: boolean;
  source: string;
  targetSkill: string;
  skillName: string | null;
  repoSkillPath: string | null;
  plan: PromotePlanStep[];
  conflicts: PromoteConflict[];
  summary: {
    conflicts: number;
    steps: number;
  };
};

type PlanPromoteInput = {
  source: string;
  targetSkill: string;
};

const SKILL_FILE = "SKILL.md";

/**
 * Produce a read-only promote/import-target plan for a target-created skill.
 *
 * This never mutates anything: it stats and reads the target skill directory and
 * the catalog source path, then reports the intended workflow plus every
 * machine-readable conflict (existing repo skill, unsafe path, dirty target,
 * unsupported layout). Live copy/verify/symlink/receipt mutation is a separate,
 * approval-gated workflow.
 */
export async function planPromote({ source, targetSkill }: PlanPromoteInput): Promise<PromotePlanResult> {
  if (!source) {
    throw new Error("source is required");
  }
  if (!targetSkill) {
    throw new Error("targetSkill is required");
  }

  const sourceRoot = path.resolve(source);
  const targetSkillPath = path.resolve(targetSkill);
  const skillName = path.basename(targetSkillPath);
  const repoSkillsRoot = path.join(sourceRoot, DEFAULT_SKILLS_DIRECTORY);
  const repoSkillPath = path.join(repoSkillsRoot, skillName);

  const conflicts: PromoteConflict[] = [];
  const nameIsPlain = isPlainPathSegment(skillName);

  if (!nameIsPlain) {
    conflicts.push({
      code: "unsafe_path",
      message: `Target skill name ${skillName} is not a plain directory name and cannot be promoted into ${DEFAULT_SKILLS_DIRECTORY}/.`,
      path: targetSkillPath
    });
  } else {
    const relativeToSkillsRoot = path.relative(repoSkillsRoot, repoSkillPath);
    if (relativeToSkillsRoot === "" || relativeToSkillsRoot.startsWith("..") || path.isAbsolute(relativeToSkillsRoot)) {
      conflicts.push({
        code: "unsafe_path",
        message: `Promoted path ${repoSkillPath} would escape the catalog skills directory ${repoSkillsRoot}.`,
        path: repoSkillPath
      });
    }
  }

  if (await isPathWithinRoot({ candidatePath: targetSkillPath, rootPath: sourceRoot })) {
    conflicts.push({
      code: "unsafe_path",
      message: `Target skill ${targetSkillPath} already lives inside the source repo ${sourceRoot}; it is not a target-created skill.`,
      path: targetSkillPath
    });
  }

  const targetInfo = await lstatSafe(targetSkillPath);
  if (targetInfo === null) {
    conflicts.push({
      code: "unsupported_layout",
      message: `Target skill directory ${targetSkillPath} does not exist.`,
      path: targetSkillPath
    });
  } else if (targetInfo.isSymbolicLink()) {
    conflicts.push({
      code: "dirty_target",
      message: `Target skill ${targetSkillPath} is a symlink, not a real target-created directory.`,
      path: targetSkillPath
    });
  } else if (!targetInfo.isDirectory()) {
    conflicts.push({
      code: "unsupported_layout",
      message: `Target skill ${targetSkillPath} is not a directory.`,
      path: targetSkillPath
    });
  } else {
    const skillFile = path.join(targetSkillPath, SKILL_FILE);
    if (!(await isFile(skillFile))) {
      conflicts.push({
        code: "unsupported_layout",
        message: `Target skill ${targetSkillPath} is missing ${SKILL_FILE}.`,
        path: skillFile
      });
    }
    const nestedSymlink = await findNestedSymlink(targetSkillPath);
    if (nestedSymlink !== null) {
      conflicts.push({
        code: "dirty_target",
        message: `Target skill tree contains a symlink at ${nestedSymlink} and cannot be hash-verified safely.`,
        path: nestedSymlink
      });
    }
  }

  if (await pathExists(repoSkillPath)) {
    conflicts.push({
      code: "existing_repo_skill",
      message: `Catalog already contains a skill at ${repoSkillPath}; promotion needs a conflict decision.`,
      path: repoSkillPath
    });
  }

  const plan: PromotePlanStep[] = [
    {
      action: "copy",
      description: "Copy the target skill contents into the catalog source path.",
      from: targetSkillPath,
      to: repoSkillPath
    },
    {
      action: "verify",
      description: "Hash-verify the copied catalog source against the original target contents before swapping.",
      from: targetSkillPath,
      to: repoSkillPath
    },
    {
      action: "symlink",
      description: "Replace the target directory with a symlink back to the catalog source after verification.",
      from: targetSkillPath,
      to: repoSkillPath
    },
    {
      action: "receipt",
      description: "Write receipt metadata linking the target to the promoted catalog source.",
      to: repoSkillPath
    }
  ];

  return {
    ok: conflicts.length === 0,
    dryRun: true,
    readOnly: true,
    source: sourceRoot,
    targetSkill: targetSkillPath,
    skillName: nameIsPlain ? skillName : null,
    repoSkillPath: nameIsPlain ? repoSkillPath : null,
    plan,
    conflicts,
    summary: {
      conflicts: conflicts.length,
      steps: plan.length
    }
  };
}

async function findNestedSymlink(root: string): Promise<string | null> {
  const entries = await readDirSafe(root);

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const nested = await findNestedSymlink(entryPath);
      if (nested !== null) {
        return nested;
      }
    }
  }

  return null;
}

async function readDirSafe(root: string): Promise<Dirent[]> {
  try {
    return await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function lstatSafe(targetPath: string): Promise<Stats | null> {
  try {
    return await lstat(targetPath);
  } catch {
    return null;
  }
}

async function isFile(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isPlainPathSegment(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 &&
    trimmed === value &&
    trimmed !== "." &&
    trimmed !== ".." &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    !path.isAbsolute(trimmed);
}
