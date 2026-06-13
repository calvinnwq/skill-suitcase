import { access, lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { readTextFile } from "../../adapters/filesystem.js";
import { DEFAULT_SKILLS_DIRECTORY, DEFAULT_SUITCASE_MANIFEST_FILE } from "../../config/defaults.js";
import { type Catalog } from "../catalog/index.js";
import { parseSuitcaseManifest } from "../catalog/suitcase-manifest.js";
import { resolvePlatformAdapter } from "../platform-adapters.js";

type ImportFindingLevel = "error" | "warning";

export type ImportFinding = {
  level: ImportFindingLevel;
  code: string;
  message: string;
  path: string | null;
};

type ImportCompatibilitySummary = {
  declared: boolean;
  agents: string[];
  blockedAgents: string[];
  variant: string | null;
  evidence: string[];
};

type ImportVariantSummary = {
  name: string;
  source: string | null;
  agents: string[];
  exists: boolean;
  skillFileExists: boolean;
};

type ImportSkillSummary = {
  name: string;
  path: string | null;
  skillFile: string | null;
  referencedBy: string[];
  compatibility: ImportCompatibilitySummary;
  variants: ImportVariantSummary[];
};

type ImportSummary = {
  discoveredSkills: number;
  referencedSkills: number;
  suitcases: number;
  assignments: number;
  assignmentPaths: number;
  compatibilityEntries: number;
  variantEntries: number;
  warnings: number;
  errors: number;
  findings: number;
};

type ImportArgs = {
  source: string;
};

export type ImportResult = {
  ok: boolean;
  source: string;
  manifestPath: string;
  summary: ImportSummary;
  skills: ImportSkillSummary[];
  findings: ImportFinding[];
};

type ManifestState = {
  exists: boolean;
  manifest: Catalog;
};

export async function inspectImportSource({ source }: ImportArgs): Promise<ImportResult> {
  if (!source) {
    throw new Error("source is required");
  }

  const sourceRoot = path.resolve(source);
  const manifestPath = path.join(sourceRoot, DEFAULT_SUITCASE_MANIFEST_FILE);
  const skillsRoot = path.join(sourceRoot, DEFAULT_SKILLS_DIRECTORY);
  const findings: ImportFinding[] = [];

  const manifestState = await loadManifestForImport(sourceRoot, manifestPath, findings);
  const manifest = manifestState.manifest;
  const discoveredSkills = await discoverSkillDirectories(sourceRoot, skillsRoot, findings);
  const referencedBySkill = referencedSkillsBySuitcase(manifest);
  const referencedSkills = [...referencedBySkill.keys()].sort();

  if (manifestState.exists) {
    validateManifestShape(manifest, referencedBySkill, findings);
  }

  const allSkillNames = sortedUnique([...discoveredSkills, ...referencedSkills]);
  const skills: ImportSkillSummary[] = [];
  for (const skillName of allSkillNames) {
    skills.push(await inspectSkill({
      sourceRoot,
      skillsRoot,
      skillName,
      referencedBy: referencedBySkill.get(skillName) ?? [],
      manifest,
      shouldValidateMetadata: manifestState.exists,
      findings
    }));
  }

  if (manifestState.exists) {
    validateUnusedMetadata(manifest, allSkillNames, findings);
  }

  const warnings = findings.filter((finding) => finding.level === "warning").length;
  const errors = findings.filter((finding) => finding.level === "error").length;

  return {
    ok: errors === 0,
    source: sourceRoot,
    manifestPath,
    summary: {
      discoveredSkills: discoveredSkills.length,
      referencedSkills: referencedSkills.length,
      suitcases: Object.keys(manifest.suitcases).length,
      assignments: Object.keys(manifest.assignments).length,
      assignmentPaths: Object.keys(manifest.assignmentPaths).length,
      compatibilityEntries: Object.keys(manifest.compatibility).length,
      variantEntries: countVariantEntries(manifest),
      warnings,
      errors,
      findings: findings.length
    },
    skills,
    findings
  };
}

async function loadManifestForImport(
  sourceRoot: string,
  manifestPath: string,
  findings: ImportFinding[]
): Promise<ManifestState> {
  const manifestRelativePath = path.relative(sourceRoot, manifestPath);
  if (!(await isFile(manifestPath))) {
    findings.push(
      error(
        "missing_manifest",
        `Missing ${DEFAULT_SUITCASE_MANIFEST_FILE}.`,
        manifestRelativePath
      )
    );
    return { exists: false, manifest: emptyManifest() };
  }

  try {
    const manifestText = await readTextFile(manifestPath);
    return {
      exists: true,
      manifest: parseSuitcaseManifest(manifestText)
    };
  } catch {
    findings.push(
      error(
        "unreadable_manifest",
        `Could not read ${DEFAULT_SUITCASE_MANIFEST_FILE}.`,
        manifestRelativePath
      )
    );
    return { exists: false, manifest: emptyManifest() };
  }
}

async function discoverSkillDirectories(
  sourceRoot: string,
  skillsRoot: string,
  findings: ImportFinding[]
): Promise<string[]> {
  if (!(await isDirectory(skillsRoot))) {
    findings.push(
      error(
        "missing_skills_directory",
        `Missing ${DEFAULT_SKILLS_DIRECTORY} directory.`,
        path.relative(sourceRoot, skillsRoot)
      )
    );
    return [];
  }

  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    findings.push(
      error(
        "unreadable_skills_directory",
        `Could not read ${DEFAULT_SKILLS_DIRECTORY} directory.`,
        path.relative(sourceRoot, skillsRoot)
      )
    );
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function validateManifestShape(
  manifest: Catalog,
  referencedBySkill: Map<string, string[]>,
  findings: ImportFinding[]
): void {
  if (Object.keys(manifest.suitcases).length === 0) {
    findings.push(error("missing_suitcases", "Manifest must define at least one suitcase.", "suitcases"));
  }

  if (Object.keys(manifest.assignments).length === 0) {
    findings.push(error("missing_assignments", "Manifest must define at least one assignment.", "assignments"));
  }

  if (Object.keys(manifest.assignmentPaths).length === 0) {
    findings.push(
      warning(
        "missing_assignment_paths",
        "Manifest does not define assignmentPaths for onboarding target discovery.",
        "assignmentPaths"
      )
    );
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
        warning(
          "empty_suitcase",
          `Suitcase ${suitcaseName} does not reference any skills.`,
          `suitcases.${suitcaseName}.skills`
        )
      );
    }
  }

  for (const [pathName, assignmentPath] of Object.entries(manifest.assignmentPaths)) {
    const assignment = normalizedString(assignmentPath.assignment);
    const kind = normalizedString(assignmentPath.kind);

    if (assignment === null) {
      findings.push(
        error(
          "invalid_assignment_path",
          `Assignment path ${pathName} is missing assignment.`,
          `assignmentPaths.${pathName}.assignment`
        )
      );
    } else if (!manifest.assignments[assignment]) {
      findings.push(
        error(
          "unknown_assignment_path_target",
          `Assignment path ${pathName} points at unknown assignment ${assignment}.`,
          `assignmentPaths.${pathName}.assignment`
        )
      );
    }

    if (kind === null) {
      findings.push(
        error(
          "invalid_assignment_path",
          `Assignment path ${pathName} is missing kind.`,
          `assignmentPaths.${pathName}.kind`
        )
      );
      continue;
    }

    const adapter = resolvePlatformAdapter(kind);
    if (adapter === null) {
      findings.push(
        error(
          "invalid_assignment_path",
          `Assignment path ${pathName} has unsupported kind ${kind}.`,
          `assignmentPaths.${pathName}.kind`
        )
      );
      continue;
    }

    for (const field of adapter.requiredFields) {
      if (normalizedString(assignmentPath[field]) === null) {
        findings.push(
          error(
            "invalid_assignment_path",
            `Assignment path ${pathName} is missing required field ${field}.`,
            `assignmentPaths.${pathName}.${field}`
          )
        );
      }
    }
  }

  for (const skillName of Object.keys(manifest.compatibility).sort()) {
    if (!referencedBySkill.has(skillName)) {
      findings.push(
        warning(
          "unused_compatibility",
          `Compatibility entry ${skillName} is not referenced by any suitcase.`,
          `compatibility.${skillName}`
        )
      );
    }
  }
}

