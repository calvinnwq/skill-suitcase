import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { test } from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parse as parseHtml, parseFragment } from "parse5";
import { parse as parseCss } from "postcss";
import ts from "typescript";
import { parse as parseShell } from "unbash";
import type { Command, Script, Word } from "unbash";
import { parse as parseYaml } from "yaml";

import { createCommandRegistry, parseCommandArgs } from "../src/commands/index.js";

const PUBLIC_DOC_ROOTS = ["docs", "skills", "examples"];
const TEXT_DOCUMENT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".md", ".txt", ".yaml", ".yml"]);
const COMMAND_VALUE_KEYS = new Set(["command", "commands", "example", "examples", "run", "runs", "script", "scripts"]);
const COMMAND_REGISTRY = createCommandRegistry();
const PUBLIC_COMMANDS: ReadonlySet<string> = new Set(COMMAND_REGISTRY.names());
const OPTIONAL_INVOCATION_PLACEHOLDERS = new Set(["<local-overrides>"]);
const POWERSHELL_CALL_WRAPPER = "__powershell_call__";
const EXECUTION_WRAPPERS = new Set([
  "and",
  "command",
  "env",
  "exec",
  "nice",
  "nocorrect",
  "noglob",
  "nohup",
  "not",
  "or",
  "sudo",
  "timeout",
  "time",
  "xargs"
]);
const SHELL_EXECUTORS = new Set([
  "bash",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "zsh"
]);
const NODE_VALUE_OPTIONS = new Set([
  "-C",
  "-r",
  "--conditions",
  "--diagnostic-dir",
  "--import",
  "--loader",
  "--openssl-config",
  "--redirect-warnings",
  "--require",
  "--trace-event-categories"
]);

interface CommandExample {
  block: boolean;
  contents: string;
  language?: string;
}

type ShellDialect = "fish" | "posix" | "powershell";

interface MarkdownNode {
  children?: MarkdownNode[];
  lang?: string | null;
  type: string;
  value?: string;
}

interface HtmlAttribute {
  name: string;
  value: string;
}

interface HtmlNode {
  attrs?: HtmlAttribute[];
  childNodes?: HtmlNode[];
  data?: string;
  nodeName: string;
  tagName?: string;
  value?: string;
}

function publicDocumentPaths(): string[] {
  const paths = readdirSync(".", { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name);

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && TEXT_DOCUMENT_EXTENSIONS.has(extname(entry.name))) {
        paths.push(path);
      }
    }
  }

  for (const root of PUBLIC_DOC_ROOTS) visit(root);
  return paths.sort();
}

function hasCliReference(contents: string): boolean {
  return /(?:skill-suitcase|\$\{?CLI\}?|dist[\\/]src[\\/]cli\.js)/i.test(contents);
}

function htmlText(node: HtmlNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(htmlText).join("");
}

function htmlCommandExamples(contents: string, fragment = false): CommandExample[] {
  const root = (fragment ? parseFragment(contents) : parseHtml(contents)) as unknown as HtmlNode;
  const examples: CommandExample[] = [];

  function visit(node: HtmlNode, insidePre: boolean, inheritedLanguage?: string): void {
    const tagName = node.tagName?.toLowerCase();
    const classes = node.attrs?.find((attribute) => attribute.name === "class")?.value.split(/\s+/) ?? [];
    const cmdline = classes.includes("cmdline");
    const code = tagName === "code";
    const languageClass = classes.find((className) => className.startsWith("language-"));
    const language = languageClass?.slice("language-".length).toLowerCase() ?? inheritedLanguage;

    if (cmdline || code) {
      const text = htmlText(node);
      if (hasCliReference(text)) {
        examples.push({
          block: cmdline || insidePre,
          contents: text,
          ...(language === undefined ? {} : { language })
        });
      }
      if (cmdline) return;
    }

    for (const child of node.childNodes ?? []) visit(child, insidePre || tagName === "pre", language);
  }

  visit(root, false);
  return examples;
}

function markdownCommandExamples(contents: string): CommandExample[] {
  const root = fromMarkdown(contents) as unknown as MarkdownNode;
  const examples: CommandExample[] = [];

  function visit(node: MarkdownNode): void {
    if ((node.type === "code" || node.type === "inlineCode") && node.value !== undefined && hasCliReference(node.value)) {
      const language = node.lang?.toLowerCase();
      examples.push({
        block: node.type === "code",
        contents: node.value,
        ...(language === undefined ? {} : { language })
      });
    }
    if (node.type === "html" && node.value !== undefined && hasCliReference(node.value)) {
      examples.push(...htmlCommandExamples(node.value, true));
    }
    for (const child of node.children ?? []) visit(child);
  }

  visit(root);
  examples.push(...htmlCommandExamples(contents, true));
  return examples;
}

