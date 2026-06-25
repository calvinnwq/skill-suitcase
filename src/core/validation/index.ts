import { access, stat } from "node:fs/promises";
import path from "node:path";
import { type Catalog, loadCatalog } from "../catalog/index.js";
import { loadUpstreamLock } from "../upstream/index.js";
import { type ContractReport, scoreSkillContract } from "./skillify-contract.js";

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
  groups: number;
  upstreamDeclarations: number;
  referencedSkills: number;
  contractsEvaluated: number;
  contractsComplete: number;
  contractsSkippedUpstream: number;
  contractsSkippedExternal: number;
  contractsSkippedLegacy: number;
  findings: number;
};

type ValidateArgs = {
  source: string;
  strict?: boolean;
};

type ValidateResult = {
  ok: boolean;
  source: string;
  manifestPath: string;
  strict: boolean;
  summary: ValidationSummary;
  findings: Finding[];
  contracts: ContractReport[];
};

export async function validate({ source, strict = false }: ValidateArgs): Promise<ValidateResult> {
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

  for (const [groupName, group] of Object.entries(manifest.groups)) {
    if (!isPlainPathSegment(groupName)) {
      findings.push(
        error(
          "invalid_group",
          `Group ${groupName} must be a plain manifest key.`,
          `groups.${groupName}`
        )
      );
    }

    const skills = group.skills ?? [];
    const suitcases = group.suitcases ?? [];
    const assignments = group.assignments ?? [];

    if (skills.length === 0 && suitcases.length === 0 && assignments.length === 0) {
      findings.push(
        warning(
          "empty_group",
          `Group ${groupName} does not reference any skills, suitcases, or assignments.`,
          `groups.${groupName}`
        )
      );
    }

    for (const skillName of skills) {
      if (!referencedSkills.has(skillName)) {
        findings.push(
          error(
            "unknown_group_skill",
            `Group ${groupName} references unknown skill ${skillName}.`,
            `groups.${groupName}.skills`
          )
        );
      }
    }

    for (const suitcaseName of suitcases) {
      if (!manifest.suitcases[suitcaseName]) {
        findings.push(
          error(
            "unknown_group_suitcase",
            `Group ${groupName} references unknown suitcase ${suitcaseName}.`,
            `groups.${groupName}.suitcases`
          )
        );
      }
    }

    for (const assignmentName of assignments) {
      if (!manifest.assignments[assignmentName]) {
        findings.push(
          error(
            "unknown_group_assignment",
            `Group ${groupName} references unknown assignment ${assignmentName}.`,
            `groups.${groupName}.assignments`
          )
        );
      }
    }
  }

  validateSourcePolicyMetadata(manifest.sourcePolicy, findings);

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

  const upstream = await loadUpstreamLock(sourceRoot);
  const upstreamManagedSkills = new Set(upstream.declarations.map((declaration) => declaration.skill));
  const policySkips = validateSkillifySkipPolicy(
    manifest.validationPolicy.skillify.skip,
    referencedSkills,
    upstreamManagedSkills,
    findings
  );
  const skippedContractSkills = new Set([
    ...upstreamManagedSkills,
    ...policySkips.externalManagedSkills,
    ...policySkips.legacyLocalSkills
  ]);
  const contracts = strict ? await scoreReferencedContracts(sourceRoot, referencedSkills, findings, skippedContractSkills) : [];
  findings.push(
    ...upstream.findings.map((item) => ({
      level: "error" as const,
      code: item.code,
      message: item.message,
      path: item.path
    }))
  );

  for (const declaration of upstream.declarations) {
    if (!referencedSkills.has(declaration.skill)) {
      findings.push(
        error(
          "unreferenced_upstream_skill",
          `Upstream declaration ${declaration.skill} is not referenced by any suitcase.`,
          `upstream.skills.${declaration.skill}`
        )
      );
    }
  }

  return {
    ok: findings.every((finding) => finding.level !== "error"),
    source: sourceRoot,
    manifestPath,
    strict,
    summary: {
      suitcases: Object.keys(manifest.suitcases).length,
      assignments: Object.keys(manifest.assignments).length,
      assignmentPaths: Object.keys(manifest.assignmentPaths).length,
      groups: Object.keys(manifest.groups).length,
      upstreamDeclarations: upstream.declarations.length,
      referencedSkills: referencedSkills.size,
      contractsEvaluated: contracts.length,
      contractsComplete: contracts.filter((report) => report.complete).length,
      contractsSkippedUpstream: strict ? countIntersectingSkills(referencedSkills, upstreamManagedSkills) : 0,
      contractsSkippedExternal: strict ? countIntersectingSkills(referencedSkills, policySkips.externalManagedSkills) : 0,
      contractsSkippedLegacy: strict ? countIntersectingSkills(referencedSkills, policySkips.legacyLocalSkills) : 0,
      findings: findings.length
    },
    findings,
    contracts
  };
}