async function inspectSkill(args: {
  sourceRoot: string;
  skillsRoot: string;
  skillName: string;
  referencedBy: string[];
  manifest: Catalog;
  shouldValidateMetadata: boolean;
  findings: ImportFinding[];
}): Promise<ImportSkillSummary> {
  if (!isPlainPathSegment(args.skillName)) {
    args.findings.push(
      error(
        "invalid_skill_name",
        `Skill ${args.skillName} must be a plain directory name under skills/.`,
        `skills.${args.skillName}`
      )
    );
    if (args.shouldValidateMetadata) {
      validateCompatibilityMetadata(args.manifest, args.skillName, args.findings);
    }
    return {
      name: args.skillName,
      path: null,
      skillFile: null,
      referencedBy: [...args.referencedBy].sort(),
      compatibility: summarizeCompatibility(args.manifest, args.skillName),
      variants: await summarizeVariants(args.sourceRoot, args.manifest, args.skillName, args.findings)
    };
  }

  const skillPath = path.join(args.skillsRoot, args.skillName);
  const skillFile = path.join(skillPath, "SKILL.md");
  const skillDirectoryExists = await isDirectory(skillPath);
  const skillFileExists = await isFile(skillFile);

  if (!skillDirectoryExists) {
    args.findings.push(
      error(
        "missing_skill_directory",
        `Skill ${args.skillName} is referenced but its directory does not exist.`,
        `skills.${args.skillName}`
      )
    );
  }

  if (skillDirectoryExists && !skillFileExists) {
    args.findings.push(
      error(
        "missing_skill_file",
        `Skill ${args.skillName} is missing SKILL.md.`,
        `skills.${args.skillName}.SKILL.md`
      )
    );
  }

  if (args.shouldValidateMetadata) {
    validateCompatibilityMetadata(args.manifest, args.skillName, args.findings);
  }

  return {
    name: args.skillName,
    path: skillPath,
    skillFile,
    referencedBy: [...args.referencedBy].sort(),
    compatibility: summarizeCompatibility(args.manifest, args.skillName),
    variants: await summarizeVariants(args.sourceRoot, args.manifest, args.skillName, args.findings)
  };
}

