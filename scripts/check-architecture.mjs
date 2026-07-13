#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");
const COMMAND_MODULE_MAX_LINES = 80;
const CLI_MAX_LINES = 60;

const ALLOWED_LAYER_IMPORTS = {
  cli: new Set(["commands", "config", "renderers", "shared"]),
  commands: new Set(["commands", "core", "config", "renderers", "shared"]),
  core: new Set(["core", "adapters", "config", "shared"]),
  adapters: new Set(["adapters", "config", "shared"]),
  renderers: new Set(["renderers", "config", "shared"]),
  config: new Set(["config", "shared"]),
  shared: new Set(["config", "shared"])
};

const COMMAND_SUPPORT_FILES = new Set([
  "src/commands/helpers.ts",
  "src/commands/index.ts",
  "src/commands/target-overrides.ts",
  "src/commands/types.ts"
]);

const GUARDED_PROCESS_MEMBERS = new Set(["argv", "stdout", "stderr"]);

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
    const sourceLayer = sourceLayerFor(relative);

    if (sourceLayer === null) {
      failures.push(`${relative} is outside the recognized architecture layers`);
    } else {
      const imported = importedSourceFiles(resolvedRepoRoot, sourceFileSet, filePath, analysis.importSpecifiers);
      for (const target of imported) {
        const targetLayer = sourceLayerFor(target);
        if (targetLayer !== null && !ALLOWED_LAYER_IMPORTS[sourceLayer].has(targetLayer)) {
          failures.push(`${relative} imports forbidden ${targetLayer} boundary ${target}`);
        }
      }
    }

    if (relative !== "src/cli.ts") {
      for (const processMember of analysis.processMembers) {
        failures.push(`${relative} uses process.${processMember} outside the CLI boundary`);
      }
    }

    for (const consoleMethod of analysis.consoleMethods) {
      failures.push(`${relative} uses console.${consoleMethod}; output must use renderer helpers at the CLI boundary`);
    }

    if (relative === "src/cli.ts") {
      for (const stream of analysis.unrenderedCliWrites) {
        failures.push(`src/cli.ts writes process.${stream} without a renderer helper`);
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
  if (cliAnalysis.hasSwitchStatement) {
    failures.push("src/cli.ts contains a switch statement; command dispatch belongs in src/commands/");
  }

  return [...new Set(failures)].sort();
}

export async function runArchitectureCheck(repoRoot = defaultRepoRoot, io = defaultIo()) {
  const failures = await checkArchitecture(repoRoot);
  if (failures.length > 0) {
    for (const failure of failures) {
      io.stderr(`Architecture guardrail failed: ${failure}\n`);
    }
    return 1;
  }

  io.stdout("Architecture guardrails passed.\n");
  return 0;
}

function analyzeSourceFile(filePath, text) {
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const checker = createTypeChecker(filePath, sourceFile);
  const importSpecifiers = [];
  const processMembers = new Set();
  const consoleMethods = new Set();
  const unrenderedCliWrites = new Set();
  const processObjectBindings = new Set();
  const processStreamBindings = new Map();
  const rendererBindings = new Map();
  let hasSwitchStatement = false;

  collectImportedBindings(
    sourceFile,
    checker,
    processObjectBindings,
    processMembers,
    processStreamBindings,
    rendererBindings
  );

  function visit(node) {
    const specifier = moduleSpecifierFromNode(node);
    if (specifier !== null) {
      importSpecifiers.push(specifier);
    }

    const processMember = directProcessMember(node, checker, processObjectBindings);
    if (processMember !== null) {
      processMembers.add(processMember);
    }

    if (ts.isVariableDeclaration(node)
      && node.initializer !== undefined
      && ts.isObjectBindingPattern(node.name)
      && isDirectProcessObject(node.initializer, checker, processObjectBindings)) {
      collectGuardedBindingNames(node.name, checker, processMembers, processStreamBindings);
    }
    if (ts.isVariableDeclaration(node)
      && node.initializer !== undefined
      && ts.isIdentifier(node.name)) {
      const boundStream = directProcessMember(unwrapExpression(node.initializer), checker, processObjectBindings);
      if (boundStream === "stdout" || boundStream === "stderr") {
        setStreamBinding(node.name, boundStream, checker, processStreamBindings);
      }
    }
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isObjectLiteralExpression(unwrapExpression(node.left))
      && isDirectProcessObject(node.right, checker, processObjectBindings)) {
      collectGuardedAssignmentNames(unwrapExpression(node.left), checker, processMembers, processStreamBindings);
    }

    if (ts.isCallExpression(node)) {
      const consoleMethod = directConsoleMethod(node);
      if (consoleMethod !== null) {
        consoleMethods.add(consoleMethod);
      }

      const stream = directProcessWriteStream(node, checker, processObjectBindings, processStreamBindings);
      if (stream !== null && !isApprovedRendererWrite(node.arguments[0], stream, checker, rendererBindings)) {
        unrenderedCliWrites.add(stream);
      }
    }

    if (ts.isSwitchStatement(node)) {
      hasSwitchStatement = true;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return {
    importSpecifiers: [...new Set(importSpecifiers)].sort(),
    processMembers: [...processMembers].sort(),
    consoleMethods: [...consoleMethods].sort(),
    unrenderedCliWrites: [...unrenderedCliWrites].sort(),
    hasSwitchStatement
  };
}

function collectImportedBindings(
  sourceFile,
  checker,
  processObjectBindings,
  processMembers,
  processStreamBindings,
  rendererBindings
) {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const importClause = statement.importClause;
      if (importClause === undefined || importClause.isTypeOnly) {
        continue;
      }

      if (isNodeProcessSpecifier(specifier)) {
        if (importClause.name !== undefined) {
          addProcessObjectBinding(importClause.name, checker, processObjectBindings);
        }
        if (importClause.namedBindings !== undefined) {
          if (ts.isNamespaceImport(importClause.namedBindings)) {
            addProcessObjectBinding(importClause.namedBindings.name, checker, processObjectBindings);
          } else {
            for (const element of importClause.namedBindings.elements) {
              if (element.isTypeOnly) {
                continue;
              }
              const importedName = element.propertyName?.text ?? element.name.text;
              if (importedName === "default" || importedName === "process") {
                addProcessObjectBinding(element.name, checker, processObjectBindings);
              } else if (GUARDED_PROCESS_MEMBERS.has(importedName)) {
                processMembers.add(importedName);
                setStreamBinding(element.name, importedName, checker, processStreamBindings);
              }
            }
          }
        }
      }

      if (isRendererSpecifier(specifier) && importClause.namedBindings !== undefined) {
        if (ts.isNamespaceImport(importClause.namedBindings)) {
          const symbol = checker.getSymbolAtLocation(importClause.namedBindings.name);
          if (symbol !== undefined) {
            rendererBindings.set(symbol, { importedName: null, specifier });
          }
        } else {
          for (const element of importClause.namedBindings.elements) {
            if (element.isTypeOnly) {
              continue;
            }
            const symbol = checker.getSymbolAtLocation(element.name);
            if (symbol !== undefined) {
              rendererBindings.set(symbol, {
                importedName: element.propertyName?.text ?? element.name.text,
                specifier
              });
            }
          }
        }
      }
    } else if (ts.isImportEqualsDeclaration(statement)
      && !statement.isTypeOnly
      && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression !== undefined
      && ts.isStringLiteralLike(statement.moduleReference.expression)
      && isNodeProcessSpecifier(statement.moduleReference.expression.text)) {
      addProcessObjectBinding(statement.name, checker, processObjectBindings);
    } else if (ts.isExportDeclaration(statement)
      && !statement.isTypeOnly
      && statement.moduleSpecifier !== undefined
      && ts.isStringLiteralLike(statement.moduleSpecifier)
      && isNodeProcessSpecifier(statement.moduleSpecifier.text)) {
      collectProcessExports(statement, processMembers);
    }
  }
}