function structuredCommandExamples(value: unknown, ownerKey?: string, seen = new Set<object>()): CommandExample[] {
  if (typeof value === "string") {
    return ownerKey !== undefined && COMMAND_VALUE_KEYS.has(ownerKey.toLowerCase()) && hasCliReference(value)
      ? [{ block: true, contents: value }]
      : [];
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) => structuredCommandExamples(item, ownerKey, seen));
  }

  return Object.entries(value).flatMap(([key, item]) => structuredCommandExamples(item, key, seen));
}

function textCommandExamples(contents: string): CommandExample[] {
  if (!hasCliReference(contents)) return [];
  return [{ block: true, contents }];
}

function javascriptCommandExamples(path: string, contents: string): CommandExample[] {
  const sourceFile = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true);
  const examples = new Set<string>();

  function collectStrings(node: ts.Expression): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (hasCliReference(node.text)) examples.add(node.text);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) collectStrings(element);
    }
  }

  function propertyName(node: ts.PropertyName | ts.BindingName): string | null {
    return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text.toLowerCase() : null;
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const name = propertyName(node.name);
      if (name !== null && COMMAND_VALUE_KEYS.has(name)) collectStrings(node.initializer);
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name !== null && COMMAND_VALUE_KEYS.has(name)) collectStrings(node.initializer);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...examples].map((example) => ({ block: true, contents: example }));
}

function cssCommandExamples(contents: string): CommandExample[] {
  const examples: CommandExample[] = [];
  parseCss(contents).walkDecls((declaration) => {
    const name = declaration.prop.replace(/^--/, "").toLowerCase();
    if (!COMMAND_VALUE_KEYS.has(name)) return;
    const value = declaration.value.trim();
    const unquoted = value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "\"" || value[0] === "'")
      ? value.slice(1, -1)
      : value;
    if (hasCliReference(unquoted)) examples.push({ block: true, contents: unquoted });
  });
  return examples;
}

function commandExamples(path: string, contents: string): CommandExample[] {
  switch (extname(path)) {
    case ".css":
      return cssCommandExamples(contents);
    case ".md":
      return markdownCommandExamples(contents);
    case ".html":
      return htmlCommandExamples(contents);
    case ".js":
      return javascriptCommandExamples(path, contents);
    case ".json":
      return structuredCommandExamples(JSON.parse(contents) as unknown);
    case ".yaml":
    case ".yml":
      return structuredCommandExamples(parseYaml(contents) as unknown);
    case ".txt":
      return textCommandExamples(contents);
    default:
      return [];
  }
}

function normalizeInteractiveSource(contents: string): string {
  return contents
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s*\$\s+(?=\S)/, "")
      .replace(/^\s*[^\s@]+@[^\s:]+:[^$]*\$\s+/, ""))
    .join("\n");
}

function shellDialect(language?: string): ShellDialect {
  if (language === "powershell" || language === "ps1" || language === "pwsh") return "powershell";
  return language === "fish" ? "fish" : "posix";
}

function powershellLineState(
  line: string,
  initialQuote: "\"" | "'" | null
): { continuation: boolean; quote: "\"" | "'" | null } {
  let quote = initialQuote;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quote === "'") {
      if (character !== "'") continue;
      if (line[index + 1] === "'") index += 1;
      else quote = null;
      continue;
    }
    if (character === "`") {
      if (index === line.length - 1) return { continuation: true, quote };
      index += 1;
      continue;
    }
    if (quote === "\"") {
      if (character === "\"") quote = null;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) break;
    if (character === "\"" || character === "'") quote = character;
  }
  return { continuation: false, quote };
}

