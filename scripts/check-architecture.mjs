#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");
const COMMAND_MODULE_MAX_LINES = 80;
const CLI_MAX_LINES = 60;

const FORBIDDEN_LAYER_IMPORTS = {
  adapters: new Set(["cli", "commands", "core", "renderers"]),
  commands: new Set(["cli", "adapters"]),
  config: new Set(["cli", "commands", "core", "adapters", "renderers"]),
  core: new Set(["cli", "commands", "renderers"]),
  renderers: new Set(["cli", "commands", "core", "adapters"]),
  shared: new Set(["cli", "commands", "core", "adapters", "renderers"])
};

const COMMAND_SUPPORT_FILES = new Set([
  "src/commands/helpers.ts",
  "src/commands/index.ts",
  "src/commands/target-overrides.ts",
  "src/commands/types.ts"
]);

export async function checkArchitecture(repoRoot = defaultRepoRoot) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const srcRoot = path.join(resolvedRepoRoot, "src");
  const failures = [];
  const sourceFiles = await collectTypeScriptFiles(srcRoot);
  const sourceFileSet = new Set(sourceFiles);

  for (const filePath of sourceFiles) {
    const relative = toRepoRelative(resolvedRepoRoot, filePath);
    const text = await readFile(filePath, "utf8");
    const analysis = analyzeSourceFile(filePath, text);
    const imported = importedSourceFiles(resolvedRepoRoot, sourceFileSet, filePath, analysis.importSpecifiers);
    const sourceLayer = sourceLayerFor(relative);
    const forbiddenTargets = sourceLayer === null ? undefined : FORBIDDEN_LAYER_IMPORTS[sourceLayer];

    if (forbiddenTargets !== undefined) {
      for (const target of imported) {
        const targetLayer = sourceLayerFor(target);
        if (targetLayer !== null && forbiddenTargets.has(targetLayer)) {
          failures.push(`${relative} imports forbidden ${targetLayer} boundary ${target}`);
        }
      }
    }

    for (const processMember of analysis.processMembers) {
      if (relative !== "src/cli.ts") {
        failures.push(`${relative} uses process.${processMember} outside the CLI boundary`);
      }
    }

    if (isCommandBehaviorModule(relative)) {
      const lines = nonEmptyLineCount(text);
      if (lines > COMMAND_MODULE_MAX_LINES) {
        failures.push(
          `${relative} has ${lines} non-empty lines; command behavior modules must stay at or below ${COMMAND_MODULE_MAX_LINES}`
        );
      }
    }
  }

  const cliPath = path.join(srcRoot, "cli.ts");
  const cliText = await readFile(cliPath, "utf8");
  const cliAnalysis = analyzeSourceFile(cliPath, cliText);
  const cliLines = nonEmptyLineCount(cliText);
  if (cliLines > CLI_MAX_LINES) {
    failures.push(`src/cli.ts has ${cliLines} non-empty lines; keep it as a thin entrypoint`);
  }

  for (const target of importedSourceFiles(resolvedRepoRoot, sourceFileSet, cliPath, cliAnalysis.importSpecifiers)) {
    const targetLayer = sourceLayerFor(target);
    if (targetLayer !== null && !new Set(["commands", "config", "renderers", "shared"]).has(targetLayer)) {
      failures.push(`src/cli.ts imports forbidden ${targetLayer} boundary ${target}`);
    }
  }

  if (cliAnalysis.hasSwitchStatement) {
    failures.push("src/cli.ts contains a switch statement; command dispatch belongs in src/commands/");
  }

  return failures.sort();
}

export async function runArchitectureCheck(repoRoot = defaultRepoRoot) {
  const failures = await checkArchitecture(repoRoot);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`Architecture guardrail failed: ${failure}`);
    }
    return 1;
  }

  console.log("Architecture guardrails passed.");
  return 0;
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

function importedSourceFiles(repoRoot, sourceFileSet, filePath, specifiers) {
  const imports = [];

  for (const specifier of specifiers) {
    if (!specifier.startsWith(".")) {
      continue;
    }
    const resolved = resolveSourceSpecifier(repoRoot, sourceFileSet, filePath, specifier);
    if (resolved !== null) {
      imports.push(resolved);
    }
  }
  return [...new Set(imports)].sort();
}

function analyzeSourceFile(filePath, text) {
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const importSpecifiers = [];
  const processMembers = [];
  let hasSwitchStatement = false;

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteralLike(node.moduleSpecifier)) {
      importSpecifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression !== undefined
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      importSpecifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])) {
      importSpecifiers.push(node.arguments[0].text);
    }

    if (ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "process"
      && isGuardedProcessMember(node.name.text)) {
      processMembers.push(node.name.text);
    } else if (ts.isElementAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "process"
      && node.argumentExpression !== undefined
      && ts.isStringLiteralLike(node.argumentExpression)
      && isGuardedProcessMember(node.argumentExpression.text)) {
      processMembers.push(node.argumentExpression.text);
    }

    if (ts.isSwitchStatement(node)) {
      hasSwitchStatement = true;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return {
    importSpecifiers: [...new Set(importSpecifiers)].sort(),
    processMembers: [...new Set(processMembers)].sort(),
    hasSwitchStatement
  };
}

function isGuardedProcessMember(value) {
  return value === "argv" || value === "stdout" || value === "stderr";
}

function resolveSourceSpecifier(repoRoot, sourceFileSet, filePath, specifier) {
  const resolved = path.resolve(path.dirname(filePath), specifier);
  for (const candidate of candidateSourcePaths(resolved)) {
    if (sourceFileSet.has(candidate)) {
      return toRepoRelative(repoRoot, candidate);
    }
  }
  return null;
}

function candidateSourcePaths(resolved) {
  const candidates = [];
  if (resolved.endsWith(".js")) {
    candidates.push(`${resolved.slice(0, -3)}.ts`);
  }
  candidates.push(resolved, `${resolved}.ts`, path.join(resolved, "index.ts"));
  return candidates;
}

function sourceLayerFor(relative) {
  if (relative === "src/cli.ts") {
    return "cli";
  }
  const match = relative.match(/^src\/(adapters|commands|config|core|renderers|shared)\//);
  return match?.[1] ?? null;
}

function isCommandBehaviorModule(relative) {
  return relative.startsWith("src/commands/") && !COMMAND_SUPPORT_FILES.has(relative);
}

function nonEmptyLineCount(text) {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

function toRepoRelative(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await runArchitectureCheck();
}