function validateCompatibilityMetadata(manifest: Catalog, skillName: string, findings: ImportFinding[]): void {
  const compatibility = manifest.compatibility[skillName];
  if (!compatibility) {
    findings.push(
      warning(
        "missing_compatibility",
        `Skill ${skillName} does not declare compatibility metadata.`,
        `compatibility.${skillName}`
      )
    );
    return;
  }

  const agents = compatibility.agents ?? [];
  const blockedAgents = Object.keys(compatibility.blockedAgents ?? {});
  if (agents.length === 0 && blockedAgents.length === 0) {
    findings.push(
      warning(
        "missing_compatibility_agents",
        `Skill ${skillName} compatibility metadata does not declare agents or blockedAgents.`,
        `compatibility.${skillName}.agents`
      )
    );
  }

  if (!compatibility.variant) {
    findings.push(
      warning(
        "missing_compatibility_variant",
        `Skill ${skillName} compatibility metadata does not declare a variant label.`,
        `compatibility.${skillName}.variant`
      )
    );
  }

  if (
    Object.keys(compatibility.blockedAgents ?? {}).length > 0 &&
    Object.keys(manifest.variants[skillName] ?? {}).length === 0
  ) {
    findings.push(
      warning(
        "missing_variant_metadata",
        `Skill ${skillName} blocks platform agents but does not declare variant sources.`,
        `variants.${skillName}`
      )
    );
  }
}

function summarizeCompatibility(manifest: Catalog, skillName: string): ImportCompatibilitySummary {
  const compatibility = manifest.compatibility[skillName];
  return {
    declared: compatibility !== undefined,
    agents: [...(compatibility?.agents ?? [])].sort(),
    blockedAgents: Object.keys(compatibility?.blockedAgents ?? {}).sort(),
    variant: compatibility?.variant ?? null,
    evidence: [...(compatibility?.evidence ?? [])].sort()
  };
}