function normalizePowershellHereStrings(contents: string): string {
  const lines = contents.split(/\r?\n/);
  const normalized: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const opening = line.match(/@(["'])\s*$/);
    if (opening === null || opening.index === undefined) {
      normalized.push(line);
      continue;
    }

    const quote = opening[1] ?? "";
    const body: string[] = [];
    let closingIndex = index + 1;
    for (; closingIndex < lines.length; closingIndex += 1) {
      const bodyLine = lines[closingIndex] ?? "";
      if (bodyLine.trim() === `${quote}@`) break;
      body.push(bodyLine);
    }
    assert.ok(closingIndex < lines.length, `PowerShell here-string requires delimiter: ${quote}@`);
    const value = quote === "\"" ? JSON.stringify(body.join("\n")) : "''";
    normalized.push(`${line.slice(0, opening.index)}${value}`);
    index = closingIndex;
  }

  return normalized.join("\n");
}

function normalizePowershellStatement(statement: string): string {
  const assignment = statement.match(/^(\s*)\$([A-Za-z_][A-Za-z0-9_:]*)\s*=\s*(.+)$/s);
  const assignedVariable = assignment?.[2]?.split(":").at(-1)?.toLowerCase();
  const command = assignment !== null && assignedVariable !== "cli" && hasCliReference(assignment[3] ?? "")
    ? `${assignment[1] ?? ""}${assignment[3] ?? ""}`
    : statement;
  return command.replace(
    /^(\s*)&\s+(?=(?:[A-Za-z]:[\\/]|\.?[\\/]|"\$\{?CLI\}?"|\$\{?CLI\}?|skill-suitcase))/i,
    `$1${POWERSHELL_CALL_WRAPPER} `
  );
}

function normalizePowershellStatements(line: string): string {
  const normalized: string[] = [];
  let quote: "\"" | "'" | null = null;
  let statementStart = 0;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quote === "'") {
      if (character !== "'") continue;
      if (line[index + 1] === "'") index += 1;
      else quote = null;
      continue;
    }
    if (character === "`") {
      index += 1;
      continue;
    }
    if (quote === "\"") {
      if (character === "\"") quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }

    const separator = line.startsWith("&&", index) || line.startsWith("||", index)
      ? line.slice(index, index + 2)
      : character === ";" || character === "|"
        ? character
        : null;
    if (separator === null) continue;
    normalized.push(normalizePowershellStatement(line.slice(statementStart, index)), separator);
    index += separator.length - 1;
    statementStart = index + 1;
  }

  normalized.push(normalizePowershellStatement(line.slice(statementStart)));
  return normalized.join("");
}

