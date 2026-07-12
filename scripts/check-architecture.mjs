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

  function visit(node, aliases = processAliases) {
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
      && node.arguments.length >= 1) {
      const specifier = staticStringValue(node.arguments[0], checker);
      if (specifier !== null) {
        importSpecifiers.push(specifier);
      }
    }

    if (ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && isNodeProcessSpecifier(node.moduleSpecifier.text)) {
      collectProcessImport(node.importClause, processMembers);
    } else if (ts.isExportDeclaration(node)
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && isNodeProcessSpecifier(node.moduleSpecifier.text)) {
      collectProcessExport(node, processMembers);
    }

    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isObjectBindingPattern(node.name)
        && isProcessObject(node.initializer, checker, aliases)) {
        collectProcessBindings(node.name, checker, processMembers);
      }
    } else if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && isProcessObject(node.right, checker, aliases)) {
      collectProcessAssignmentBindings(node.left, checker, processMembers);
    }

    if (ts.isPropertyAccessExpression(node)
      && !isInTypeOnlyContext(node)
      && isProcessObject(node.expression, checker, aliases)
      && isGuardedProcessMember(node.name.text)) {
      processMembers.push(node.name.text);
    } else if (ts.isElementAccessExpression(node)
      && !isInTypeOnlyContext(node)
      && isProcessObject(node.expression, checker, aliases)
      && node.argumentExpression !== undefined) {
      const member = staticStringValue(node.argumentExpression, checker);
      if (member !== null && isGuardedProcessMember(member)) {
        processMembers.push(member);
      }
    }

    if (ts.isSwitchStatement(node)) {
      hasSwitchStatement = true;
    }

    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      visit(node.left, aliases);
      visit(node.right, aliases);
      updateProcessAliases(node, checker, aliases);
      return;
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      visit(node.operand, aliases);
      updateProcessAliases(node, checker, aliases);
      return;
    }

    updateProcessAliases(node, checker, aliases);
    const childAliases = ts.isFunctionLike(node) ? new Set(aliases) : aliases;
    ts.forEachChild(node, (child) => visit(child, childAliases));
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

function updateProcessAliases(node, checker, processAliases) {
  if (ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && isNodeProcessSpecifier(node.moduleSpecifier.text)) {
    const importClause = node.importClause;
    if (importClause?.name !== undefined && !importClause.isTypeOnly) {
      setIdentifierAlias(importClause.name, true, checker, processAliases);
    }
    if (importClause?.namedBindings !== undefined && !importClause.isTypeOnly) {
      if (ts.isNamespaceImport(importClause.namedBindings)) {
        setIdentifierAlias(importClause.namedBindings.name, true, checker, processAliases);
      } else {
        for (const element of importClause.namedBindings.elements) {
          if (element.isTypeOnly) {
            continue;
          }
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === "default" || importedName === "process") {
            setIdentifierAlias(element.name, true, checker, processAliases);
          }
        }
      }
    }
    return;
  }
  if (ts.isImportEqualsDeclaration(node)
    && ts.isExternalModuleReference(node.moduleReference)
    && node.moduleReference.expression !== undefined
    && ts.isStringLiteralLike(node.moduleReference.expression)
    && isNodeProcessSpecifier(node.moduleReference.expression.text)
    && !node.isTypeOnly) {
    setIdentifierAlias(node.name, true, checker, processAliases);
    return;
  }
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
    if (ts.isIdentifier(node.name)) {
      setIdentifierAlias(
        node.name,
        isProcessObject(node.initializer, checker, processAliases),
        checker,
        processAliases
      );
    } else if (ts.isObjectBindingPattern(node.name)) {
      updateDestructuredAliases(node.name, node.initializer, checker, processAliases);
    }
    return;
  }
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    const left = unwrapExpression(node.left);
    if (ts.isIdentifier(left)) {
      setIdentifierAlias(
        left,
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && isProcessObject(node.right, checker, processAliases),
        checker,
        processAliases
      );
    } else if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      updateDestructuredAliases(left, node.right, checker, processAliases);
    }
    return;
  }
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
    const operand = unwrapExpression(node.operand);
    if (ts.isIdentifier(operand)) {
      setIdentifierAlias(operand, false, checker, processAliases);
    }
  }
}

