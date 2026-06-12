import { access, stat } from "node:fs/promises";
import path from "node:path";
import { type Catalog, loadCatalog } from "../catalog/index.js";

type FindingLevel = "error" | "warning";

type Finding = {
  level: FindingLevel;
  code: string;
  message: string;
  path: string | null;
};

type ValidationSummary = {
  suitcases: number;
  assignments: number;
  assignmentPaths: number;
  referencedSkills: number;
  findings: number;
};

type ValidateArgs = {
  source: string;
};

type ValidateResult = {
  ok: boolean;
  source: string;
  manifestPath: string;
  summary: ValidationSummary;
  findings: Finding[];
};

export async function validate({ source }: ValidateArgs): Promise<ValidateResult> {
  const { sourceRoot, manifestPath, manifest } = await loadCatalog(source);
  const findings: Finding[] = [];
  const referencedSkills = collectReferencedSkills(manifest);

  if (Object.keys(manifest.suitcases).length === 0) {
    findings.push(error("missing_suitcases", "Manifest must define at least one suitcase."));
  }

  if (Object.keys(manifest.assignments).length === 0) {
    findings.push(error("missing_assignments", "Manifest must define at least one assignment."));
  }

  for (const [assignmentName, assignment] of Object.entries(manifest.assignments)) {
    if (assignment.suitcases.length === 0) {
      findings.push(
        error(
          "empty_assignment",
          `Assignment ${assignmentName} must reference at least one suitcase.`,
          `assignments.${assignmentName}`
        )
      );
    }

    for (const suitcaseName of assignment.suitcases) {
      if (!manifest.suitcases[suitcaseName]) {
        findings.push(
          error(
            "unknown_suitcase",
            `Assignment ${assignmentName} references unknown suitcase ${suitcaseName}.`,
            `assignments.${assignmentName}.suitcases`
          )
        );
      }
    }
  }

  for (const [suitcaseName, suitcase] of Object.entries(manifest.suitcases)) {
    if (suitcase.skills.length === 0) {
      findings.push(
        error(
          "empty_suitcase",
          `Suitcase ${suitcaseName} must include at least one skill.`,
          `suitcases.${suitcaseName}.skills`
        )
      );
    }

    for (const skillName of suitcase.skills) {
      await validateSkill(sourceRoot, skillName, findings);
    }
  }

  for (const skillName of Object.keys(manifest.compatibility)) {
    if (!referencedSkills.has(skillName)) {
      findings.push(
        warning(
          "unused_compatibility",
          `Compatibility entry ${skillName} is not referenced by any suitcase.`,
          `compatibility.${skillName}`
        )
      );
    }
  }

  for (const [pathName, assignmentPath] of Object.entries(manifest.assignmentPaths)) {
    if (assignmentPath.assignment && !manifest.assignments[assignmentPath.assignment]) {
      findings.push(
        error(
          "unknown_assignment_path_target",
          `Assignment path ${pathName} points at unknown assignment ${assignmentPath.assignment}.`,
          `assignmentPaths.${pathName}.assignment`
        )
      );
    }
  }

  return {
    ok: findings.every((finding) => finding.level !== "error"),
    source: sourceRoot,
    manifestPath,
    summary: {
      suitcases: Object.keys(manifest.suitcases).length,
      assignments: Object.keys(manifest.assignments).length,
      assignmentPaths: Object.keys(manifest.assignmentPaths).length,
      referencedSkills: referencedSkills.size,
      findings: findings.length
    },
    findings
  };
}

function collectReferencedSkills(manifest: Catalog): Set<string> {
  const skills = new Set<string>();

  for (const suitcase of Object.values(manifest.suitcases)) {
    for (const skillName of suitcase.skills) {
      skills.add(skillName);
    }
  }

  return skills;
}

async function validateSkill(sourceRoot: string, skillName: string, findings: Finding[]): Promise<void> {
  const skillPath = path.join(sourceRoot, "skills", skillName);
  const skillFile = path.join(skillPath, "SKILL.md");

  if (!(await isDirectory(skillPath))) {
    findings.push(
      error(
        "missing_skill_directory",
        `Skill ${skillName} is referenced but ${skillPath} does not exist.`,
        `skills.${skillName}`
      )
    );
    return;
  }

  if (!(await isFile(skillFile))) {
    findings.push(
      error(
        "missing_skill_file",
        `Skill ${skillName} is missing SKILL.md.`,
        `skills.${skillName}.SKILL.md`
      )
    );
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return (await stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

function error(code: string, message: string, pathName: string | null = null): Finding {
  return finding("error", code, message, pathName);
}

function warning(code: string, message: string, pathName: string | null = null): Finding {
  return finding("warning", code, message, pathName);
}

function finding(level: FindingLevel, code: string, message: string, pathName: string | null): Finding {
  return {
    level,
    code,
    message,
    path: pathName
  };
}
