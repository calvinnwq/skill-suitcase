import os from "node:os";
import path from "node:path";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { parse } from "yaml";
import { classifySymlinkInstall, type SymlinkInstallState } from "./install-modes.js";

export const EXTERNAL_PROJECTION_MODE = "symlink";

export type ExternalProjection = {
  id: string;
  target: string;
  skill: string;
  destination: string;
  source: string;
  mode: string;
  owner: string;
};

export type ExternalProjectionState =
  | "external-current"
  | "external-missing"
  | "external-broken"
  | "external-drifted"
  | "external-invalid";

export type ExternalProjectionInspection = ExternalProjection & {
  state: ExternalProjectionState;
  targetPath: string | null;
  sourcePath: string | null;
  symlinkState: SymlinkInstallState | null;
  reason: string;
};

export type ExternalProjectionDeclaration = Partial<Record<
  "target" | "skill" | "destination" | "source" | "mode" | "owner",
  unknown
>>;

export type ExternalProjectionMetadataManifest = {
  externalProjections: Record<string, ExternalProjectionDeclaration>;
  assignmentPaths: Record<string, { assignment?: unknown }>;
  assignments: Record<string, { suitcases?: unknown }>;
  suitcases: Record<string, { skills?: unknown }>;
};

export type ExternalProjectionMetadataFinding = {
  code: string;
  message: string;
  path: string;
};

export function validateExternalProjectionMetadata(
  manifest: ExternalProjectionMetadataManifest
): ExternalProjectionMetadataFinding[] {
  const findings: ExternalProjectionMetadataFinding[] = [];
  const destinations = new Map<string, string>();
  const identities = new Map<string, string>();

  for (const [projectionId, projection] of Object.entries(manifest.externalProjections).sort(([left], [right]) => left.localeCompare(right))) {
    const target = normalize(projection.target);
    const skill = normalize(projection.skill);
    const destination = normalize(projection.destination);
    const source = normalize(projection.source);
    const mode = normalize(projection.mode);
    const owner = normalize(projection.owner);
    const basePath = `externalProjections.${projectionId}`;

    if (!isPlainPathSegment(projectionId)) {
      findings.push({
        code: "invalid_external_projection",
        message: `External projection ${projectionId} must use a plain manifest key.`,
        path: basePath
      });
    }

    for (const [field, value] of Object.entries({ target, skill, destination, source, mode, owner })) {
      if (value === null) {
        findings.push({
          code: "invalid_external_projection",
          message: `External projection ${projectionId} is missing required field ${field}.`,
          path: `${basePath}.${field}`
        });
      }
    }

    if (target !== null && !isPlainPathSegment(target)) {
      findings.push({
        code: "invalid_external_projection",
        message: `External projection ${projectionId} target ${target} must be one plain assignment-path identity segment.`,
        path: `${basePath}.target`
      });
    }
    if (target !== null && manifest.assignmentPaths[target] === undefined) {
      findings.push({
        code: "unknown_external_projection_target",
        message: `External projection ${projectionId} targets unknown assignment path ${target}.`,
        path: `${basePath}.target`
      });
    }
    if (skill !== null && !isPlainPathSegment(skill)) {
      findings.push({
        code: "invalid_external_projection",
        message: `External projection ${projectionId} skill ${skill} must be one plain identity segment.`,
        path: `${basePath}.skill`
      });
    }
    if (mode !== null && mode !== EXTERNAL_PROJECTION_MODE) {
      findings.push({
        code: "invalid_external_projection_mode",
        message: `External projection ${projectionId} uses unsupported mode ${mode}; only ${EXTERNAL_PROJECTION_MODE} is supported.`,
        path: `${basePath}.mode`
      });
    }
    if (destination !== null && !isSafeExternalProjectionDestination(destination)) {
      findings.push({
        code: "unsafe_external_projection_destination",
        message: `External projection ${projectionId} destination must be a safe relative POSIX path inside its target root.`,
        path: `${basePath}.destination`
      });
    }
    if (source !== null && !isSafeExternalProjectionSource(source)) {
      findings.push({
        code: "unsafe_external_projection_source",
        message: `External projection ${projectionId} source must be an absolute path or start with ~/.`,
        path: `${basePath}.source`
      });
    }

    if (target === null || skill === null || destination === null) continue;
    const assignmentName = normalize(manifest.assignmentPaths[target]?.assignment);
    const assignedSkills = assignmentName === null
      ? new Set<string>()
      : assignedSkillsForAssignment(manifest, assignmentName);
    if (assignedSkills.has(skill)) {
      findings.push({
        code: "external_projection_identity_conflict",
        message: `External projection ${projectionId} duplicates catalog-assigned skill identity ${skill} for target ${target}.`,
        path: `${basePath}.skill`
      });
    }

    const identityKey = `${target}\0${skill}`;
    const previousIdentity = identities.get(identityKey);
    if (previousIdentity !== undefined) {
      findings.push({
        code: "external_projection_identity_conflict",
        message: `External projections ${previousIdentity} and ${projectionId} share skill identity ${skill} for target ${target}.`,
        path: `${basePath}.skill`
      });
    } else {
      identities.set(identityKey, projectionId);
    }

    const destinationKey = `${target}\0${destination}`;
    const previousDestination = destinations.get(destinationKey);
    if (previousDestination !== undefined) {
      findings.push({
        code: "external_projection_destination_conflict",
        message: `External projections ${previousDestination} and ${projectionId} share destination ${destination} for target ${target}.`,
        path: `${basePath}.destination`
      });
    } else {
      destinations.set(destinationKey, projectionId);
    }
  }

  return findings;
}

