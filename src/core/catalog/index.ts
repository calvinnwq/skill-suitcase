import path from "node:path";
import { parseSuitcaseManifest } from "./suitcase-manifest.js";
import { DEFAULT_SUITCASE_MANIFEST_FILE } from "../../config/defaults.js";
import { readTextFile } from "../../adapters/filesystem.js";

export type Catalog = ReturnType<typeof parseSuitcaseManifest>;

export type LoadedCatalog = {
  sourceRoot: string;
  manifestPath: string;
  manifest: Catalog;
};

export async function loadCatalog(source: string): Promise<LoadedCatalog> {
  if (!source) {
    throw new Error("source is required");
  }

  const sourceRoot = path.resolve(source);
  const manifestPath = path.join(sourceRoot, DEFAULT_SUITCASE_MANIFEST_FILE);
  const manifestText = await readTextFile(manifestPath);

  return {
    sourceRoot,
    manifestPath,
    manifest: parseSuitcaseManifest(manifestText)
  };
}
