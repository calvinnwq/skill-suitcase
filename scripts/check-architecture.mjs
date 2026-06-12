#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(repoRoot, "src");
const failures = [];

const sourceFiles = await collectTypeScriptFiles(srcRoot);
for (const filePath of sourceFiles) {
  const relative = toRepoRelative(filePath);
  const text = await readFile(filePath, "utf8");
  const imported = importedSourceFiles(filePath, text);

  if (relative.startsWith("src/core/")) {
    for (const target of imported) {
      if (target.startsWith("src/commands/")) {
        failures.push(`${relative} imports command boundary ${target}`);
      }
      if (target.startsWith("src/renderers/")) {
        failures.push(`${relative} imports renderer boundary ${target}`);
      }
    }
  }

  if (relative.startsWith("src/adapters/")) {
    for (const target of imported) {
      if (target.startsWith("src/commands/")) {
        failures.push(`${relative} imports command boundary ${target}`);
      }
    }
  }

  for (const match of text.matchAll(/\bprocess\.(argv|stdout|stderr)\b/g)) {
    const processMember = match[1];
    const allowed = processMember === "argv"
      ? relative === "src/cli.ts"
      : relative === "src/cli.ts" || relative.startsWith("src/renderers/");
    if (!allowed) {
      failures.push(`${relative} uses process.${processMember} outside the CLI/rendering boundary`);
    }
  }
}

const cliPath = path.join(srcRoot, "cli.ts");
const cliText = await readFile(cliPath, "utf8");
const cliLines = cliText.split("\n").filter((line) => line.trim() !== "").length;
if (cliLines > 60) {
  failures.push(`src/cli.ts has ${cliLines} non-empty lines; keep it as a thin entrypoint`);
}
if (/from "\.\/core\//.test(cliText) || /from "\.\/adapters\//.test(cliText)) {
  failures.push("src/cli.ts imports core/adapters directly instead of using the command boundary");
}
if (/\bswitch\s*\(/.test(cliText)) {
  failures.push("src/cli.ts contains a switch statement; command dispatch belongs in src/commands/");
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`Architecture guardrail failed: ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Architecture guardrails passed.");
}

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTypeScriptFiles(child));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(child);
    }
  }
  return files.sort();
}

function importedSourceFiles(filePath, text) {
  const imports = [];
  const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier === undefined || !specifier.startsWith(".")) {
      continue;
    }
    const resolved = resolveSourceSpecifier(filePath, specifier);
    if (resolved !== null) {
      imports.push(resolved);
    }
  }
  return imports;
}

function resolveSourceSpecifier(filePath, specifier) {
  const resolved = path.resolve(path.dirname(filePath), specifier);
  const candidates = [
    resolved,
    `${resolved}.ts`,
    path.join(resolved, "index.ts")
  ];
  for (const candidate of candidates) {
    if (candidate.startsWith(srcRoot)) {
      return toRepoRelative(candidate);
    }
  }
  return null;
}

function toRepoRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}
