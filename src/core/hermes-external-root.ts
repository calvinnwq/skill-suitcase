import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  HERMES_EXCLUDED_SKILL_DIRECTORIES,
  HERMES_SKILL_SUPPORT_DIRECTORIES
} from "./hermes-categories.js";

export type HermesExternalRootFinding = {
  code: string;
  message: string;
  skill?: string;
};

export async function validateHermesExternalRoot({
  home,
  installRoot,
  planned
}: {
  home: string;
  installRoot: string;
  planned: Array<{ skill: string; destination: string; sourcePath?: string }>;
}): Promise<HermesExternalRootFinding[]> {
  const findings: HermesExternalRootFinding[] = [];
  const normalizedHome = path.resolve(home);
  const normalizedRoot = path.resolve(installRoot);
  const localSkillsRoot = path.join(normalizedHome, "skills");
  const [canonicalRoot, canonicalLocalRoot] = await Promise.all([
    canonicalizePath(normalizedRoot),
    canonicalizePath(localSkillsRoot)
  ]);
  const [comparisonRoot, comparisonLocalRoot] = await Promise.all([
    filesystemComparisonPath(canonicalRoot),
    filesystemComparisonPath(canonicalLocalRoot)
  ]);
  const plannedIdentities = await Promise.all(planned.map(async (item) => ({
    ...item,
    identity: item.sourcePath === undefined
      ? item.skill
      : await readLocalSkillIdentity(item.sourcePath, item.skill) ?? item.skill
  })));
  const plannedSkills = new Set(plannedIdentities.map((item) => item.identity));

  findings.push(...await validateRegistration(normalizedHome, normalizedRoot, plannedSkills));

  if (
    isInsideOrEqual(normalizedRoot, localSkillsRoot)
    || isInsideOrEqual(localSkillsRoot, normalizedRoot)
    || isInsideOrEqual(comparisonRoot, comparisonLocalRoot)
    || isInsideOrEqual(comparisonLocalRoot, comparisonRoot)
  ) {
    findings.push({
      code: "hermes_external_root_local_overlap",
      message: `Hermes external root ${normalizedRoot} must not overlap local skills root ${localSkillsRoot}.`
    });
  }

  for (const skill of await findSkillShadows(localSkillsRoot, plannedSkills)) {
    findings.push({
      code: "hermes_local_skill_shadow",
      message: `Local Hermes skill named ${skill} under ${localSkillsRoot} would shadow categorized external skill ${skill}.`,
      skill
    });
  }

  const plannedDestinations = new Map(
    plannedIdentities.map((item) => [path.resolve(normalizedRoot, item.destination), item.identity])
  );
  for (const skill of await findSkillShadows(normalizedRoot, plannedSkills, plannedDestinations)) {
    findings.push({
      code: "hermes_managed_skill_shadow",
      message: `Another Hermes skill named ${skill} inside managed root ${normalizedRoot} conflicts with its planned destination.`,
      skill
    });
  }

  for (const item of planned) {
    const destinationPath = path.resolve(normalizedRoot, item.destination);
    if (!isInsideOrEqual(destinationPath, normalizedRoot) || destinationPath === normalizedRoot) {
      findings.push({
        code: "external_destination_escape",
        message: `Destination ${item.destination} for ${item.skill} escapes Hermes external root ${normalizedRoot}.`,
        skill: item.skill
      });
      continue;
    }

    const categoryPath = path.dirname(destinationPath);
    try {
      const categoryInfo = await lstat(categoryPath);
      if (categoryInfo.isSymbolicLink()) {
        findings.push({
          code: "external_category_symlink",
          message: `Category directory ${categoryPath} for ${item.skill} is a symlink.`,
          skill: item.skill
        });
      } else {
        const resolvedCategory = await realpath(categoryPath);
        if (!isInsideOrEqual(resolvedCategory, canonicalRoot)) {
          findings.push({
            code: "external_destination_escape",
            message: `Category directory ${categoryPath} for ${item.skill} resolves outside Hermes external root ${normalizedRoot}.`,
            skill: item.skill
          });
        }
      }
    } catch {
      // Missing category directories are created transactionally by apply.
    }
  }

  return findings;
}

