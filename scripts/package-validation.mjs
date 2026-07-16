#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_MANIFEST_PATH = "dist/.package-build.json";
export const CLI_BIN_PATH = "dist/src/cli.js";

const BUILD_MANIFEST_SCHEMA = "skill-suitcase.package-build.v2";
const BUILD_INPUT_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json"
];
const EXPECTED_FILES_ALLOWLIST = [
  "dist/src/**/*.js",
  "skills/skill-suitcase/SKILL.md",
  "skills/skill-suitcase/agents/openai.yaml",
  "skills/skill-suitcase/evals/prompt-fixtures.json",
  "LICENSE",
  "VISION.md",
  "SPEC.md",
  "README.md",
  "INSTALL.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "DEVELOPING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CODE_OF_CONDUCT.md",
  "CLAUDE.md",
  "docs/command-reference.md",
  "docs/getting-started.md",
  "docs/install-smoke.md",
  "docs/portability-matrix.md",
  "docs/release-readiness.md",
  "docs/skills-sh-delegation.md",
  "examples/sample-catalog/README.md",
  "examples/sample-catalog/skill-suitcase.yaml",
  "examples/sample-catalog/.skill-suitcase/upstream-lock.json",
  "examples/sample-catalog/skills/hello-suitcase/SKILL.md",
  "examples/sample-catalog/skills/hello-suitcase/references/greeting.md"
];
const EXPECTED_KEYWORDS = [
  "agent-skills",
  "ai-agents",
  "cli",
  "skill-manager",
  "skills"
];
const EXPECTED_METADATA = {
  name: "skill-suitcase",
  license: "MIT",
  author: "Calvin Ng",
  packageManager: "pnpm@10.34.4",
  repository: {
    type: "git",
    url: "git+https://github.com/calvinnwq/skill-suitcase.git"
  },
  homepage: "https://calvinnwq.github.io/skill-suitcase/",
  bugs: {
    url: "https://github.com/calvinnwq/skill-suitcase/issues"
  },
  engines: {
    node: ">=20"
  },
  bin: {
    "skill-suitcase": CLI_BIN_PATH
  }
};
const REQUIRED_PACKED_PATHS = [
  CLI_BIN_PATH,
  "LICENSE",
  "README.md",
  "INSTALL.md",
  "package.json"
];

