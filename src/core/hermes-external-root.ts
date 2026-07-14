import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  HERMES_EXCLUDED_SKILL_DIRECTORIES,
  HERMES_SKILL_SUPPORT_DIRECTORIES
} from "./hermes-categories.js";
import { classifySymlinkInstall } from "./install-modes.js";

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
  const skillsByIdentity = new Map<string, string[]>();
  for (const item of plannedIdentities) {
    const skills = skillsByIdentity.get(item.identity) ?? [];
    skills.push(item.skill);
    skillsByIdentity.set(item.identity, skills);
  }
  const identityConflicts = [...skillsByIdentity]
    .filter(([, skills]) => skills.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([identity, skills]) => ({
      code: "hermes_planned_skill_identity_conflict",
      message: `Planned Hermes skills ${skills.join(", ")} share identity ${identity} and would create duplicate skills.`,
      skill: identity
    }));
  if (identityConflicts.length > 0) return identityConflicts;
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

  const localShadows = await findSkillShadows(localSkillsRoot, plannedSkills);
  findings.push(...shadowTraversalFindings(localShadows.directorySymlinks));
  for (const skill of localShadows.skills) {
    findings.push({
      code: "hermes_local_skill_shadow",
      message: `Local Hermes skill named ${skill} under ${localSkillsRoot} would shadow categorized external skill ${skill}.`,
      skill
    });
  }

  const managedRootCaseInsensitive = await isCaseInsensitiveFilesystem(normalizedRoot);
  const managedDestinationKey = (value: string) => normalizeFilesystemComparisonPath(
    path.resolve(value),
    managedRootCaseInsensitive
  );
  const plannedDestinations = new Map(
    plannedIdentities.map((item) => [managedDestinationKey(path.resolve(normalizedRoot, item.destination)), {
      identity: item.identity,
      sourcePath: item.sourcePath ?? null
    }])
  );
  const managedShadows = await findSkillShadows(
    normalizedRoot,
    plannedSkills,
    plannedDestinations,
    managedDestinationKey
  );
  findings.push(...shadowTraversalFindings(managedShadows.directorySymlinks));
  for (const skill of managedShadows.skills) {
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
    if (configuredPath === null) continue;
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
    const precedingShadows = await findSkillShadows(precedingRoot.path, plannedSkills);
    findings.push(...shadowTraversalFindings(precedingShadows.directorySymlinks));
    for (const skill of precedingShadows.skills) {
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

function normalizeConfiguredPath(value: string, hermesHome: string): string | null {
  let unresolved = false;
  const expanded = expandHermesHomePrefix(value.trim(), os.homedir())
    .replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? "";
      const environmentValue = process.env[name];
      if (environmentValue === undefined) unresolved = true;
      return environmentValue ?? match;
    });
  if (unresolved) return null;
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(hermesHome, expanded));
}

export function expandHermesHomePrefix(value: string, homeDirectory: string): string {
  return value.replace(/^~(?=[/\\]|$)/, homeDirectory);
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
  plannedDestinations: ReadonlyMap<string, { identity: string; sourcePath: string | null }> = new Map(),
  plannedDestinationKey: (value: string) => string = path.resolve
): Promise<{ skills: string[]; directorySymlinks: string[] }> {
  const found = new Set<string>();
  const directorySymlinks = new Set<string>();
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
    const plannedDestination = plannedDestinations.get(plannedDestinationKey(current));
    if (identity !== null && skills.has(identity) && identity !== plannedDestination?.identity) found.add(identity);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (HERMES_EXCLUDED_SKILL_DIRECTORIES.has(entry.name)) continue;
      if (identity !== null && HERMES_SKILL_SUPPORT_DIRECTORIES.has(entry.name)) continue;
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const plannedChild = plannedDestinations.get(plannedDestinationKey(child));
        if (plannedChild !== undefined && await isExpectedPlannedSkillSymlink(child, plannedChild)) {
          pending.push(child);
          continue;
        }
        if (await isDirectory(await canonicalizePath(child))) directorySymlinks.add(child);
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(child);
      }
    }
  }
  return {
    skills: [...found].sort((left, right) => left.localeCompare(right)),
    directorySymlinks: [...directorySymlinks].sort((left, right) => left.localeCompare(right))
  };
}

async function isExpectedPlannedSkillSymlink(
  targetPath: string,
  planned: { identity: string; sourcePath: string | null }
): Promise<boolean> {
  if (planned.sourcePath === null) return false;
  const classification = await classifySymlinkInstall({
    targetPath,
    expectedSourcePath: planned.sourcePath
  });
  if (classification.state !== "correct") return false;
  return await readLocalSkillIdentity(targetPath, path.basename(targetPath)) === planned.identity;
}

function shadowTraversalFindings(directorySymlinks: string[]): HermesExternalRootFinding[] {
  return directorySymlinks.map((directory) => ({
    code: "hermes_shadow_directory_symlink",
    message: `Hermes shadow validation refuses directory symlink ${directory}.`
  }));
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
  return normalizeFilesystemComparisonPath(value, await isCaseInsensitiveFilesystem(value));
}

function normalizeFilesystemComparisonPath(value: string, caseInsensitive: boolean): string {
  return caseInsensitive ? value.toLocaleLowerCase("en-US") : value;
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