function collectProcessExports(declaration, processMembers) {
  const exportClause = declaration.exportClause;
  if (exportClause === undefined || ts.isNamespaceExport(exportClause)) {
    for (const member of GUARDED_PROCESS_MEMBERS) {
      processMembers.add(member);
    }
    return;
  }
  for (const element of exportClause.elements) {
    if (element.isTypeOnly) {
      continue;
    }
    const exportedName = element.propertyName?.text ?? element.name.text;
    if (exportedName === "default" || exportedName === "process") {
      for (const member of GUARDED_PROCESS_MEMBERS) {
        processMembers.add(member);
      }
    } else if (GUARDED_PROCESS_MEMBERS.has(exportedName)) {
      processMembers.add(exportedName);
    }
  }
}

function moduleSpecifierFromNode(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    && node.moduleSpecifier !== undefined
    && ts.isStringLiteralLike(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  if (ts.isImportEqualsDeclaration(node)
    && ts.isExternalModuleReference(node.moduleReference)
    && node.moduleReference.expression !== undefined
    && ts.isStringLiteralLike(node.moduleReference.expression)) {
    return node.moduleReference.expression.text;
  }
  if (ts.isCallExpression(node) && node.arguments.length >= 1) {
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression)
      && node.expression.text === "require";
    const argument = unwrapExpression(node.arguments[0]);
    if ((isDynamicImport || isRequire) && ts.isStringLiteralLike(argument)) {
      return argument.text;
    }
  }
  return null;
}

