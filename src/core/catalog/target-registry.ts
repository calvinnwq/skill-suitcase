import os from "node:os";
import path from "node:path";
import type { Catalog, TargetOverrides } from "./index.js";
import { resolvePlatformAdapter } from "../platform-adapters.js";

export type TargetRegistrySource = "manifest" | "provider";

export type TargetRegistryEntry = {
  id: string;
  name: string;
  assignment: string;
  kind: string;
  path: string | null;
  home: string | null;
  codexHome: string | null;
  skillsPath: string | null;
  provider: string | null;
  readOnly: boolean;
  source: TargetRegistrySource;
  assignmentPath: Record<string, string>;
};

type SkillsShTargetSnapshotEntry = {
  id: string;
  name: string;
  kind: string;
  assignment: string;
  path: string;
};

const SKILLS_SH_PROVIDER = "skills.sh";

const SKILLS_SH_TARGETS: SkillsShTargetSnapshotEntry[] = [
  {
    id: "opencode",
    name: "OpenCode",
    kind: "opencode-skills-root",
    assignment: "opencode",
    path: "~/.config/opencode/skills"
  },
  {
    id: "pi",
    name: "Pi",
    kind: "pi-skills-root",
    assignment: "pi",
    path: "~/.pi/agent/skills"
  }
];

export function resolveTargetRegistryEntry(
  targetId: string,
  targetOverrides?: TargetOverrides | undefined
): TargetRegistryEntry | null {
  const providerEntry = SKILLS_SH_TARGETS.find((entry) => entry.id === targetId);
  if (providerEntry === undefined) {
    return null;
  }
  return providerEntryToTarget(providerEntry, targetOverrides);
}

export function resolveTargetRegistryEntries(
  manifest: Pick<Catalog, "assignments" | "assignmentPaths">,
  targetOverrides?: TargetOverrides | undefined
): TargetRegistryEntry[] {
  const entries = resolveManifestTargetRegistryEntries(manifest, targetOverrides);
  const seen = new Set(entries.map((entry) => entry.id));
  const seenAssignments = new Set(entries.map((entry) => entry.assignment));

  for (const providerEntry of SKILLS_SH_TARGETS) {
    if (seen.has(providerEntry.id) || seenAssignments.has(providerEntry.assignment)) {
      continue;
    }
    entries.push(providerEntryToTarget(providerEntry, targetOverrides));
  }

  return entries;
}

export function resolveTargetRegistryEntryFromManifest(
  manifest: Pick<Catalog, "assignments" | "assignmentPaths">,
  targetId: string,
  targetOverrides?: TargetOverrides | undefined
): TargetRegistryEntry | null {
  const manifestEntries = resolveManifestTargetRegistryEntries(manifest, targetOverrides);
  const directManifestEntry = manifestEntries.find((entry) => entry.id === targetId);
  if (directManifestEntry !== undefined) {
    return directManifestEntry;
  }

  const assignmentMatches = manifestEntries.filter((entry) => entry.assignment === targetId);
  if (assignmentMatches.length === 1) {
    return assignmentMatches[0] ?? null;
  }
  if (assignmentMatches.length > 1) {
    return null;
  }

  return resolveTargetRegistryEntry(targetId, targetOverrides);
}

export function findTargetRegistryEntriesByAssignment(
  manifest: Pick<Catalog, "assignments" | "assignmentPaths">,
  assignment: string,
  targetOverrides?: TargetOverrides | undefined
): TargetRegistryEntry[] {
  const manifestMatches = resolveManifestTargetRegistryEntries(manifest, targetOverrides)
    .filter((entry) => entry.assignment === assignment);
  if (manifestMatches.length > 0) {
    return manifestMatches;
  }

  return SKILLS_SH_TARGETS
    .filter((entry) => entry.assignment === assignment)
    .map((entry) => providerEntryToTarget(entry, targetOverrides));
}

function resolveManifestTargetRegistryEntries(
  manifest: Pick<Catalog, "assignments" | "assignmentPaths">,
  targetOverrides?: TargetOverrides | undefined
): TargetRegistryEntry[] {
  const entries: TargetRegistryEntry[] = [];
  const assignmentPaths = isRecord(manifest.assignmentPaths) ? manifest.assignmentPaths : {};

  for (const [targetId, assignmentPath] of Object.entries(assignmentPaths)) {
    if (!isRecord(assignmentPath)) {
      entries.push(malformedManifestTarget(targetId, assignmentPath));
      continue;
    }

    const provider = resolveTargetRegistryEntry(targetId, targetOverrides);
    entries.push(manifestEntryToTarget(targetId, assignmentPath, provider, targetOverrides));
  }

  return entries;
}

