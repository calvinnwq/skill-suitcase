import path from "node:path";
import { parseSuitcaseManifest } from "./suitcase-manifest.js";
import { DEFAULT_SUITCASE_MANIFEST_FILE } from "../../config/defaults.js";
import { readTextFile } from "../../adapters/filesystem.js";

export type Catalog = ReturnType<typeof parseSuitcaseManifest>;

export type TargetOverrides = {
  codexHome?: string;
  codexSkills?: string;
  claudeSkills?: string;
};

export type LoadedCatalog = {
  sourceRoot: string;
  manifestPath: string;
  manifest: Catalog;
};

export async function loadCatalog(
  source: string,
  { targetOverrides }: { targetOverrides?: TargetOverrides | undefined } = {}
): Promise<LoadedCatalog> {
  if (!source) {
    throw new Error("source is required");
  }

  const sourceRoot = path.resolve(source);
  const manifestPath = path.join(sourceRoot, DEFAULT_SUITCASE_MANIFEST_FILE);
  const manifestText = await readTextFile(manifestPath);
  const manifest = parseSuitcaseManifest(manifestText);

  return {
    sourceRoot,
    manifestPath,
    manifest: applyTargetOverrides(manifest, targetOverrides)
  };
}

function applyTargetOverrides(manifest: Catalog, overrides: TargetOverrides | undefined): Catalog {
  if (overrides === undefined || isEmptyTargetOverrides(overrides)) {
    return manifest;
  }

  const assignmentPaths: Catalog["assignmentPaths"] = {};
  for (const [targetId, assignmentPath] of Object.entries(manifest.assignmentPaths)) {
    assignmentPaths[targetId] = { ...assignmentPath };
  }

  const codexGlobal = assignmentPaths["codex"];
  if (codexGlobal !== undefined && (overrides.codexHome !== undefined || overrides.codexSkills !== undefined)) {
    const codexHome = overrides.codexHome !== undefined
      ? path.resolve(overrides.codexHome)
      : undefined;
    const skillsPath = overrides.codexSkills !== undefined
      ? path.resolve(overrides.codexSkills)
      : codexHome !== undefined
        ? path.join(codexHome, "skills")
        : undefined;

    if (codexHome !== undefined) {
      codexGlobal.codexHome = codexHome;
    }
    if (skillsPath !== undefined) {
      codexGlobal.skillsPath = skillsPath;
    }
  }

  const claudeGlobal = assignmentPaths["claude"];
  if (claudeGlobal !== undefined && overrides.claudeSkills !== undefined) {
    claudeGlobal.path = path.resolve(overrides.claudeSkills);
  }

  return {
    ...manifest,
    assignmentPaths
  };
}

function isEmptyTargetOverrides(overrides: TargetOverrides): boolean {
  return overrides.codexHome === undefined &&
    overrides.codexSkills === undefined &&
    overrides.claudeSkills === undefined;
}