function directProcessMember(node, checker, processObjectBindings) {
  if (isInTypeOnlyContext(node)) {
    return null;
  }
  if (ts.isPropertyAccessExpression(node)
    && isDirectProcessObject(node.expression, checker, processObjectBindings)
    && GUARDED_PROCESS_MEMBERS.has(node.name.text)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node)
    && isDirectProcessObject(node.expression, checker, processObjectBindings)
    && node.argumentExpression !== undefined
    && ts.isStringLiteralLike(unwrapExpression(node.argumentExpression))
    && GUARDED_PROCESS_MEMBERS.has(unwrapExpression(node.argumentExpression).text)) {
    return unwrapExpression(node.argumentExpression).text;
  }
  return null;
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

function isDirectProcessObject(node, checker, processObjectBindings) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    if (expression.text === "process") {
      return true;
    }
    const symbol = checker.getSymbolAtLocation(expression);
    return symbol !== undefined && processObjectBindings.has(symbol);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    if (expression.name.text === "default"
      && isDirectProcessObject(expression.expression, checker, processObjectBindings)) {
      return true;
    }
    return expression.name.text === "process" && isGlobalObject(expression.expression);
  }
  if (ts.isElementAccessExpression(expression)
    && expression.argumentExpression !== undefined) {
    const argument = unwrapExpression(expression.argumentExpression);
    if (!ts.isStringLiteralLike(argument)) {
      return false;
    }
    if (argument.text === "default"
      && isDirectProcessObject(expression.expression, checker, processObjectBindings)) {
      return true;
    }
    return argument.text === "process" && isGlobalObject(expression.expression);
  }
  if (ts.isAwaitExpression(expression)) {
    return isDirectProcessObject(expression.expression, checker, processObjectBindings);
  }
  return isDirectProcessLoader(expression);
}

function directProcessWriteStream(node, checker, processObjectBindings, processStreamBindings) {
  const callee = unwrapExpression(node.expression);
  let streamExpression;
  if (ts.isPropertyAccessExpression(callee)
    && isProcessOutputMethod(callee.name.text, node.arguments.length)) {
    streamExpression = callee.expression;
  } else if (ts.isElementAccessExpression(callee)
    && callee.argumentExpression !== undefined
    && ts.isStringLiteralLike(unwrapExpression(callee.argumentExpression))
    && isProcessOutputMethod(unwrapExpression(callee.argumentExpression).text, node.arguments.length)) {
    streamExpression = callee.expression;
  } else {
    return null;
  }
  const directMember = directProcessMember(streamExpression, checker, processObjectBindings);
  if (directMember !== null) {
    return directMember;
  }
  const unwrapped = unwrapExpression(streamExpression);
  if (!ts.isIdentifier(unwrapped)) {
    return null;
  }
  const symbol = checker.getSymbolAtLocation(unwrapped);
  return symbol === undefined ? null : processStreamBindings.get(symbol) ?? null;
}

function isProcessOutputMethod(method, argumentCount) {
  return method === "write" || (method === "end" && argumentCount > 0);
}

function directConsoleMethod(node) {
  const callee = unwrapExpression(node.expression);
  if (ts.isPropertyAccessExpression(callee)
    && isDirectConsoleObject(callee.expression)) {
    return callee.name.text;
  }
  if (ts.isElementAccessExpression(callee)
    && isDirectConsoleObject(callee.expression)
    && callee.argumentExpression !== undefined
    && ts.isStringLiteralLike(unwrapExpression(callee.argumentExpression))) {
    return unwrapExpression(callee.argumentExpression).text;
  }
  return null;
}

function isDirectConsoleObject(node) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return expression.text === "console";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "console" && isGlobalObject(expression.expression);
  }
  if (!ts.isElementAccessExpression(expression) || expression.argumentExpression === undefined) {
    return false;
  }
  const argument = unwrapExpression(expression.argumentExpression);
  return ts.isStringLiteralLike(argument)
    && argument.text === "console"
    && isGlobalObject(expression.expression);
}

function isApprovedRendererWrite(argument, stream, checker, rendererBindings) {
  if (argument === undefined) {
    return false;
  }
  const expression = unwrapExpression(argument);
  if (!ts.isCallExpression(expression)) {
    return false;
  }
  const callee = unwrapExpression(expression.expression);
  let bindingNode;
  let namespaceHelper = null;
  if (ts.isIdentifier(callee)) {
    bindingNode = callee;
  } else if (ts.isPropertyAccessExpression(callee)) {
    bindingNode = unwrapExpression(callee.expression);
    namespaceHelper = callee.name.text;
  } else if (ts.isElementAccessExpression(callee) && callee.argumentExpression !== undefined) {
    const helper = unwrapExpression(callee.argumentExpression);
    if (!ts.isStringLiteralLike(helper)) {
      return false;
    }
    bindingNode = unwrapExpression(callee.expression);
    namespaceHelper = helper.text;
  } else {
    return false;
  }
  if (!ts.isIdentifier(bindingNode)) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(bindingNode);
  const binding = symbol === undefined ? undefined : rendererBindings.get(symbol);
  if (binding === undefined) {
    return false;
  }
  const helper = namespaceHelper ?? binding.importedName;
  if ((namespaceHelper === null) !== (binding.importedName !== null)) {
    return false;
  }
  return stream === "stdout"
    ? helper === "renderJson" && binding.specifier.endsWith("/renderers/json.js")
    : binding.specifier.includes("/renderers/");
}

