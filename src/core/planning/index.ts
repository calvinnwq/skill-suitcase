import { access, stat } from "node:fs/promises";
import path from "node:path";
import { type Catalog, loadCatalog } from "../catalog/index.js";
import { platformCompatibilityNames } from "../platform-adapters.js";

type PlannerInput = {
  source: string;
  target: string;
  skills?: string[];
};

type PlanItem = {
  skill: string;
  action: "install" | "blocked";
  target?: string;
  reason?: string;
  variant: string;
  sourcePath: string;
  evidence: string[];
  source?: string;
};

type PlanError = {
  code: string;
  message: string;
  skill?: string;
};

export type PlanResult = {
  ok: boolean;
  source: string;
  target: string;
  planned: PlanItem[];
  blocked: PlanItem[];
  errors: PlanError[];
};

export async function plan({ source, target, skills }: PlannerInput): Promise<PlanResult> {
  if (!source) {
    throw new Error("source is required");
  }
  if (!target) {
    throw new Error("target is required");
  }

  const { sourceRoot, manifest } = await loadCatalog(source);
  const assignment = manifest.assignments[target];

  if (!assignment) {
    return {
      ok: false,
      source: sourceRoot,
      target,
      planned: [],
      blocked: [],
      errors: [
        {
          code: "unknown_target",
          message: `Unknown target assignment: ${target}`
        }
      ]
    };
  }

  const selectedSkills = skills === undefined ? null : new Set(skills);
  const plannedSkills = resolveAssignmentSkills(manifest, assignment)
    .filter((skillName) => selectedSkills === null || selectedSkills.has(skillName));
  const compatibilityTargets = targetCompatibilityNames(manifest, target);
  const planned: PlanItem[] = [];
  const blocked: PlanItem[] = [];
  const errors: PlanError[] = [];

  for (const skillName of plannedSkills) {
    const compatibility = manifest.compatibility[skillName] ?? {};
    const variant = selectSkillVariant(manifest, skillName, compatibilityTargets);

    if (variant !== null) {
      const item = await safePlannedSkill(sourceRoot, skillName, compatibility, errors, variant);
      if (item !== null) {
        planned.push(item);
      }
      continue;
    }

    const blockedReason = firstMatchingValue(compatibility.blockedAgents, compatibilityTargets);
    const compatibleAgents = compatibility.agents ?? [];

    if (blockedReason) {
      blocked.push(blockedSkill(sourceRoot, skillName, target, blockedReason, compatibility));
      continue;
    }

    if (
      compatibleAgents.length > 0 &&
      !compatibleAgents.some((agent) => compatibilityTargets.includes(agent))
    ) {
      blocked.push(
        blockedSkill(
          sourceRoot,
          skillName,
          target,
          compatibility.reason ?? `Skill ${skillName} is not compatible with ${target}.`,
          compatibility
        )
      );
      continue;
    }

    const item = await safePlannedSkill(sourceRoot, skillName, compatibility, errors);
    if (item !== null) {
      planned.push(item);
    }
  }

  return {
    ok: blocked.length === 0 && errors.length === 0,
    source: sourceRoot,
    target,
    planned,
    blocked,
    errors
  };
}

async function safePlannedSkill(
  sourceRoot: string,
  skillName: string,
  compatibility: Catalog["compatibility"][string],
  errors: PlanError[],
  variant: ResolvedSkillVariant | null = null
): Promise<PlanItem | null> {
  try {
    return await plannedSkill(sourceRoot, skillName, compatibility, variant);
  } catch (error) {
    errors.push({
      code: "source_missing",
      message: error instanceof Error ? error.message : `Missing skill directory for ${skillName}`,
      skill: skillName
    });
    return null;
  }
}

function resolveAssignmentSkills(manifest: Catalog, assignment: Catalog["assignments"][string]): string[] {
  const skills: string[] = [];
  const seen = new Set();

  for (const suitcaseName of assignment.suitcases) {
    const suitcase = manifest.suitcases[suitcaseName];
    if (!suitcase) {
      throw new Error(`Assignment references unknown suitcase: ${suitcaseName}`);
    }

    for (const skillName of suitcase.skills) {
      if (!seen.has(skillName)) {
        seen.add(skillName);
        skills.push(skillName);
      }
    }
  }

  return skills;
}

function targetCompatibilityNames(manifest: Catalog, target: string): string[] {
  const names = new Set<string>([target]);
  const assignmentPaths = manifest.assignmentPaths ?? {};

  if (!isRecord(assignmentPaths)) {
    return [...names];
  }

  for (const assignmentPath of Object.values(assignmentPaths)) {
    if (!isRecord(assignmentPath)) {
      continue;
    }
    if (normalizeValue(assignmentPath.assignment) !== target) {
      continue;
    }

    for (const name of platformCompatibilityNames({
      assignment: target,
      kind: normalizeValue(assignmentPath.kind)
    })) {
      names.add(name);
    }
  }

  return [...names];
}

function firstMatchingValue(record: Catalog["compatibility"][string]["blockedAgents"], keys: string[]): string | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    if (record[key]) {
      return record[key];
    }
  }

  return null;
}

async function plannedSkill(
  sourceRoot: string,
  skillName: string,
  compatibility: Catalog["compatibility"][string],
  variant: ResolvedSkillVariant | null = null
): Promise<PlanItem> {
  const sourceRelativePath = variant?.source ?? path.join("skills", skillName);
  const skillPath = path.join(sourceRoot, sourceRelativePath);
  await assertDirectory(skillPath, `Missing skill directory for ${skillName}`);

  const item: PlanItem = {
    skill: skillName,
    action: "install",
    variant: variant?.name ?? compatibility.variant ?? "canonical",
    sourcePath: skillPath,
    evidence: compatibility.evidence ?? []
  };
  if (variant?.source !== undefined) {
    item.source = variant.source;
  }
  return item;
}

function blockedSkill(
  sourceRoot: string,
  skillName: string,
  target: string,
  reason: string,
  compatibility: Catalog["compatibility"][string]
): PlanItem {
  return {
    skill: skillName,
    action: "blocked",
    target,
    variant: compatibility.variant ?? "canonical",
    sourcePath: path.join(sourceRoot, "skills", skillName),
    reason,
    evidence: compatibility.evidence ?? []
  };
}

type ResolvedSkillVariant = {
  name: string;
  source: string;
};

function selectSkillVariant(
  manifest: Catalog,
  skillName: string,
  compatibilityTargets: string[]
): ResolvedSkillVariant | null {
  const variants = manifest.variants?.[skillName];
  if (!isRecord(variants)) {
    return null;
  }

  for (const [variantName, variant] of Object.entries(variants)) {
    if (!isRecord(variant)) {
      continue;
    }
    const source = normalizeValue(variant.source);
    if (!source) {
      continue;
    }
    const agents = Array.isArray(variant.agents)
      ? variant.agents.filter((agent): agent is string => typeof agent === "string")
      : [];
    if (agents.some((agent) => compatibilityTargets.includes(agent))) {
      return {
        name: variantName,
        source
      };
    }
  }

  return null;
}

async function assertDirectory(targetPath: string, message: string): Promise<void> {
  try {
    await access(targetPath);
    const info = await stat(targetPath);
    if (!info.isDirectory()) {
      throw new Error(message);
    }
  } catch {
    throw new Error(message);
  }
}

function normalizeValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