type SkillifySkipPolicy = Catalog["validationPolicy"]["skillify"]["skip"];
type SkillifyPolicySkipSets = {
  externalManagedSkills: Set<string>;
  legacyLocalSkills: Set<string>;
};

function validateSkillifySkipPolicy(
  policy: SkillifySkipPolicy,
  referencedSkills: Set<string>,
  upstreamManagedSkills: Set<string>,
  findings: Finding[]
): SkillifyPolicySkipSets {
  const externalManagedSkills = new Set<string>();
  const legacyLocalSkills = new Set<string>();
  const validKinds = new Set(["external-managed", "legacy-local", "upstream-managed"]);

  for (const [skillName, entry] of Object.entries(policy)) {
    const pathName = `validationPolicy.skillify.skip.${skillName}`;

    if (!isPlainPathSegment(skillName)) {
      findings.push(error(
        "invalid_skillify_skip_skill_name",
        `Skillify skip entry ${skillName} must be a plain skill name.`,
        pathName
      ));
      continue;
    }

    if (!referencedSkills.has(skillName)) {
      findings.push(error(
        "unreferenced_skillify_skip",
        `Skillify skip entry ${skillName} is not referenced by any suitcase.`,
        pathName
      ));
    }

    const kind = entry.kind?.trim() ?? "";
    if (!validKinds.has(kind)) {
      findings.push(error(
        "invalid_skillify_skip_kind",
        `Skillify skip entry ${skillName} must use kind external-managed, legacy-local, or upstream-managed.`,
        `${pathName}.kind`
      ));
      continue;
    }

    if (kind === "upstream-managed") {
      if (!upstreamManagedSkills.has(skillName)) {
        findings.push(error(
          "invalid_skillify_skip_upstream",
          `Skillify skip entry ${skillName} is marked upstream-managed but is not declared in the upstream lock.`,
          pathName
        ));
      }
      if (hasNonBlankValue(entry.reason) || hasNonBlankValue(entry.source) || hasNonBlankValue(entry.owner)) {
        findings.push(warning(
          "redundant_skillify_upstream_skip_metadata",
          `Skillify skip entry ${skillName} duplicates upstream-lock metadata; the upstream lock remains the source of truth.`,
          pathName
        ));
      }
      continue;
    }

    if (upstreamManagedSkills.has(skillName)) {
      findings.push(error(
        "invalid_skillify_skip_upstream_overlap",
        `Skillify skip entry ${skillName} is already upstream-managed; keep upstream ownership in the upstream lock.`,
        pathName
      ));
      continue;
    }

    let hasValidProvenance = true;
    for (const field of ["source", "owner", "reason"] as const) {
      if (!hasNonBlankValue(entry[field])) {
        findings.push(error(
          "missing_skillify_skip_metadata",
          `Skillify skip entry ${skillName} kind ${kind} must include ${field}.`,
          `${pathName}.${field}`
        ));
        hasValidProvenance = false;
      }
    }

    if (kind === "legacy-local") {
      const reviewAfter = entry.reviewAfter;
      if (!hasNonBlankValue(reviewAfter)) {
        findings.push(error(
          "missing_skillify_skip_review_after",
          `Skillify skip entry ${skillName} kind legacy-local must include reviewAfter.`,
          `${pathName}.reviewAfter`
        ));
      } else if (!isIsoDate(reviewAfter)) {
        findings.push(error(
          "invalid_skillify_skip_review_after",
          `Skillify skip entry ${skillName} reviewAfter must use YYYY-MM-DD.`,
          `${pathName}.reviewAfter`
        ));
      }
      findings.push(warning(
        "legacy_skillify_skip",
        `Skill ${skillName} is temporarily exempt from Skillify-10 as legacy-local until ${entry.reviewAfter ?? "an unspecified review date"}.`,
        pathName
      ));
      legacyLocalSkills.add(skillName);
      continue;
    }

    const reviewAfter = entry.reviewAfter;
    if (!hasNonBlankValue(reviewAfter)) {
      findings.push(warning(
        "missing_skillify_skip_review_after",
        `Skillify skip entry ${skillName} kind external-managed has no reviewAfter; add one if the external ownership should be rechecked later.`,
        `${pathName}.reviewAfter`
      ));
    } else if (!isIsoDate(reviewAfter)) {
      findings.push(error(
        "invalid_skillify_skip_review_after",
        `Skillify skip entry ${skillName} reviewAfter must use YYYY-MM-DD.`,
        `${pathName}.reviewAfter`
      ));
      hasValidProvenance = false;
    }

    if (hasValidProvenance) {
      externalManagedSkills.add(skillName);
    }
  }

  return {
    externalManagedSkills,
    legacyLocalSkills
  };
}

function hasNonBlankValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validateSourcePolicyMetadata(sourcePolicy: Catalog["sourcePolicy"], findings: Finding[]): void {
  for (const field of ["exclude", "deny"] as const) {
    for (const [index, pattern] of (sourcePolicy[field] ?? []).entries()) {
      const pathName = `sourcePolicy.${field}.${index}`;
      if (pattern.trim().length === 0) {
        findings.push(error(
          "empty_source_policy_pattern",
          `sourcePolicy.${field} contains an empty pattern.`,
          pathName
        ));
        continue;
      }

      if (hasParentTraversalSegment(pattern)) {
        findings.push(error(
          "invalid_source_policy_pattern",
          `sourcePolicy.${field} pattern ${pattern} must not contain parent traversal segments.`,
          pathName
        ));
      }
    }
  }
}

function hasParentTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === "..");
}

async function scoreReferencedContracts(
  sourceRoot: string,
  referencedSkills: Set<string>,
  findings: Finding[],
  upstreamManagedSkills: Set<string>
): Promise<ContractReport[]> {
  const contracts: ContractReport[] = [];

  for (const skillName of [...referencedSkills].sort()) {
    if (upstreamManagedSkills.has(skillName)) {
      continue;
    }

    const report = await scoreSkillContract(sourceRoot, skillName);
    contracts.push(report);

    for (const contractItem of report.items) {
      if (contractItem.ok) {
        continue;
      }

      const reason = contractItem.missing.join("; ") || contractItem.name;
      const pathName = `skills.${skillName}.contract.${contractItem.id}`;

      if (contractItem.applicable) {
        findings.push(
          error(
            "skillify_contract_failed",
            `Skill ${skillName} fails Skillify-10 item ${contractItem.id} (${contractItem.name}): ${reason}.`,
            pathName
          )
        );
      } else {
        findings.push(
          warning(
            "skillify_contract_warning",
            `Skill ${skillName} is missing Skillify-10 item ${contractItem.id} (${contractItem.name}), accepted as not applicable: ${reason}.`,
            pathName
          )
        );
      }
    }
  }

  return contracts;
}

function countIntersectingSkills(referencedSkills: Set<string>, upstreamManagedSkills: Set<string>): number {
  let count = 0;
  for (const skillName of referencedSkills) {
    if (upstreamManagedSkills.has(skillName)) {
      count += 1;
    }
  }
  return count;
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
