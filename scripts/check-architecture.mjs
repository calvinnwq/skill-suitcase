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

    if (sourceLayer === null) {
      failures.push(`${relative} is outside the recognized architecture layers`);
    }

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
  const checker = createTypeChecker(filePath, sourceFile);
  const importSpecifiers = [];
  const processMembers = [];
  const processAliases = new Set();
  let hasSwitchStatement = false;

  collectProcessAliases(sourceFile, checker, processAliases);

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

    if (ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && isNodeProcessSpecifier(node.moduleSpecifier.text)) {
      collectProcessImport(node.importClause, processMembers);
    } else if (ts.isExportDeclaration(node)
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && isNodeProcessSpecifier(node.moduleSpecifier.text)) {
      collectProcessExport(node.exportClause, processMembers);
    }

    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isObjectBindingPattern(node.name)
        && isProcessObject(node.initializer, checker, processAliases)) {
        collectProcessBindings(node.name, processMembers);
      }
    }

    if (ts.isPropertyAccessExpression(node)
      && isProcessObject(node.expression, checker, processAliases)
      && isGuardedProcessMember(node.name.text)) {
      processMembers.push(node.name.text);
    } else if (ts.isElementAccessExpression(node)
      && isProcessObject(node.expression, checker, processAliases)
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

function createTypeChecker(filePath, sourceFile) {
  const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.fileExists = (candidate) => path.resolve(candidate) === path.resolve(filePath);
  host.getSourceFile = (candidate) => path.resolve(candidate) === path.resolve(filePath) ? sourceFile : undefined;
  host.readFile = (candidate) => path.resolve(candidate) === path.resolve(filePath) ? sourceFile.text : undefined;
  const program = ts.createProgram([filePath], options, host);
  return program.getTypeChecker();
}

function isNodeProcessSpecifier(specifier) {
  return specifier === "node:process" || specifier === "process";
}

function collectProcessAliases(sourceFile, checker, processAliases) {
  const declarations = [];

  function visit(node) {
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && isNodeProcessSpecifier(node.moduleSpecifier.text)) {
      const importClause = node.importClause;
      if (importClause?.name !== undefined) {
        addIdentifierSymbol(importClause.name, checker, processAliases);
      }
      if (importClause?.namedBindings !== undefined) {
        if (ts.isNamespaceImport(importClause.namedBindings)) {
          addIdentifierSymbol(importClause.namedBindings.name, checker, processAliases);
        } else {
          for (const element of importClause.namedBindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text;
            if (importedName === "process") {
              addIdentifierSymbol(element.name, checker, processAliases);
            }
          }
        }
      }
    } else if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (isProcessObject(declaration.initializer, checker, processAliases)) {
        changed = addIdentifierSymbol(declaration.name, checker, processAliases) || changed;
      }
    }
  }
}

function addIdentifierSymbol(identifier, checker, symbols) {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (symbol === undefined || symbols.has(symbol)) {
    return false;
  }
  symbols.add(symbol);
  return true;
}

function collectProcessImport(importClause, processMembers) {
  if (importClause === undefined) {
    return;
  }
  if (importClause.namedBindings === undefined) {
    return;
  }
  if (ts.isNamespaceImport(importClause.namedBindings)) {
    return;
  }
  for (const element of importClause.namedBindings.elements) {
    const importedName = element.propertyName?.text ?? element.name.text;
    if (isGuardedProcessMember(importedName)) {
      processMembers.push(importedName);
    }
  }
}

function collectProcessExport(exportClause, processMembers) {
  if (exportClause === undefined || ts.isNamespaceExport(exportClause)) {
    processMembers.push("argv", "stdout", "stderr");
    return;
  }
  for (const element of exportClause.elements) {
    const exportedName = element.propertyName?.text ?? element.name.text;
    if (exportedName === "default") {
      processMembers.push("argv", "stdout", "stderr");
    } else if (isGuardedProcessMember(exportedName)) {
      processMembers.push(exportedName);
    }
  }
}

function collectProcessBindings(pattern, processMembers) {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    const propertyName = element.propertyName ?? element.name;
    if (ts.isIdentifier(propertyName) && isGuardedProcessMember(propertyName.text)) {
      processMembers.push(propertyName.text);
    } else if (ts.isStringLiteralLike(propertyName) && isGuardedProcessMember(propertyName.text)) {
      processMembers.push(propertyName.text);
    }
  }
}

function isProcessObject(node, checker, processAliases) {
  if (ts.isParenthesizedExpression(node)) {
    return isProcessObject(node.expression, checker, processAliases);
  }
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    return (symbol !== undefined && processAliases.has(symbol))
      || (node.text === "process" && isUnshadowedGlobal(node, checker));
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === "process"
      && ts.isIdentifier(node.expression)
      && node.expression.text === "globalThis"
      && isUnshadowedGlobal(node.expression, checker);
  }
  return ts.isElementAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "globalThis"
    && isUnshadowedGlobal(node.expression, checker)
    && node.argumentExpression !== undefined
    && ts.isStringLiteralLike(node.argumentExpression)
    && node.argumentExpression.text === "process";
}

function isUnshadowedGlobal(identifier, checker) {
  const symbol = checker.getSymbolAtLocation(identifier);
  return symbol === undefined
    || symbol.declarations === undefined
    || symbol.declarations.every((declaration) => declaration.getSourceFile() !== identifier.getSourceFile());
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
  if (match !== null) {
    return match[1];
  }
  return /^src\/[^/]+\.ts$/.test(relative) ? "core" : null;
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