async function validateRegistration(
  home: string,
  installRoot: string,
  plannedSkills: Set<string>
): Promise<HermesExternalRootFinding[]> {
  const configPath = path.join(home, "config.yaml");
  let configText: string;
  try {
    configText = await readFile(configPath, "utf8");
  } catch (error) {
    return [{
      code: "hermes_external_root_unregistered",
      message: `Cannot verify Hermes external root registration in ${configPath}: ${errorMessage(error)}`
    }];
  }

  let entries: string[];
  try {
    entries = parseExternalDirs(configText);
  } catch (error) {
    return [{
      code: "hermes_external_root_unregistered",
      message: `Cannot parse Hermes external root registration in ${configPath}: ${errorMessage(error)}`
    }];
  }

  const canonicalInstallRoot = await canonicalizePath(installRoot);
  const canonicalLocalRoot = await canonicalizePath(path.join(home, "skills"));
  const [comparisonInstallRoot, comparisonLocalRoot] = await Promise.all([
    filesystemComparisonPath(canonicalInstallRoot),
    filesystemComparisonPath(canonicalLocalRoot)
  ]);
  const seen = new Set([comparisonLocalRoot]);
  const precedingRoots: Array<{ path: string; comparisonPath: string; exists: boolean }> = [];
  let registered = false;
  for (const entry of entries) {
    const configuredPath = normalizeConfiguredPath(entry, home);
    const canonicalConfiguredPath = await canonicalizePath(configuredPath);
    const comparisonConfiguredPath = await filesystemComparisonPath(canonicalConfiguredPath);
    if (comparisonConfiguredPath === comparisonInstallRoot) {
      registered = await isDirectory(canonicalConfiguredPath);
      break;
    }
    if (seen.has(comparisonConfiguredPath)) continue;
    seen.add(comparisonConfiguredPath);
    precedingRoots.push({
      path: canonicalConfiguredPath,
      comparisonPath: comparisonConfiguredPath,
      exists: await isDirectory(canonicalConfiguredPath)
    });
  }

  if (!registered) {
    return [{
      code: "hermes_external_root_unregistered",
      message: `Hermes config ${configPath} must register the existing directory ${installRoot} in skills.external_dirs before apply.`
    }];
  }

  const findings: HermesExternalRootFinding[] = [];
  for (const precedingRoot of precedingRoots) {
    if (
      isInsideOrEqual(comparisonInstallRoot, precedingRoot.comparisonPath)
      || isInsideOrEqual(precedingRoot.comparisonPath, comparisonInstallRoot)
    ) {
      findings.push({
        code: "hermes_external_root_precedence_overlap",
        message: `Earlier Hermes external root ${precedingRoot.path} overlaps managed root ${installRoot} and would change its effective categories.`
      });
      continue;
    }
    if (!precedingRoot.exists) continue;
    for (const skill of await findSkillShadows(precedingRoot.path, plannedSkills)) {
      findings.push({
        code: "hermes_external_skill_shadow",
        message: `Hermes external skill named ${skill} under earlier configured root ${precedingRoot.path} would shadow ${path.join(installRoot, skill)}.`,
        skill
      });
    }
  }
  return findings;
}

function parseExternalDirs(text: string): string[] {
  const document = parse(text) as unknown;
  if (!document || typeof document !== "object" || Array.isArray(document)) return [];
  const skills = (document as Record<string, unknown>)["skills"];
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) return [];
  const value = (skills as Record<string, unknown>)["external_dirs"];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeConfiguredPath(value: string, hermesHome: string): string {
  const expanded = value.trim()
    .replace(/^~(?=\/|$)/, os.homedir())
    .replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? "";
      if (name === "HERMES_HOME") return hermesHome;
      if (name === "HOME") return os.homedir();
      return process.env[name] ?? match;
    });
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(hermesHome, expanded));
}

async function canonicalizePath(value: string): Promise<string> {
  const absolute = path.resolve(value);
  let existing = absolute;
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(existing), ...suffix);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return absolute;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

async function findSkillShadows(
  root: string,
  skills: Set<string>,
  plannedDestinations: ReadonlyMap<string, string> = new Map()
): Promise<string[]> {
  const found = new Set<string>();
  const pending = [root];
  const visited = new Set<string>();
  while (pending.length > 0 && found.size < skills.size) {
    const current = pending.pop()!;
    let resolved: string;
    let entries;
    try {
      resolved = await realpath(current);
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    const identity = await readLocalSkillIdentity(current, path.basename(current));
    const plannedSkill = plannedDestinations.get(path.resolve(current));
    if (identity !== null && skills.has(identity) && identity !== plannedSkill) found.add(identity);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (HERMES_EXCLUDED_SKILL_DIRECTORIES.has(entry.name)) continue;
      if (identity !== null && HERMES_SKILL_SUPPORT_DIRECTORIES.has(entry.name)) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink() && await isDirectory(await canonicalizePath(child))) {
        pending.push(child);
      }
    }
  }
  return [...found].sort((left, right) => left.localeCompare(right));
}

async function readLocalSkillIdentity(directory: string, fallback: string): Promise<string | null> {
  try {
    const skillIndex = path.join(directory, "SKILL.md");
    const normalized = (await readFile(skillIndex, "utf8")).replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---")) return fallback;
    const frontmatterAndBody = normalized.slice(3);
    const closing = /\n---\s*\n/.exec(frontmatterAndBody);
    if (closing?.index === undefined) return fallback;
    const yamlContent = frontmatterAndBody.slice(0, closing.index);
    let metadata: unknown;
    try {
      metadata = parse(yamlContent) as unknown;
    } catch {
      metadata = parseHermesFallbackFrontmatter(yamlContent);
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return fallback;
    const name = (metadata as Record<string, unknown>)["name"];
    return name === undefined || name === null || String(name).length === 0 ? fallback : String(name);
  } catch {
    return null;
  }
}

function parseHermesFallbackFrontmatter(value: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const line of value.trim().split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return metadata;
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await lstat(value)).isDirectory();
  } catch {
    return false;
  }
}

function isInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function filesystemComparisonPath(value: string): Promise<string> {
  return await isCaseInsensitiveFilesystem(value) ? value.toLocaleLowerCase("en-US") : value;
}

async function isCaseInsensitiveFilesystem(value: string): Promise<boolean> {
  if (process.platform === "win32") return true;
  let existing = path.resolve(value);
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
  }

  let probe = existing;
  while (true) {
    const basename = path.basename(probe);
    const alternateBasename = toggleFirstAsciiLetterCase(basename);
    if (alternateBasename !== basename) {
      try {
        const alternate = await realpath(path.join(path.dirname(probe), alternateBasename));
        return alternate === probe;
      } catch {
        return false;
      }
    }
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
}

function toggleFirstAsciiLetterCase(value: string): string {
  return value.replace(/[A-Za-z]/, (letter) =>
    letter === letter.toLocaleLowerCase("en-US")
      ? letter.toLocaleUpperCase("en-US")
      : letter.toLocaleLowerCase("en-US")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
