import { access, stat } from "node:fs/promises";
import path from "node:path";
import { type Catalog, loadCatalog } from "../catalog/index.js";
import { platformCompatibilityNames } from "../platform-adapters.js";
import { isHermesCategorySegment } from "../hermes-categories.js";

type PlannerInput = {
  source: string;
  target: string;
  skills?: string[];
  assignmentPath?: string;
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
  destination: string;
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

export async function plan({ source, target, skills, assignmentPath }: PlannerInput): Promise<PlanResult> {
  if (!source) {
    throw new Error("source is required");
  }
  if (!target) {
    throw new Error("target is required");
  }

  const { sourceRoot, manifest } = await loadCatalog(source);
  const targetContext = resolvePlanTargetContext(manifest, target, assignmentPath);
  if (targetContext.error !== undefined) {
    return {
      ok: false,
      source: sourceRoot,
      target,
      planned: [],
      blocked: [],
      errors: [targetContext.error]
    };
  }
  const assignment = manifest.assignments[targetContext.assignment];

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
          message: `Unknown target assignment: ${targetContext.assignment}`
        }
      ]
    };
  }

  const selectedSkills = skills === undefined ? null : new Set(skills);
  const plannedSkills = resolveAssignmentSkills(manifest, assignment)
    .filter((skillName) => selectedSkills === null || selectedSkills.has(skillName));
  const compatibilityTargets = targetCompatibilityNames(
    targetContext.assignment,
    targetContext.compatibilityKinds
  );
  const planned: PlanItem[] = [];
  const blocked: PlanItem[] = [];
  const errors: PlanError[] = [];

  for (const skillName of plannedSkills) {
    const destination = resolveSkillDestination({
      skillName,
      assignment,
      categorized: targetContext.categorized
    });
    if (!destination.ok) {
      errors.push({
        code: destination.code,
        message: destination.message,
        skill: skillName
      });
      continue;
    }
    const compatibility = manifest.compatibility[skillName] ?? {};
    const variant = selectSkillVariant(manifest, skillName, compatibilityTargets);

    if (variant !== null) {
      const item = await safePlannedSkill(sourceRoot, skillName, compatibility, errors, destination.value, variant);
      if (item !== null) {
        planned.push(item);
      }
      continue;
    }

    const blockedReason = firstMatchingValue(compatibility.blockedAgents, compatibilityTargets);
    const compatibleAgents = compatibility.agents ?? [];

    if (blockedReason) {
      blocked.push(blockedSkill(sourceRoot, skillName, target, blockedReason, compatibility, destination.value));
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
          compatibility,
          destination.value
        )
      );
      continue;
    }

    const item = await safePlannedSkill(sourceRoot, skillName, compatibility, errors, destination.value);
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
  destination: string,
  variant: ResolvedSkillVariant | null = null
): Promise<PlanItem | null> {
  try {
    return await plannedSkill(sourceRoot, skillName, compatibility, destination, variant);
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

function targetCompatibilityNames(assignment: string, kinds: Array<string | null>): string[] {
  const names = new Set<string>([assignment]);
  for (const kind of kinds) {
    for (const name of platformCompatibilityNames({
      assignment,
      kind
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
  destination: string,
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
    destination,
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
  compatibility: Catalog["compatibility"][string],
  destination: string
): PlanItem {
  return {
    skill: skillName,
    action: "blocked",
    target,
    variant: compatibility.variant ?? "canonical",
    sourcePath: path.join(sourceRoot, "skills", skillName),
    destination,
    reason,
    evidence: compatibility.evidence ?? []
  };
}

function resolvePlanTargetContext(
  manifest: Catalog,
  target: string,
  assignmentPathId: string | undefined
): { assignment: string; categorized: boolean; compatibilityKinds: Array<string | null>; error?: PlanError } {
  const explicitPath = assignmentPathId ?? target;
  const direct = manifest.assignmentPaths?.[explicitPath];
  if (isRecord(direct)) {
    return {
      assignment: normalizeValue(direct.assignment) ?? target,
      categorized: normalizeValue(direct.kind) === "hermes-external-skills-root",
      compatibilityKinds: [normalizeValue(direct.kind)]
    };
  }

  const matching = Object.values(manifest.assignmentPaths ?? {}).filter(
    (entry) => isRecord(entry) && normalizeValue(entry.assignment) === target
  );
  const layouts = new Set(matching.map(
    (entry) => normalizeValue(entry.kind) === "hermes-external-skills-root" ? "categorized" : "flat"
  ));
  if (layouts.size > 1) {
    return {
      assignment: target,
      categorized: false,
      compatibilityKinds: [],
      error: {
        code: "ambiguous_assignment_path_layout",
        message: `Assignment ${target} has target paths with incompatible destination layouts.`
      }
    };
  }
  return {
    assignment: target,
    categorized: matching.length > 0 && normalizeValue(matching[0]?.kind) === "hermes-external-skills-root",
    compatibilityKinds: matching.length === 0
      ? [null]
      : matching.map((entry) => normalizeValue(entry.kind))
  };
}

type DestinationResolution =
  | { ok: true; value: string }
  | { ok: false; code: "missing_skill_category" | "invalid_skill_category"; message: string };

function resolveSkillDestination({
  skillName,
  assignment,
  categorized
}: {
  skillName: string;
  assignment: Catalog["assignments"][string];
  categorized: boolean;
}): DestinationResolution {
  if (!categorized) {
    return { ok: true, value: skillName };
  }

  const category = normalizeValue(assignment.categories?.[skillName]);
  if (category === null) {
    return {
      ok: false,
      code: "missing_skill_category",
      message: `Categorized target requires a category for ${skillName}.`
    };
  }
  if (!isHermesCategorySegment(category)) {
    return {
      ok: false,
      code: "invalid_skill_category",
      message: `Category for ${skillName} must be one Hermes-discoverable safe plain path segment.`
    };
  }
  return { ok: true, value: path.join(category, skillName) };
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