export function isExternalProjectionErrorCode(code: string): boolean {
  return code.startsWith("external-")
    || code.includes("external_projection")
    || code === "external_projection_owned";
}

export async function findUndeclaredDirectorySymlinks({
  installRoot,
  declaredTargetPaths = []
}: {
  installRoot: string;
  declaredTargetPaths?: string[];
}): Promise<string[]> {
  const root = path.resolve(installRoot);
  const declared = new Set(declaredTargetPaths.map((value) => path.resolve(value)));
  const findings: string[] = [];

  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      throw inspectionFailure("read directory", current, error);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (declared.has(path.resolve(entryPath)) && entry.isSymbolicLink()) continue;
      let info;
      try {
        info = await lstat(entryPath);
      } catch (error) {
        throw inspectionFailure("inspect path", entryPath, error);
      }
      if (info.isSymbolicLink()) {
        let targetInfo;
        try {
          targetInfo = await stat(entryPath);
        } catch (error) {
          throw inspectionFailure("inspect symlink target", entryPath, error);
        }
        if (targetInfo.isDirectory() && !declared.has(path.resolve(entryPath))) findings.push(entryPath);
        continue;
      }
      if (info.isDirectory()) await visit(entryPath);
    }
  }

  await visit(root);
  return findings.sort();
}

function inspectionFailure(operation: string, targetPath: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : "unknown error";
  return new Error(`Unable to ${operation} ${targetPath}: ${detail}`);
}

export function externalProjectionsForTarget(
  declarations: Record<string, ExternalProjectionDeclaration>,
  target: string
): ExternalProjection[] {
  return Object.entries(declarations)
    .filter(([, declaration]) => normalize(declaration.target) === target)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, declaration]) => ({
      id,
      target,
      skill: normalize(declaration.skill) ?? "",
      destination: normalize(declaration.destination) ?? "",
      source: normalize(declaration.source) ?? "",
      mode: normalize(declaration.mode) ?? "",
      owner: normalize(declaration.owner) ?? ""
    }));
}

export async function inspectExternalProjections({
  installRoot,
  projections,
  homeDirectory = os.homedir()
}: {
  installRoot: string;
  projections: ExternalProjection[];
  homeDirectory?: string;
}): Promise<ExternalProjectionInspection[]> {
  const root = path.resolve(installRoot);
  const inspections: ExternalProjectionInspection[] = [];

  for (const projection of [...projections].sort((left, right) => left.id.localeCompare(right.id))) {
    const targetPath = resolveExternalProjectionDestination(root, projection.destination);
    const sourcePath = resolveExternalProjectionSource(projection.source, homeDirectory);
    if (
      !hasRequiredProjectionFields(projection)
      || projection.mode !== EXTERNAL_PROJECTION_MODE
      || targetPath === null
      || sourcePath === null
    ) {
      inspections.push({
        ...projection,
        state: "external-invalid",
        targetPath,
        sourcePath,
        symlinkState: null,
        reason: invalidProjectionReason(projection, targetPath, sourcePath)
      });
      continue;
    }

    const symlinkedParent = await findSymlinkedParent(root, targetPath);
    if (symlinkedParent !== null) {
      inspections.push({
        ...projection,
        state: "external-drifted",
        targetPath,
        sourcePath,
        symlinkState: null,
        reason: `External projection ${targetPath} has symlinked parent or non-directory parent ${symlinkedParent}.`
      });
      continue;
    }

    const classification = await classifySymlinkInstall({ targetPath, expectedSourcePath: sourcePath });
    if (classification.state === "correct") {
      const identity = await readExternalProjectionIdentity(sourcePath);
      if (identity !== projection.skill) {
        inspections.push({
          ...projection,
          state: "external-invalid",
          targetPath,
          sourcePath,
          symlinkState: classification.state,
          reason: `External projection ${projection.id} declares ${projection.skill} but its SKILL.md identity is ${identity ?? "missing"}.`
        });
        continue;
      }
    }
    inspections.push({
      ...projection,
      state: externalState(classification.state),
      targetPath,
      sourcePath,
      symlinkState: classification.state,
      reason: externalReason(classification.state, targetPath, sourcePath)
    });
  }

  return inspections;
}