export function parsePackJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack did not emit valid JSON: ${messageFrom(error)}`);
  }

  assert(Array.isArray(parsed) && parsed.length === 1, "npm pack JSON must describe exactly one package");
  const result = parsed[0];
  assert(isRecord(result), "npm pack JSON entry must be an object");
  assert(typeof result.filename === "string" && result.filename.length > 0, "npm pack JSON is missing filename");
  assert(Array.isArray(result.files), "npm pack JSON is missing files");
  return result;
}

export async function recordPackageBuild(root = process.cwd()) {
  const packageJson = await readPackageJson(root);
  validatePackageMetadata(packageJson);
  const inputs = await Promise.all(BUILD_INPUT_PATHS.map(async (inputPath) => ({
    path: inputPath,
    sha256: await sha256File(path.join(root, inputPath))
  })));

  const sourcePaths = await listFiles(path.join(root, "src"), (relativePath) => relativePath.endsWith(".ts"));
  assert(sourcePaths.length > 0, "package build has no TypeScript source files");

  const entries = [];
  for (const sourceRelativePath of sourcePaths) {
    const source = path.posix.join("src", sourceRelativePath);
    const output = path.posix.join("dist", "src", sourceRelativePath.replace(/\.ts$/, ".js"));
    entries.push({
      source,
      sourceSha256: await sha256File(path.join(root, source)),
      output,
      outputSha256: await sha256File(path.join(root, output))
    });
  }

  const actualOutputs = await listFiles(path.join(root, "dist", "src"), (relativePath) => relativePath.endsWith(".js"));
  const expectedOutputs = entries.map((entry) => entry.output.slice("dist/src/".length));
  assertSamePaths(actualOutputs, expectedOutputs, "compiled package output");
  await assertExecutableCli(root);

  const manifest = {
    schema: BUILD_MANIFEST_SCHEMA,
    inputs,
    entries
  };
  await writeFile(path.join(root, BUILD_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function validatePackageBuild(root = process.cwd()) {
  const packageJson = await readPackageJson(root);
  validatePackageMetadata(packageJson);
  const manifest = await readBuildManifest(root);
  assertSamePaths(manifest.inputs.map((input) => input.path), BUILD_INPUT_PATHS, "package build input manifest");

  for (const input of manifest.inputs) {
    assert(
      await sha256File(path.join(root, input.path)) === input.sha256,
      `stale package build: build input changed after compilation (${input.path})`
    );
  }

  const currentSources = (await listFiles(path.join(root, "src"), (relativePath) => relativePath.endsWith(".ts")))
    .map((relativePath) => path.posix.join("src", relativePath));
  assertSamePaths(currentSources, manifest.entries.map((entry) => entry.source), "package source manifest");

  const currentOutputs = (await listFiles(path.join(root, "dist", "src"), (relativePath) => relativePath.endsWith(".js")))
    .map((relativePath) => path.posix.join("dist", "src", relativePath));
  assertSamePaths(currentOutputs, manifest.entries.map((entry) => entry.output), "package build manifest");

  for (const entry of manifest.entries) {
    assert(
      await sha256File(path.join(root, entry.source)) === entry.sourceSha256,
      `stale package build: source changed after compilation (${entry.source})`
    );
    assert(
      await sha256File(path.join(root, entry.output)) === entry.outputSha256,
      `stale package build: compiled output changed after compilation (${entry.output})`
    );
  }

  await assertExecutableCli(root);
  return { packageJson, manifest };
}

export async function validatePackResult(root, packResult) {
  const { packageJson, manifest } = await validatePackageBuild(root);
  assert(packResult.name === packageJson.name, `packed package name must be ${packageJson.name}`);
  assert(packResult.version === packageJson.version, `packed package version must be ${packageJson.version}`);

  const packedFiles = packResult.files;
  assert(Array.isArray(packedFiles), "npm pack JSON is missing files");
  const packedPaths = packedFiles.map((file) => {
    assert(isRecord(file) && typeof file.path === "string", "npm pack JSON contains a file without a path");
    return file.path;
  });
  const expectedPaths = await expectedPackedPaths(root, manifest);
  assertSamePaths(packedPaths, expectedPaths, "npm package payload");

  for (const requiredPath of REQUIRED_PACKED_PATHS) {
    assert(packedPaths.includes(requiredPath), `npm package is missing required path: ${requiredPath}`);
  }

  const packedBin = packedFiles.find((file) => file.path === CLI_BIN_PATH);
  assert(packedBin !== undefined, `npm package is missing CLI bin: ${CLI_BIN_PATH}`);
  assert(
    typeof packedBin.mode === "number" && (packedBin.mode & 0o111) === 0o111,
    `packed CLI bin is not executable by all users: ${CLI_BIN_PATH}`
  );

  return {
    filename: packResult.filename,
    entryCount: packedPaths.length,
    bin: CLI_BIN_PATH
  };
}

export function validatePackageMetadata(packageJson) {
  for (const [field, expected] of Object.entries(EXPECTED_METADATA)) {
    assert(
      JSON.stringify(packageJson[field]) === JSON.stringify(expected),
      `package metadata ${field} must equal ${JSON.stringify(expected)}`
    );
  }
  assert(
    JSON.stringify(packageJson.keywords) === JSON.stringify(EXPECTED_KEYWORDS),
    `package metadata keywords must equal ${JSON.stringify(EXPECTED_KEYWORDS)}`
  );
  assert(
    JSON.stringify(packageJson.files) === JSON.stringify(EXPECTED_FILES_ALLOWLIST),
    `package files allowlist must equal ${JSON.stringify(EXPECTED_FILES_ALLOWLIST)}`
  );
  assert(packageJson.publishConfig?.access === "public", "publishConfig.access must remain public");
}

async function expectedPackedPaths(root, manifest) {
  const paths = ["package.json"];

  for (const entry of EXPECTED_FILES_ALLOWLIST) {
    if (entry === "dist/src/**/*.js") {
      paths.push(...manifest.entries.map((item) => item.output));
      continue;
    }
    await access(path.join(root, entry), fsConstants.R_OK);
    paths.push(entry);
  }

  return paths;
}

async function readBuildManifest(root) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.join(root, BUILD_MANIFEST_PATH), "utf8"));
  } catch (error) {
    throw new Error(`package build manifest is missing or invalid (${BUILD_MANIFEST_PATH}): ${messageFrom(error)}`);
  }
  assert(isRecord(parsed) && parsed.schema === BUILD_MANIFEST_SCHEMA, "package build manifest has an unsupported schema");
  assert(Array.isArray(parsed.inputs) && parsed.inputs.length > 0, "package build manifest has no inputs");
  for (const input of parsed.inputs) {
    assert(
      isRecord(input)
        && typeof input.path === "string"
        && typeof input.sha256 === "string",
      "package build manifest contains an invalid input"
    );
  }
  assert(Array.isArray(parsed.entries) && parsed.entries.length > 0, "package build manifest has no entries");
  for (const entry of parsed.entries) {
    assert(
      isRecord(entry)
        && typeof entry.source === "string"
        && typeof entry.sourceSha256 === "string"
        && typeof entry.output === "string"
        && typeof entry.outputSha256 === "string",
      "package build manifest contains an invalid entry"
    );
  }
  return parsed;
}

async function readPackageJson(root) {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert(isRecord(packageJson), "package.json must contain an object");
  return packageJson;
}

async function assertExecutableCli(root) {
  const binPath = path.join(root, CLI_BIN_PATH);
  const binStat = await stat(binPath).catch((error) => {
    throw new Error(`package CLI bin is missing (${CLI_BIN_PATH}): ${messageFrom(error)}`);
  });
  assert(binStat.isFile(), `package CLI bin is not a file: ${CLI_BIN_PATH}`);
  assert((binStat.mode & 0o111) === 0o111, `package CLI bin is not executable by all users: ${CLI_BIN_PATH}`);
  const contents = await readFile(binPath, "utf8");
  assert(contents.startsWith("#!/usr/bin/env node\n"), `package CLI bin is missing its Node shebang: ${CLI_BIN_PATH}`);
}

async function listFiles(root, include) {
  const files = [];
  await walk(root, "", files, include);
  return files.sort((left, right) => left.localeCompare(right));
}

async function walk(root, relativeDirectory, files, include) {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? path.posix.join(relativeDirectory.split(path.sep).join(path.posix.sep), entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      await walk(root, relativePath, files, include);
    } else if (entry.isFile() && include(relativePath)) {
      files.push(relativePath);
    }
  }
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function assertSamePaths(actualPaths, expectedPaths, description) {
  const actual = [...actualPaths].sort((left, right) => left.localeCompare(right));
  const expected = [...expectedPaths].sort((left, right) => left.localeCompare(right));
  const missing = expected.filter((item) => !actual.includes(item));
  const unexpected = actual.filter((item) => !expected.includes(item));
  assert(
    missing.length === 0 && unexpected.length === 0 && actual.length === expected.length,
    `${description} mismatch; missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]`
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFrom(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const action = process.argv[2];
  if (action === "record") {
    await recordPackageBuild();
    return;
  }
  if (action === "validate") {
    await validatePackageBuild();
    return;
  }
  throw new Error("usage: node scripts/package-validation.mjs <record|validate>");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