function providerEntryToTarget(
  entry: SkillsShTargetSnapshotEntry,
  targetOverrides?: TargetOverrides | undefined
): TargetRegistryEntry {
  const resolvedPath = expandHome(entry.path, targetOverrides?.home);
  return {
    id: entry.id,
    name: entry.name,
    assignment: entry.assignment,
    kind: entry.kind,
    path: resolvedPath,
    home: null,
    codexHome: null,
    skillsPath: null,
    provider: SKILLS_SH_PROVIDER,
    readOnly: true,
    source: "provider",
    assignmentPath: {
      kind: entry.kind,
      assignment: entry.assignment,
      path: resolvedPath
    }
  };
}

function manifestEntryToTarget(
  targetId: string,
  assignmentPath: Record<string, unknown>,
  provider: TargetRegistryEntry | null,
  targetOverrides?: TargetOverrides | undefined
): TargetRegistryEntry {
  const normalized = normalizeAssignmentPath(assignmentPath);
  const fallbackAssignment = provider?.assignment ?? targetId;
  const assignment = normalized.assignment ?? fallbackAssignment;
  const kind = normalized.kind ?? provider?.kind ?? "";
  const adapter = resolvePlatformAdapter(kind);
  const nextPath = expandOptionalHome(normalized.path, targetOverrides?.home) ?? provider?.path ?? null;
  const nextHome = expandOptionalHome(normalized.home, targetOverrides?.home) ?? provider?.home ?? null;
  const nextCodexHome = expandOptionalHome(normalized.codexHome, targetOverrides?.home) ?? provider?.codexHome ?? null;
  const nextSkillsPath = expandOptionalHome(normalized.skillsPath, targetOverrides?.home) ?? provider?.skillsPath ?? null;
  const adapterProvider = adapter?.metadata.skillsShCompatibility ? SKILLS_SH_PROVIDER : null;

  return {
    id: targetId,
    name: provider?.name ?? targetId,
    assignment,
    kind,
    path: nextPath,
    home: nextHome,
    codexHome: nextCodexHome,
    skillsPath: nextSkillsPath,
    provider: provider?.provider ?? adapterProvider,
    readOnly: Boolean(provider?.readOnly || adapter?.metadata.readOnly),
    source: "manifest",
    assignmentPath: stringifyAssignmentPath({
      ...provider?.assignmentPath,
      ...normalized,
      assignment,
      kind,
      path: nextPath,
      home: nextHome,
      codexHome: nextCodexHome,
      skillsPath: nextSkillsPath
    })
  };
}

function malformedManifestTarget(targetId: string, assignmentPath: unknown): TargetRegistryEntry {
  return {
    id: targetId,
    name: targetId,
    assignment: targetId,
    kind: "",
    path: null,
    home: null,
    codexHome: null,
    skillsPath: null,
    provider: null,
    readOnly: false,
    source: "manifest",
    assignmentPath: isRecord(assignmentPath) ? stringifyAssignmentPath(assignmentPath) : {}
  };
}

function normalizeAssignmentPath(assignmentPath: Record<string, unknown>): Partial<Record<"assignment" | "kind" | "path" | "home" | "codexHome" | "skillsPath", string>> {
  const result: Partial<Record<"assignment" | "kind" | "path" | "home" | "codexHome" | "skillsPath", string>> = {};
  for (const field of ["assignment", "kind", "path", "home", "codexHome", "skillsPath"] as const) {
    const value = normalizeValue(assignmentPath[field]);
    if (value !== null) {
      result[field] = value;
    }
  }
  return result;
}

function stringifyAssignmentPath(assignmentPath: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(assignmentPath)) {
    const normalized = normalizeValue(value);
    if (normalized !== null) {
      result[key] = normalized;
    }
  }
  return result;
}

function expandHome(value: string, homeOverride: string | undefined): string {
  if (value === "~") {
    return homeOverride !== undefined ? path.resolve(homeOverride) : os.homedir();
  }
  if (value.startsWith("~/")) {
    const home = homeOverride !== undefined ? path.resolve(homeOverride) : os.homedir();
    return path.join(home, value.slice(2));
  }
  return path.resolve(value);
}

function expandOptionalHome(value: string | undefined, homeOverride: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return expandHome(value, homeOverride);
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