function setIdentifierAlias(identifier, isAlias, checker, symbols) {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (symbol === undefined) {
    return;
  }
  if (isAlias) {
    symbols.add(symbol);
  } else {
    symbols.delete(symbol);
  }
}

function updateDestructuredAliases(pattern, initializer, checker, processAliases) {
  const entries = destructuringEntries(pattern, checker);
  const fromProcess = isProcessObject(initializer, checker, processAliases);
  const fromGlobal = isGlobalObject(initializer, checker);
  for (const { key, target } of entries) {
    setIdentifierAlias(
      target,
      (fromProcess && (key === "default" || key === "process")) || (fromGlobal && key === "process"),
      checker,
      processAliases
    );
  }
  for (const target of assignedIdentifiers(pattern)) {
    if (!entries.some((entry) => entry.target === target)) {
      setIdentifierAlias(target, false, checker, processAliases);
    }
  }
}

function collectProcessImport(importClause, processMembers) {
  if (importClause === undefined || importClause.isTypeOnly) {
    return;
  }
  if (importClause.namedBindings === undefined) {
    return;
  }
  if (ts.isNamespaceImport(importClause.namedBindings)) {
    return;
  }
  for (const element of importClause.namedBindings.elements) {
    if (element.isTypeOnly) {
      continue;
    }
    const importedName = element.propertyName?.text ?? element.name.text;
    if (isGuardedProcessMember(importedName)) {
      processMembers.push(importedName);
    }
  }
}

function collectProcessExport(declaration, processMembers) {
  if (declaration.isTypeOnly) {
    return;
  }
  const exportClause = declaration.exportClause;
  if (exportClause === undefined || ts.isNamespaceExport(exportClause)) {
    processMembers.push("argv", "stdout", "stderr");
    return;
  }
  for (const element of exportClause.elements) {
    if (element.isTypeOnly) {
      continue;
    }
    const exportedName = element.propertyName?.text ?? element.name.text;
    if (exportedName === "default") {
      processMembers.push("argv", "stdout", "stderr");
    } else if (isGuardedProcessMember(exportedName)) {
      processMembers.push(exportedName);
    }
  }
}

function isInTypeOnlyContext(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isTypeNode(current)) {
      if (ts.isExpressionWithTypeArguments(current)
        && ts.isHeritageClause(current.parent)
        && current.parent.token === ts.SyntaxKind.ExtendsKeyword
        && (ts.isClassDeclaration(current.parent.parent) || ts.isClassExpression(current.parent.parent))) {
        return false;
      }
      return true;
    }
  }
  return false;
}

function collectProcessBindings(pattern, checker, processMembers) {
  for (const { key } of destructuringEntries(pattern, checker)) {
    if (isGuardedProcessMember(key)) {
      processMembers.push(key);
    }
  }
}

function collectProcessAssignmentBindings(pattern, checker, processMembers) {
  collectProcessBindings(pattern, checker, processMembers);
}

function destructuringEntries(pattern, checker) {
  if (ts.isObjectBindingPattern(pattern)) {
    return pattern.elements.flatMap((element) => {
      if (ts.isOmittedExpression(element) || !ts.isIdentifier(element.name)) {
        return [];
      }
      const key = staticPropertyName(element.propertyName ?? element.name, checker);
      return [{ key, target: element.name }];
    });
  }
  if (!ts.isObjectLiteralExpression(pattern)) {
    return [];
  }
  return pattern.properties.flatMap((property) => {
    if (ts.isShorthandPropertyAssignment(property)) {
      return [{ key: property.name.text, target: property.name }];
    }
    if (!ts.isPropertyAssignment(property)) {
      return [];
    }
    const target = unwrapExpression(property.initializer);
    const key = staticPropertyName(property.name, checker);
    return ts.isIdentifier(target) ? [{ key, target }] : [];
  });
}

