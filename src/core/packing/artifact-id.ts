import { createHash } from "node:crypto";
import path from "node:path";

export const BUNDLE_SCHEMA = "calvinnwq.skills.pack-bundle.v0";

type ArtifactIdInput = {
  source: {
    repo: string;
    [key: string]: unknown;
  };
  target: unknown;
  action: unknown;
  planned: readonly unknown[];
  blocked: readonly unknown[];
  files: readonly unknown[];
  fileHashes: unknown;
  summary: unknown;
};

export function computePackArtifactId(artifact: ArtifactIdInput): string {
  return hashArtifact(artifact, stableObject);
}

export function matchesPackArtifactId(artifactId: string, artifact: ArtifactIdInput): boolean {
  return artifactId === computePackArtifactId(artifact)
    || artifactId === hashArtifact(artifact, legacyStableObject);
}

function hashArtifact(
  artifact: ArtifactIdInput,
  canonicalize: (value: unknown) => unknown
): string {
  const stableArtifact = {
    source: artifact.source,
    target: artifact.target,
    action: artifact.action,
    planned: artifact.planned.map((item) => ({
      skill: field(item, "skill"),
      action: field(item, "action"),
      variant: field(item, "variant"),
      sourcePath: normalizeSourcePath(artifact.source.repo, field(item, "sourcePath")),
      destination: field(item, "destination"),
      evidence: evidenceArray(item)
    })),
    blocked: artifact.blocked.map((item) => ({
      skill: field(item, "skill"),
      action: field(item, "action"),
      target: field(item, "target"),
      reason: field(item, "reason"),
      variant: field(item, "variant"),
      sourcePath: normalizeSourcePath(artifact.source.repo, field(item, "sourcePath")),
      evidence: evidenceArray(item)
    })),
    files: artifact.files.map((item) => ({
      skill: field(item, "skill"),
      relativePath: field(item, "relativePath"),
      destination: field(item, "destination"),
      sha256: field(item, "sha256"),
      bytes: field(item, "bytes")
    })),
    fileHashes: artifact.fileHashes,
    summary: artifact.summary,
    schema: BUNDLE_SCHEMA
  };

  return createHash("sha256").update(JSON.stringify(canonicalize(stableArtifact))).digest("hex");
}

function field(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}

function normalizeSourcePath(sourceRoot: string, sourcePath: unknown): unknown {
  if (typeof sourcePath !== "string") return sourcePath;
  return path.isAbsolute(sourcePath) ? sourcePath : path.join(sourceRoot, sourcePath);
}

function evidenceArray(value: unknown): unknown[] {
  const evidence = field(value, "evidence");
  return Array.isArray(evidence) ? [...evidence] : [];
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableObject(item));
  if (!isRecord(value)) return value;

  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    ordered[key] = stableObject(value[key]);
  }
  return ordered;
}

function legacyStableObject(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    ordered[key] = legacyStableObject(value[key]);
  }
  return ordered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