async function summarizeVariants(
  sourceRoot: string,
  manifest: Catalog,
  skillName: string,
  findings: ImportFinding[]
): Promise<ImportVariantSummary[]> {
  const variants = manifest.variants[skillName] ?? {};
  const summaries: ImportVariantSummary[] = [];

  for (const [variantName, variant] of Object.entries(variants).sort(([left], [right]) => left.localeCompare(right))) {
    const source = normalizedString(variant.source);
    const sourcePath = source === null ? null : containedPath(sourceRoot, source);
    const sourcePathType = sourcePath === null ? null : await pathType(sourcePath);
    const sourceRealPathContained = sourcePathType === "directory" && sourcePath !== null
      ? await realPathContained(sourceRoot, sourcePath)
      : false;
    const exists = sourcePathType === "directory" && sourceRealPathContained;
    const skillFileExists = exists && sourcePath !== null
      ? await isFile(path.join(sourcePath, "SKILL.md"))
      : false;
    const agents = [...(variant.agents ?? [])].sort();

    if (agents.length === 0) {
      findings.push(
        warning(
          "missing_variant_agents",
          `Variant ${variantName} for ${skillName} does not declare agents.`,
          `variants.${skillName}.${variantName}.agents`
        )
      );
    }

    if (source === null) {
      findings.push(
        error(
          "missing_variant_source",
          `Variant ${variantName} for ${skillName} does not declare a source path.`,
          `variants.${skillName}.${variantName}.source`
        )
      );
    } else if (
      sourcePath === null ||
      sourcePathType === "symlink" ||
      (sourcePathType === "directory" && !sourceRealPathContained)
    ) {
      findings.push(
        error(
          "invalid_variant_source",
          `Variant ${variantName} for ${skillName} must stay inside the source repo.`,
          `variants.${skillName}.${variantName}.source`
        )
      );
    } else {
      if (!exists) {
        findings.push(
          error(
            "missing_variant_directory",
            `Variant ${variantName} for ${skillName} points at a missing directory.`,
            `variants.${skillName}.${variantName}.source`
          )
        );
      }
      if (!skillFileExists) {
        findings.push(
          error(
            "missing_variant_skill_file",
            `Variant ${variantName} for ${skillName} is missing SKILL.md.`,
            `variants.${skillName}.${variantName}.SKILL.md`
          )
        );
      }
    }

    summaries.push({
      name: variantName,
      source,
      agents,
      exists,
      skillFileExists
    });
  }

  return summaries;
}

function validateUnusedMetadata(manifest: Catalog, knownSkillNames: string[], findings: ImportFinding[]): void {
  const knownSkills = new Set(knownSkillNames);
  for (const skillName of Object.keys(manifest.variants).sort()) {
    if (!knownSkills.has(skillName)) {
      findings.push(
        warning(
          "unused_variants",
          `Variant entry ${skillName} is not referenced by any discovered or manifest skill.`,
          `variants.${skillName}`
        )
      );
    }
  }
}

function referencedSkillsBySuitcase(manifest: Catalog): Map<string, string[]> {
  const referenced = new Map<string, string[]>();

  for (const [suitcaseName, suitcase] of Object.entries(manifest.suitcases)) {
    for (const skillName of suitcase.skills) {
      const suitcases = referenced.get(skillName) ?? [];
      suitcases.push(suitcaseName);
      referenced.set(skillName, suitcases);
    }
  }

  return referenced;
}

function countVariantEntries(manifest: Catalog): number {
  return Object.values(manifest.variants).reduce(
    (count, variants) => count + Object.keys(variants).length,
    0
  );
}

async function isDirectory(targetPath: string): Promise<boolean> {
  return await pathType(targetPath) === "directory";
}

async function isFile(targetPath: string): Promise<boolean> {
  return await pathType(targetPath) === "file";
}

async function pathType(targetPath: string): Promise<"directory" | "file" | "symlink" | "other" | "missing"> {
  try {
    await access(targetPath);
    const info = await lstat(targetPath);
    if (info.isSymbolicLink()) {
      return "symlink";
    }
    if (info.isDirectory()) {
      return "directory";
    }
    if (info.isFile()) {
      return "file";
    }
    return "other";
  } catch {
    return "missing";
  }
}

function emptyManifest(): Catalog {
  return {
    suitcases: {},
    assignments: {},
    assignmentPaths: {},
    compatibility: {},
    variants: {}
  };
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

function containedPath(root: string, relativePath: string): string | null {
  if (path.isAbsolute(relativePath)) {
    return null;
  }

  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, relativePath);
  const relativeToRoot = path.relative(resolvedRoot, resolvedTarget);
  if (
    relativeToRoot === "" ||
    relativeToRoot.startsWith("..") ||
    path.isAbsolute(relativeToRoot)
  ) {
    return null;
  }

  return resolvedTarget;
}

async function realPathContained(root: string, targetPath: string): Promise<boolean> {
  try {
    const resolvedRoot = await realpath(root);
    const resolvedTarget = await realpath(targetPath);
    const relativeToRoot = path.relative(resolvedRoot, resolvedTarget);
    return relativeToRoot !== "" &&
      !relativeToRoot.startsWith("..") &&
      !path.isAbsolute(relativeToRoot);
  } catch {
    return false;
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function error(code: string, message: string, pathName: string | null = null): ImportFinding {
  return finding("error", code, message, pathName);
}

function warning(code: string, message: string, pathName: string | null = null): ImportFinding {
  return finding("warning", code, message, pathName);
}

function finding(
  level: ImportFindingLevel,
  code: string,
  message: string,
  pathName: string | null
): ImportFinding {
  return {
    level,
    code,
    message,
    path: pathName
  };
}