function normalizePowershellSource(contents: string): string {
  const logicalLines: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  const normalizedContents = normalizePowershellHereStrings(
    normalizeInteractiveSource(contents)
      .split(/\r?\n/)
      .map((line) => line.replace(
        /^\s*PS(?:>|\s+(?=[^>\r\n]*(?:[\\/]|[A-Za-z]:|~))[^>\r\n]+>)\s+/i,
        ""
      ))
      .join("\n")
      .replaceAll("\\", "/")
  );

  for (const sourceLine of normalizedContents.split(/\r?\n/)) {
    const state = powershellLineState(sourceLine, quote);
    current += state.continuation ? `${sourceLine.slice(0, -1)} ` : sourceLine;
    quote = state.quote;
    if (state.continuation || quote !== null) {
      if (!state.continuation) current += "\n";
      continue;
    }
    logicalLines.push(current);
    current = "";
  }
  if (current.length > 0) logicalLines.push(current);

  return logicalLines
    .map(normalizePowershellStatements)
    .join("\n")
    .replace(/`(.)/gs, "\\$1");
}

function normalizeFishSource(contents: string): string {
  return normalizeInteractiveSource(contents)
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^(\s*)(?:begin|else|end)(?=\s*(?:;|$))/, "$1true")
      .replace(/^(\s*)(?:if|while)\s+/, "$1")
      .replace(/^(\s*)for\s+[^;]+(?:;|$)/, "$1true;"))
    .join("\n")
    .replace(/;\s*end(?=\s*(?:;|$))/g, "; true");
}

function sanitizeShellSource(example: CommandExample): string {
  const dialect = shellDialect(example.language);
  const source = dialect === "powershell"
    ? normalizePowershellSource(example.contents)
    : dialect === "fish"
      ? normalizeFishSource(example.contents)
      : normalizeInteractiveSource(example.contents);
  return source
    .replace(/[\u00a0\u2000-\u200b\u2028\u2029\u202f\u205f\u3000]/g, " ")
    .replace(/<([A-Za-z][^>\s]*)>/g, (placeholder) =>
      OPTIONAL_INVOCATION_PLACEHOLDERS.has(placeholder) ? " ".repeat(placeholder.length) : "x".repeat(placeholder.length)
    );
}

function executableName(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return (normalized.slice(normalized.lastIndexOf("/") + 1) || normalized).toLowerCase();
}

function isCliExecutable(value: string): boolean {
  const executable = executableName(value).replace(/\.(?:cmd|exe|ps1)$/i, "");
  const normalized = value.toLowerCase();
  return executable === "skill-suitcase" || normalized === "$cli" || normalized === "${cli}";
}

function isSourceEntrypoint(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  const lower = value.toLowerCase();
  return lower === "$cli" || lower === "${cli}" || /(?:^|\/)dist\/src\/cli\.js$/.test(normalized);
}

function nodeEntrypointIndex(words: Word[]): number | null {
  for (let index = 1; index < words.length; index += 1) {
    const token = words[index]?.value ?? "";
    if (token === "--") return index + 1 < words.length ? index + 1 : null;
    if (token.startsWith("--") && token.includes("=")) {
      const option = token.slice(0, token.indexOf("="));
      if (!NODE_VALUE_OPTIONS.has(option)) return null;
      continue;
    }
    if (NODE_VALUE_OPTIONS.has(token)) {
      if (index + 1 >= words.length) return null;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return null;
    return index;
  }
  return null;
}

function packageRunnerInvocation(words: Word[]): string[] | null {
  const executable = executableName(words[0]?.value ?? "");
  const values = words.map((word) => word.value);

  function commandIndex(start: number): number | null {
    for (let index = start; index < values.length; index += 1) {
      const token = values[index] ?? "";
      if (token === "--") return index + 1 < values.length ? index + 1 : null;
      if (token === "-p" || token === "--package") {
        index += 1;
        continue;
      }
      if (token.startsWith("-")) continue;
      return index;
    }
    return null;
  }

  if (executable === "npm") {
    const execIndex = values.findIndex((value) => value === "exec" || value === "x");
    const separator = values.indexOf("--", execIndex + 1);
    if (execIndex < 0 || separator < 0) return null;
    const launcher = separator + 1;
    return isCliExecutable(values[launcher] ?? "") ? values.slice(launcher + 1) : null;
  }

  if (executable === "npx") {
    const launcher = commandIndex(1);
    return launcher !== null && isCliExecutable(values[launcher] ?? "") ? values.slice(launcher + 1) : null;
  }

  if (executable === "pnpm" || executable === "yarn") {
    const action = values.findIndex((value) => value === "dlx" || value === "exec");
    const launcher = action < 0 ? null : commandIndex(action + 1);
    return launcher !== null && isCliExecutable(values[launcher] ?? "") ? values.slice(launcher + 1) : null;
  }

  return null;
}

function invocationFromWords(
  words: Word[],
  dialect: ShellDialect,
  powershellVariableCall = false
): string[] | null {
  const first = words[0]?.value;
  if (first === undefined) return null;
  if (isCliExecutable(first)) {
    const variableLauncher = /^\$\{?CLI\}?$/i.test(first);
    if (dialect === "powershell" && variableLauncher && !powershellVariableCall) {
      if (words[1]?.value === "=" || words.length === 1) return null;
      assert.fail("PowerShell variable CLI launchers require the call operator: & $CLI");
    }
    return words.slice(1).map((word) => word.value);
  }

  const executable = executableName(first);
  if (executable === POWERSHELL_CALL_WRAPPER) {
    return invocationFromWords(words.slice(1), dialect, true);
  }
  if (executable === "node" || executable === "node.exe") {
    const entrypoint = nodeEntrypointIndex(words);
    return entrypoint !== null && isSourceEntrypoint(words[entrypoint]?.value ?? "")
      ? words.slice(entrypoint + 1).map((word) => word.value)
      : null;
  }

  const packageInvocation = packageRunnerInvocation(words);
  if (packageInvocation !== null) return packageInvocation;

  if (!EXECUTION_WRAPPERS.has(executable)) return null;
  if (executable === "command" && words.some((word) => word.value === "-v" || word.value === "-V")) return null;
  if (executable === "sudo" && words.some((word) => word.value === "-e" || word.value === "--edit")) return null;

  for (let index = 1; index < words.length; index += 1) {
    const invocation = invocationFromWords(words.slice(index), dialect, dialect === "powershell");
    if (invocation !== null) return invocation;
  }
  return null;
}

function nestedCommandExample(command: Command, inheritedLanguage?: string): CommandExample | null {
  const name = executableName(command.name?.value ?? "");
  const words = command.suffix;

  if (SHELL_EXECUTORS.has(name)) {
    const powershell = name === "powershell" || name === "powershell.exe" || name === "pwsh" || name === "pwsh.exe";
    const option = words.findIndex((word) => powershell
      ? /^-(?:c|command)$/i.test(word.value)
      : /^-[a-z]*c[a-z]*$/i.test(word.value));
    const contents = option >= 0 ? words[option + 1]?.value : undefined;
    if (contents === undefined) return null;
    const language = name === "fish"
      ? "fish"
      : powershell
        ? "powershell"
        : "sh";
    return { block: true, contents, language };
  }

  if (name === "cmd" || name === "cmd.exe") {
    const option = words.findIndex((word) => /(?:^|\/)c$/i.test(word.value));
    return option >= 0
      ? { block: true, contents: words.slice(option + 1).map((word) => word.value).join(" ") }
      : null;
  }

  if (name === "env") {
    const option = words.findIndex((word) => word.value === "-S" || word.value === "--split-string");
    const contents = option >= 0 ? words[option + 1]?.value : undefined;
    return contents === undefined
      ? null
      : { block: true, contents, ...(inheritedLanguage === undefined ? {} : { language: inheritedLanguage }) };
  }

  return null;
}

function commandWords(command: Command): Word[] {
  return command.name === undefined ? [] : [command.name, ...command.suffix];
}

function collectCommands(value: unknown, commands: Command[], seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if ((value as { type?: string }).type === "Command") commands.push(value as Command);
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) collectCommands(child, commands, seen);
  }
}

function parseCommandExample(path: string, example: CommandExample): Command[] {
  const source = sanitizeShellSource(example);
  const ast: Script & { errors?: Array<{ message: string; pos: number }> } = parseShell(source);
  assert.deepEqual(ast.errors ?? [], [], `${path} has invalid or unsupported shell syntax`);
  const commands: Command[] = [];
  collectCommands(JSON.parse(JSON.stringify(ast)) as unknown, commands);
  return commands;
}

function validateInvocation(path: string, invocation: string[]): void {
  const normalized = invocation.filter((token) => !OPTIONAL_INVOCATION_PLACEHOLDERS.has(token));
  const command = normalized[0] ?? "";
  const rendered = ["skill-suitcase", ...normalized].join(" ");
  assert.ok(PUBLIC_COMMANDS.has(command), `${path} documents unknown command: ${command}`);
  assert.ok(normalized.includes("--json"), `${path} has a CLI example without --json: ${rendered}`);

  let parsed: ReturnType<typeof parseCommandArgs>;
  try {
    parsed = parseCommandArgs(normalized);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`${path} has an invalid CLI invocation: ${rendered} (${message})`);
  }

  assert.ok(COMMAND_REGISTRY.find(parsed) !== null, `${path} CLI does not accept invocation: ${rendered}`);
  assert.ok(
    parsed.command !== "pack" || !parsed.dryRun || parsed.output === undefined,
    `${path} CLI invocation cannot produce deterministic JSON: ${rendered}`
  );
}

function validateCommandExample(path: string, example: CommandExample): number {
  const commands = parseCommandExample(path, example);
  const dialect = shellDialect(example.language);
  let invocationCount = 0;

  for (const command of commands) {
    const nested = nestedCommandExample(command, example.language);
    if (nested !== null && hasCliReference(nested.contents)) {
      invocationCount += validateCommandExample(path, nested);
    }

    const words = commandWords(command);
    const invocation = invocationFromWords(words, dialect);
    if (invocation !== null) {
      if (!example.block && invocation.length === 0) continue;
      validateInvocation(path, invocation);
      invocationCount += 1;
      continue;
    }

    const executable = executableName(words[0]?.value ?? "");
    const values = words.map((word) => word.value);
    const npmExec = executable === "npm" && values.some((value) => value === "exec" || value === "x");
    assert.ok(
      !npmExec || !values.some(isCliExecutable),
      `${path} npm exec CLI examples must use -- before skill-suitcase`
    );
    const unsupportedNodeLaunch = (executable === "node" || executable === "node.exe")
      && words.some((word) => hasCliReference(word.value));
    assert.ok(!unsupportedNodeLaunch, `${path} has an unsupported Node CLI launch form`);
  }

  return invocationCount;
}

function validateCliExamples(path: string, contents: string): number {
  return commandExamples(path, contents)
    .reduce((count, example) => count + validateCommandExample(path, example), 0);
}

function decodedDocumentText(contents: string): string {
  const root = parseFragment(contents) as unknown as HtmlNode;
  const values: string[] = [];

  function visit(node: HtmlNode): void {
    if (node.nodeName === "#text") values.push(node.value ?? "");
    if (node.nodeName === "#comment") values.push(node.data ?? "");
    for (const attribute of node.attrs ?? []) values.push(attribute.value);
    for (const child of node.childNodes ?? []) visit(child);
  }

  visit(root);
  return values.join("\n");
}

function assertNoPrivateMachinePaths(path: string, contents: string): void {
  const normalizedContents = decodedDocumentText(contents).replace(/\\{2,}/g, "\\").replaceAll("\\/", "/");
  const localPathContents = normalizedContents.replace(/\bhttps?:\/\/[^\s`"'<>]+/gi, "");
  assert.doesNotMatch(localPathContents, /\/Users\/[^/\\\s`"']+/, `${path} contains a macOS user path`);
  assert.doesNotMatch(localPathContents, /\/home\/[^/\\\s`"']+/, `${path} contains a Linux user path`);
  assert.doesNotMatch(
    localPathContents,
    /(?:^|[^A-Za-z0-9._~/-])\/root(?=[^A-Za-z0-9_-]|$)/m,
    `${path} contains a Linux root user path`
  );
  assert.doesNotMatch(
    localPathContents,
    /(?:^|[^A-Za-z0-9._~/-])\/(?:mnt\/)?[A-Z]\/Users\/[^/\\\s`"']+/im,
    `${path} contains a Windows user path`
  );
  assert.doesNotMatch(localPathContents, /[A-Z]:[\\/]Users[\\/][^\\/\s`"']+/i, `${path} contains a Windows user path`);
  assert.doesNotMatch(
    localPathContents,
    /(?:^|[^A-Za-z0-9._~/-])~[A-Za-z_][A-Za-z0-9_-]*(?=[\\/\s`"'.,;:)}\]]|$)/m,
    `${path} contains a named Unix user path`
  );
  assert.doesNotMatch(
    localPathContents,
    /(?:^|[^A-Za-z0-9._~/-])[\\/][^\\/\s`"']+[\\/]Users[\\/][^\\/\s`"']+/i,
    `${path} contains a Windows UNC user path`
  );
}

function markdownFixture(source: string, language = "sh"): string {
  return `\`\`\`${language}\n${source}\n\`\`\``;
}

test("public and reusable docs contain no contributor-specific machine paths", () => {
  const documents = publicDocumentPaths();
  assert.ok(documents.length > 0, "public documentation inventory must not be empty");
  for (const path of documents) assertNoPrivateMachinePaths(path, readFileSync(path, "utf8"));
});

test("private machine path checks cover portable and private forms", () => {
  for (const privatePath of [
    "`/Users/alice`",
    "`/home/alice`",
    "Use /root.",
    "C:/Users/alice/project",
    "C:\\Users\\alice",
    "/mnt/c/Users/alice/project",
    "/c/Users/alice/project",
    "~alice/project",
    String.raw`\\server\Users\alice\project`,
    String.raw`C:&#92;Users&#92;alice&#92;project`,
    String.raw`C:&bsol;Users&bsol;alice&bsol;project`,
    "<!-- /Users/alice/project -->"
  ]) {
    assert.throws(() => assertNoPrivateMachinePaths("fixture.md", privatePath), /contains a .* user path/);
  }

  assert.doesNotThrow(() => assertNoPrivateMachinePaths(
    "fixture.md",
    "See ~/project, $HOME/project, /target/root/project, https://docs.example.com/home/alice/setup, and https://docs.example.com/root/project."
  ));
});

test("literal public CLI examples use shipped commands and deterministic JSON output", () => {
  let invocationCount = 0;
  for (const path of publicDocumentPaths()) invocationCount += validateCliExamples(path, readFileSync(path, "utf8"));
  assert.ok(invocationCount > 0, "public documentation must contain checked CLI examples");
});

test("structured parsers extract Markdown, HTML, YAML, JSON, and text examples", () => {
  const invalidFixtures = [
    ["fixture.md", "~~~bash\nskill-suitcase bogus --json\n~~~"],
    ["fixture.md", "> ```console\n> $ skill-suitcase bogus --json\n> ```"],
    ["fixture.md", "Run `skill-suitcase bogus --json` now."],
    ["fixture.md", "    skill-suitcase bogus --json"],
    ["fixture.md", "<code>skill-suitcase&#32;bogus --json</code>"],
    ["fixture.html", "<pre><code>skill-suitcase&nbsp;bogus --json</code></pre>"],
    ["fixture.html", "<span class=\"cmdline\">skill-suitcase bogus --json</span>"],
    ["fixture.yaml", "command: skill-suitcase bogus --json"],
    ["fixture.yaml", "commands:\n  - skill-suitcase bogus --json"],
    ["fixture.json", "{\"commands\":[\"skill-suitcase bogus --json\"]}"],
    ["fixture.js", "const commands = ['echo ok', 'skill-suitcase bogus --json'];"],
    ["fixture.css", ":root { --example: 'skill-suitcase bogus --json'; }"],
    ["fixture.txt", "skill-suitcase bogus --json"]
  ] as const;
  for (const [path, contents] of invalidFixtures) {
    assert.throws(() => validateCliExamples(path, contents), /unknown command: bogus/, `${path}: ${contents}`);
  }

  assert.equal(validateCliExamples("fixture.md", "The `skill-suitcase` binary reads `skill-suitcase.yaml`."), 0);
  assert.equal(validateCliExamples("fixture.yaml", "description: Run skill-suitcase bogus --json"), 0);
  assert.equal(validateCliExamples("fixture.json", "{\"description\":\"Run skill-suitcase bogus --json\"}"), 0);
  assert.equal(validateCliExamples("fixture.js", "const description = 'Run skill-suitcase bogus --json';"), 0);
  assert.equal(validateCliExamples("fixture.css", ":root { --description: 'Run skill-suitcase bogus --json'; }"), 0);
  assert.equal(validateCliExamples("fixture.yaml", "command: >\n  skill-suitcase status --source .\n  --json"), 1);
});

test("Bash AST traversal validates controls, substitutions, pipelines, and redirections", () => {
  const invalidExamples = [
    "skill-suitcase status --source . --json | skill-suitcase bogus --json",
    "if skill-suitcase bogus --json; then exit 1; fi",
    "RESULT=$(skill-suitcase bogus --json)",
    "RESULT=`skill-suitcase bogus --json`",
    "(skill-suitcase bogus --json)",
    "skill-suitcase bogus --json > result.json",
    "skill-suitcase status --source <(skill-suitcase bogus --json) --json",
    "cat <<EOF\n$(skill-suitcase bogus --json)\nEOF"
  ];
  for (const source of invalidExamples) {
    assert.throws(
      () => validateCliExamples("fixture.md", markdownFixture(source)),
      /unknown command: bogus/,
      source
    );
  }

  const validExamples = [
    "skill-suitcase status --source . --json > result.json",
    "skill-suitcase status --source \"$(pwd)\" --json",
    "skill-suitcase status --source <(make-catalog) --json",
    "cat <<'EOF'\n$(skill-suitcase bogus --json)\nEOF\nskill-suitcase status --source . --json"
  ];
  for (const source of validExamples) {
    assert.equal(validateCliExamples("fixture.md", markdownFixture(source)), 1);
  }
  assert.equal(validateCliExamples("fixture.md", markdownFixture("ps aux > skill-suitcase")), 0);
});

test("launcher normalization covers wrappers, runners, paths, and command strings", () => {
  const invalidLaunchers = [
    "env -i skill-suitcase bogus --json",
    "sudo -E command -- skill-suitcase bogus --json",
    "nohup skill-suitcase bogus --json",
    "nice -n 5 skill-suitcase bogus --json",
    "timeout -sTERM 30 skill-suitcase bogus --json",
    "xargs -n1 skill-suitcase bogus --json",
    "/usr/local/bin/skill-suitcase bogus --json",
    "node dist/src/cli.js bogus --json",
    "\"$CLI\" bogus --json",
    "npx skill-suitcase bogus --json",
    "npm exec --package=skill-suitcase -- skill-suitcase bogus --json",
    "pnpm dlx skill-suitcase bogus --json",
    "sh -c 'skill-suitcase bogus --json'",
    "cmd /c skill-suitcase bogus --json",
    "not skill-suitcase bogus --json"
  ];
  for (const source of invalidLaunchers) {
    assert.throws(
      () => validateCliExamples("fixture.md", markdownFixture(source)),
      /unknown command: bogus/,
      source
    );
  }

  assert.equal(validateCliExamples("fixture.md", markdownFixture("node \"$CLI\" status --source . --json")), 1);
  for (const source of [
    "node --check dist/src/cli.js status --source . --json",
    "node -e dist/src/cli.js status --source . --json",
    "node --eval=dist/src/cli.js status --source . --json"
  ]) {
    assert.throws(
      () => validateCliExamples("fixture.md", markdownFixture(source)),
      /unsupported Node CLI launch form/,
      source
    );
  }
  assert.equal(validateCliExamples("fixture.md", markdownFixture("npm exec -- skill-suitcase status --source . --json")), 1);
  assert.equal(validateCliExamples("fixture.md", markdownFixture("npx cowsay -- skill-suitcase bogus --json")), 0);
  assert.equal(validateCliExamples("fixture.md", markdownFixture("command -v skill-suitcase || true")), 0);
  assert.equal(validateCliExamples("fixture.md", markdownFixture("printf '%s\\n' 'skill-suitcase bogus --json'")), 0);
  assert.throws(
    () => validateCliExamples("fixture.md", markdownFixture("npm exec skill-suitcase bogus --json")),
    /must use -- before skill-suitcase/
  );
});

test("CLI validation rejects nondeterministic and unaccepted invocations", () => {
  const failures = [
    ["skill-suitcase bogus --json", /unknown command: bogus/],
    ["skill-suitcase upstream bogus --json", /invalid CLI invocation.*Unknown upstream action: bogus/],
    ["skill-suitcase status --source .", /without --json/],
    ["skill-suitcase status --source . --not-a-real-flag --json", /invalid CLI invocation.*Unknown argument/],
    ["skill-suitcase status --json", /CLI does not accept invocation/],
    ["skill-suitcase pack --source . --target codex --dry-run --output out --json", /cannot produce deterministic JSON/]
  ] as const;
  for (const [source, pattern] of failures) {
    assert.throws(() => validateCliExamples("fixture.md", markdownFixture(source)), pattern);
  }

  assert.equal(validateCliExamples("fixture.md", markdownFixture("$CLI status --source . --target <target-id> <local-overrides> --json")), 1);
});

test("dialect normalization validates PowerShell and Fish examples", () => {
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("skill-suitcase status `\n  --source \"C:\\catalog` name\" `\n  --json", "pwsh")
    ),
    1
  );
  for (const source of [
    "PS> skill-suitcase bogus --json",
    String.raw`PS C:\repo> skill-suitcase bogus --json`,
    "$result=skill-suitcase bogus --json",
    String.raw`& C:\tools\Skill-Suitcase.cmd bogus --json`
  ]) {
    assert.throws(
      () => validateCliExamples("fixture.md", markdownFixture(source, "powershell")),
      /unknown command: bogus/,
      source
    );
  }
  for (const source of [
    "not skill-suitcase bogus --json",
    "if not skill-suitcase bogus --json",
    "if test -e catalog; skill-suitcase bogus --json; end"
  ]) {
    assert.throws(
      () => validateCliExamples("fixture.md", markdownFixture(source, "fish")),
      /unknown command: bogus/,
      source
    );
  }
  for (const [source, language] of [
    ["powershell -Command '$result = skill-suitcase bogus --json'", "powershell"],
    ["pwsh.exe -NonInteractive -Command '$result = skill-suitcase bogus --json'", "powershell"],
    ["fish -c 'if not skill-suitcase bogus --json'", "fish"]
  ] as const) {
    assert.throws(
      () => validateCliExamples("fixture.md", markdownFixture(source, language)),
      /unknown command: bogus/,
      source
    );
  }
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("$CLI status --source . --json", "powershell")
    ),
    /PowerShell variable CLI launchers require the call operator/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("Write-Host ready; $CLI status --source . --json", "powershell")
    ),
    /PowerShell variable CLI launchers require the call operator/
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("& $CLI status --source . --json", "powershell")
    ),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture('& "$CLI" status --source . --json', "powershell")
    ),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("$CLI = Resolve-Path ./dist/src/cli.js\n& $CLI status --source . --json", "powershell")
    ),
    1
  );
  assert.equal(
    validateCliExamples("fixture.md", markdownFixture('$CLI = "skill-suitcase"', "powershell")),
    0
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("Write-Host ready; $result = & $CLI status --source . --json", "powershell")
    ),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("sudo $CLI status --source . --json", "powershell")
    ),
    1
  );
  assert.equal(validateCliExamples("fixture.md", markdownFixture("$CLI", "powershell")), 0);
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("$value = @'\nskill-suitcase bogus --json\n'@", "pwsh")
    ),
    0
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("$value = @\"\n$(skill-suitcase bogus --json)\n\"@", "pwsh")
    ),
    /unknown command: bogus/
  );
  for (const source of [
    "noglob skill-suitcase bogus --json",
    "nocorrect skill-suitcase bogus --json"
  ]) {
    assert.throws(
      () => validateCliExamples("fixture.md", markdownFixture(source, "zsh")),
      /unknown command: bogus/,
      source
    );
  }
  assert.equal(
    validateCliExamples(
      "fixture.html",
      '<pre><code class="language-powershell">skill-suitcase status --source . `\n  --json</code></pre>'
    ),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.html",
      '<pre class="language-powershell"><code>skill-suitcase status --source . `\n  --json</code></pre>'
    ),
    1
  );
});