function assignedIdentifiers(pattern) {
  const identifiers = [];

  function visit(node) {
    const target = unwrapExpression(node);
    if (ts.isIdentifier(target)) {
      identifiers.push(target);
      return;
    }
    if (ts.isBindingElement(target)) {
      visit(target.name);
      return;
    }
    if (ts.isPropertyAssignment(target)) {
      visit(target.initializer);
      return;
    }
    if (ts.isShorthandPropertyAssignment(target)) {
      identifiers.push(target.name);
      return;
    }
    if (ts.isSpreadAssignment(target) || ts.isSpreadElement(target)) {
      visit(target.expression);
      return;
    }
    if (ts.isObjectBindingPattern(target)
      || ts.isArrayBindingPattern(target)
      || ts.isObjectLiteralExpression(target)
      || ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements ?? target.properties) {
        if (!ts.isOmittedExpression(element)) {
          visit(element);
        }
      }
    }
  }

  visit(pattern);
  return identifiers;
}

function staticPropertyName(name, checker) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return ts.isComputedPropertyName(name) ? staticStringValue(name.expression, checker) : null;
}

function isAssignmentOperator(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isProcessObject(node, checker, processAliases) {
  const expression = unwrapExpression(node);
  if (ts.isAwaitExpression(expression)) {
    return isProcessObject(expression.expression, checker, processAliases);
  }
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    return (symbol !== undefined && processAliases.has(symbol))
      || (expression.text === "process" && isUnshadowedGlobal(expression, checker));
  }
  if (isProcessModuleLoader(expression, checker)) {
    return true;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    if (expression.name.text === "default"
      && isProcessObject(expression.expression, checker, processAliases)) {
      return true;
    }
    return expression.name.text === "process" && isGlobalObject(expression.expression, checker);
  }
  if (!ts.isElementAccessExpression(expression)
    || expression.argumentExpression === undefined) {
    return false;
  }
  const member = staticStringValue(expression.argumentExpression, checker);
  if (member === "default") {
    return isProcessObject(expression.expression, checker, processAliases);
  }
  return member === "process" && isGlobalObject(expression.expression, checker);
}

function isGlobalObject(node, checker) {
  const expression = unwrapExpression(node);
  return ts.isIdentifier(expression)
    && (expression.text === "global" || expression.text === "globalThis")
    && isUnshadowedGlobal(expression, checker);
}

function isProcessModuleLoader(node, checker) {
  if (!ts.isCallExpression(node) || node.arguments.length < 1) {
    return false;
  }
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(node.expression)
    && node.expression.text === "require"
    && isUnshadowedGlobal(node.expression, checker);
  if (!isDynamicImport && !isRequire) {
    return false;
  }
  const specifier = staticStringValue(node.arguments[0], checker);
  return specifier !== null && isNodeProcessSpecifier(specifier);
}

function staticStringValue(node, checker, resolvingSymbols = new Set()) {
  const expression = unwrapExpression(node);
  if (ts.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(expression.left, checker, resolvingSymbols);
    if (left === null) {
      return null;
    }
    const right = staticStringValue(expression.right, checker, resolvingSymbols);
    return right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const replacement = staticStringValue(span.expression, checker, resolvingSymbols);
      if (replacement === null) {
        return null;
      }
      value += replacement + span.literal.text;
    }
    return value;
  }
  if (!ts.isIdentifier(expression)) {
    return null;
  }
  const symbol = checker.getSymbolAtLocation(expression);
  if (symbol === undefined || resolvingSymbols.has(symbol)) {
    return null;
  }
  const declarations = symbol.declarations?.filter((declaration) => ts.isVariableDeclaration(declaration)) ?? [];
  if (declarations.length !== 1) {
    return null;
  }
  const [declaration] = declarations;
  if (declaration.initializer === undefined
    || !ts.isVariableDeclarationList(declaration.parent)
    || (declaration.parent.flags & ts.NodeFlags.Const) === 0) {
    return null;
  }
  resolvingSymbols.add(symbol);
  const value = staticStringValue(declaration.initializer, checker, resolvingSymbols);
  resolvingSymbols.delete(symbol);
  return value;
}

function unwrapExpression(node) {
  let expression = node;
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
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
