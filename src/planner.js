import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseSuitcaseManifest } from "./suitcase-manifest.js";

export async function plan({ source, target }) {
  if (!source) {
    throw new Error("source is required");
  }
  if (!target) {
    throw new Error("target is required");
  }

  const sourceRoot = path.resolve(source);
  const manifestPath = path.join(sourceRoot, "skill-suitcase.yaml");
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = parseSuitcaseManifest(manifestText);
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

  const plannedSkills = resolveAssignmentSkills(manifest, assignment);
  const compatibilityTargets = targetCompatibilityNames(target);
  const planned = [];
  const blocked = [];

  for (const skillName of plannedSkills) {
    const compatibility = manifest.compatibility[skillName] ?? {};
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

    planned.push(await plannedSkill(sourceRoot, skillName, compatibility));
  }

  return {
    ok: blocked.length === 0,
    source: sourceRoot,
    target,
    planned,
    blocked,
    errors: []
  };
}

function resolveAssignmentSkills(manifest, assignment) {
  const skills = [];
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

function targetCompatibilityNames(target) {
  const names = [target];

  if (target.includes("codex") && target !== "codex") {
    names.push("codex");
  }
  if (target.includes("claude") && target !== "claude") {
    names.push("claude");
  }

  return names;
}

function firstMatchingValue(record, keys) {
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

async function plannedSkill(sourceRoot, skillName, compatibility) {
  const skillPath = path.join(sourceRoot, "skills", skillName);
  await assertDirectory(skillPath, `Missing skill directory for ${skillName}`);

  return {
    skill: skillName,
    action: "install",
    variant: compatibility.variant ?? "canonical",
    sourcePath: skillPath,
    evidence: compatibility.evidence ?? []
  };
}

function blockedSkill(sourceRoot, skillName, target, reason, compatibility) {
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

async function assertDirectory(targetPath, message) {
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
