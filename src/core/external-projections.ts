import os from "node:os";
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
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

type ExternalProjectionDeclaration = Partial<Record<
  "target" | "skill" | "destination" | "source" | "mode" | "owner",
  string
>>;

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
        reason: `External projection ${targetPath} has symlinked parent ${symlinkedParent}.`
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

export async function readExternalProjectionIdentity(
  directory: string,
  fallback = path.basename(path.resolve(directory))
): Promise<string | null> {
  try {
    const normalized = (await readFile(path.join(directory, "SKILL.md"), "utf8")).replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---")) return fallback;
    const frontmatterAndBody = normalized.slice(3);
    const closing = /\n---\s*\n/.exec(frontmatterAndBody);
    if (closing?.index === undefined) return fallback;
    const yamlContent = frontmatterAndBody.slice(0, closing.index);
    let metadata: unknown;
    try {
      metadata = parse(yamlContent) as unknown;
    } catch {
      metadata = parseSimpleFrontmatter(yamlContent);
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return fallback;
    const name = (metadata as Record<string, unknown>)["name"];
    return name === undefined || name === null || String(name).length === 0 ? fallback : String(name);
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

function parseSimpleFrontmatter(value: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const line of value.trim().split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return metadata;
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
      if ((await lstat(current)).isSymbolicLink()) return current;
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

function normalize(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