function collectGuardedBindingNames(pattern, checker, processMembers, processStreamBindings) {
  for (const element of pattern.elements) {
    if (element.isTypeOnly) {
      continue;
    }
    const name = propertyNameText(element.propertyName ?? element.name);
    if (name !== null && GUARDED_PROCESS_MEMBERS.has(name)) {
      processMembers.add(name);
      if (ts.isIdentifier(element.name)) {
        setStreamBinding(element.name, name, checker, processStreamBindings);
      }
    }
  }
}

function collectGuardedAssignmentNames(pattern, checker, processMembers, processStreamBindings) {
  for (const property of pattern.properties) {
    if (ts.isShorthandPropertyAssignment(property) && GUARDED_PROCESS_MEMBERS.has(property.name.text)) {
      processMembers.add(property.name.text);
      const symbol = checker.getShorthandAssignmentValueSymbol(property)
        ?? checker.getSymbolAtLocation(property.name);
      if (symbol !== undefined) {
        processStreamBindings.set(symbol, property.name.text);
      }
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const key = propertyNameText(property.name);
    const target = unwrapExpression(property.initializer);
    if (key !== null
      && GUARDED_PROCESS_MEMBERS.has(key)
      && ts.isIdentifier(target)) {
      processMembers.add(key);
      setStreamBinding(target, key, checker, processStreamBindings);
    }
  }
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  if (!ts.isComputedPropertyName(name)) {
    return null;
  }
  const expression = unwrapExpression(name.expression);
  return ts.isStringLiteralLike(expression) ? expression.text : null;
}

function addProcessObjectBinding(identifier, checker, processObjectBindings) {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (symbol !== undefined) {
    processObjectBindings.add(symbol);
  }
}

function setStreamBinding(identifier, stream, checker, processStreamBindings) {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (symbol !== undefined) {
    processStreamBindings.set(symbol, stream);
  }
}

function createTypeChecker(filePath, sourceFile) {
  const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.fileExists = (candidate) => path.resolve(candidate) === path.resolve(filePath);
  host.getSourceFile = (candidate) => path.resolve(candidate) === path.resolve(filePath) ? sourceFile : undefined;
  host.readFile = (candidate) => path.resolve(candidate) === path.resolve(filePath) ? sourceFile.text : undefined;
  return ts.createProgram([filePath], options, host).getTypeChecker();
}

function isDirectProcessLoader(node) {
  if (!ts.isCallExpression(node) || node.arguments.length < 1) {
    return false;
  }
  const argument = unwrapExpression(node.arguments[0]);
  if (!ts.isStringLiteralLike(argument)) {
    return false;
  }
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(node.expression)
    && node.expression.text === "require";
  return (isDynamicImport || isRequire) && isNodeProcessSpecifier(argument.text);
}

function isGlobalObject(node) {
  const expression = unwrapExpression(node);
  return ts.isIdentifier(expression)
    && (expression.text === "global" || expression.text === "globalThis");
}

function isNodeProcessSpecifier(specifier) {
  return specifier === "node:process" || specifier === "process";
}

function isRendererSpecifier(specifier) {
  return /^\.\/renderers\/[^/]+\.js$/.test(specifier);
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
    const resolved = resolveSourceSpecifier(filePath, specifier, sourceFileSet);
    if (resolved !== null) {
      imports.push(toRepoRelative(repoRoot, resolved));
    }
  }
  return [...new Set(imports)].sort();
}

function resolveSourceSpecifier(filePath, specifier, sourceFileSet) {
  const resolved = path.resolve(path.dirname(filePath), specifier);
  const candidates = resolved.endsWith(".js")
    ? [`${resolved.slice(0, -3)}.ts`, resolved]
    : [resolved, `${resolved}.ts`, path.join(resolved, "index.ts")];
  return candidates.find((candidate) => sourceFileSet.has(candidate)) ?? null;
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

function defaultIo() {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text)
  };
}

function rootFromArgs(argv) {
  if (argv.length === 0) {
    return defaultRepoRoot;
  }
  if (argv.length === 2 && argv[0] === "--root" && argv[1] !== "") {
    return path.resolve(argv[1]);
  }
  throw new Error("Usage: node scripts/check-architecture.mjs [--root <repository>]");
}

function toRepoRelative(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = await runArchitectureCheck(rootFromArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