export async function readExternalProjectionIdentity(directory: string): Promise<string | null> {
  try {
    const normalized = (await readFile(path.join(directory, "SKILL.md"), "utf8")).replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---")) return null;
    const frontmatterAndBody = normalized.slice(3);
    const closing = /\n---\s*\n/.exec(frontmatterAndBody);
    if (closing?.index === undefined) return null;
    const yamlContent = frontmatterAndBody.slice(0, closing.index);
    let metadata: unknown;
    try {
      metadata = parse(yamlContent) as unknown;
    } catch {
      return null;
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const name = (metadata as Record<string, unknown>)["name"];
    if (typeof name !== "string" || name.trim().length === 0) return null;
    return name.trim();
  } catch {
    return null;
  }
}

export function resolveExternalProjectionDestination(installRoot: string, destination: string): string | null {
  if (!isSafeExternalProjectionDestination(destination)) return null;

  const root = path.resolve(installRoot);
  const targetPath = path.resolve(root, destination);
  const relative = path.relative(root, targetPath);
  if (
    relative.length === 0
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return null;
  }
  return targetPath;
}

export function resolveExternalProjectionSource(source: string, homeDirectory = os.homedir()): string | null {
  if (!isSafeExternalProjectionSource(source)) return null;
  const normalized = source;
  if (normalized === "~") {
    return path.resolve(homeDirectory);
  }
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return path.resolve(homeDirectory, normalized.slice(2));
  }
  return path.resolve(normalized);
}

export function isSafeExternalProjectionDestination(destination: string): boolean {
  const normalized = destination.trim();
  return normalized.length > 0
    && normalized === destination
    && !normalized.includes("\0")
    && !normalized.includes("\\")
    && !path.posix.isAbsolute(normalized)
    && normalized.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function isSafeExternalProjectionSource(source: string): boolean {
  const normalized = source.trim();
  if (normalized.length === 0 || normalized !== source || normalized.includes("\0")) return false;
  return normalized === "~"
    || normalized.startsWith("~/")
    || normalized.startsWith("~\\")
    || path.isAbsolute(normalized);
}

function externalState(state: SymlinkInstallState): ExternalProjectionState {
  if (state === "correct") return "external-current";
  if (state === "missing") return "external-missing";
  if (state === "broken") return "external-broken";
  return "external-drifted";
}

async function findSymlinkedParent(installRoot: string, targetPath: string): Promise<string | null> {
  const segments = path.relative(installRoot, targetPath).split(path.sep).slice(0, -1);
  let current = installRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return current;
    } catch {
      return null;
    }
  }
  return null;
}

function externalReason(state: SymlinkInstallState, targetPath: string, sourcePath: string): string {
  if (state === "correct") return `External projection ${targetPath} points to ${sourcePath}.`;
  if (state === "missing") return `External projection ${targetPath} is missing.`;
  if (state === "broken") return `External projection ${targetPath} is broken.`;
  if (state === "wrong-target") return `External projection ${targetPath} points somewhere other than ${sourcePath}.`;
  return `External projection ${targetPath} is ${state} instead of an exact symlink to ${sourcePath}.`;
}

function invalidProjectionReason(
  projection: ExternalProjection,
  targetPath: string | null,
  sourcePath: string | null
): string {
  if (!hasRequiredProjectionFields(projection)) {
    return `External projection ${projection.id || "<unnamed>"} is missing required identity, target, or owner metadata.`;
  }
  if (projection.mode !== EXTERNAL_PROJECTION_MODE) {
    return `External projection ${projection.id} uses unsupported mode ${projection.mode}.`;
  }
  if (targetPath === null) {
    return `External projection ${projection.id} has unsafe destination ${projection.destination}.`;
  }
  if (sourcePath === null) {
    return `External projection ${projection.id} has unsafe source ${projection.source}.`;
  }
  return `External projection ${projection.id} is invalid.`;
}

function hasRequiredProjectionFields(projection: ExternalProjection): boolean {
  return projection.id.trim().length > 0
    && projection.target.trim().length > 0
    && projection.skill.trim().length > 0
    && projection.owner.trim().length > 0;
}

function normalize(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlainPathSegment(value: string): boolean {
  return value.length > 0
    && !value.includes("/")
    && !value.includes("\\")
    && value !== "."
    && value !== ".."
    && value !== "__proto__"
    && value !== "constructor"
    && value !== "prototype";
}

function assignedSkillsForAssignment(
  manifest: ExternalProjectionMetadataManifest,
  assignmentName: string
): Set<string> {
  const assignedSkills = new Set<string>();
  const suitcaseNames = manifest.assignments[assignmentName]?.suitcases;
  if (!Array.isArray(suitcaseNames)) return assignedSkills;
  for (const suitcaseName of suitcaseNames) {
    if (typeof suitcaseName !== "string") continue;
    const skills = manifest.suitcases[suitcaseName]?.skills;
    if (!Array.isArray(skills)) continue;
    for (const skill of skills) {
      if (typeof skill === "string") assignedSkills.add(skill);
    }
  }
  return assignedSkills;
}
