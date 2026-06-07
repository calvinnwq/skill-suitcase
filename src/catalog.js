import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSuitcaseManifest } from "./suitcase-manifest.js";

export async function loadCatalog(source) {
  if (!source) {
    throw new Error("source is required");
  }

  const sourceRoot = path.resolve(source);
  const manifestPath = path.join(sourceRoot, "skill-suitcase.yaml");
  const manifestText = await readFile(manifestPath, "utf8");

  return {
    sourceRoot,
    manifestPath,
    manifest: parseSuitcaseManifest(manifestText)
  };
}
