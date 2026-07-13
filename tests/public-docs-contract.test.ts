import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allowedNodeEnvironmentFlags, execPath } from "node:process";
import { test } from "node:test";

import { createCommandRegistry, parseCommandArgs } from "../src/commands/index.js";

const PUBLIC_DOC_ROOTS = ["docs", "skills", "examples"];
const TEXT_DOCUMENT_EXTENSIONS = [".css", ".html", ".js", ".json", ".md", ".txt", ".yaml", ".yml"];
const REUSABLE_TEXT_COMMAND_EXTENSIONS = [".css", ".js", ".json", ".txt", ".yaml", ".yml"];
const COMMAND_REGISTRY = createCommandRegistry();
const PUBLIC_COMMANDS: ReadonlySet<string> = new Set(COMMAND_REGISTRY.names());
const SHELL_COMMAND_PREFIXES = new Set(["$", "!", "do", "elif", "else", "if", "then", "until", "while", "{"]);
const SHELL_FENCE_LANGUAGES = new Set([
  "",
  "bash",
  "console",
  "fish",
  "powershell",
  "ps1",
  "pwsh",
  "sh",
  "shell",
  "shell-session",
  "shellscript",
  "terminal",
  "zsh"
]);
const SHELL_SUBSTITUTION_PLACEHOLDER = "__shell_command_substitution__";
const OPTIONAL_INVOCATION_PLACEHOLDERS = new Set(["<local-overrides>"]);
const NODE_CLI_VALUE_OPTIONS = nodeCliValueOptions();
type ShellDialect = "posix" | "powershell";

interface CommandExample {
  contents: string;
  dialect: ShellDialect;
  interactive?: boolean;
}

interface ShellToken {
  protected: boolean;
  syntax: string;
  value: string;
}

interface CliLauncher {
  invocation: string[];
}

interface PackageRunnerExecutable {
  executableIndex: number;
  separatorBeforeExecutable: boolean;
}

function nodeCliValueOptions(): ReadonlySet<string> {
  const options = new Set<string>();
  const help = execFileSync(execPath, ["--help"], { encoding: "utf8" });

  for (const line of help.split(/\r?\n/)) {
    if (!/^\s+--?/.test(line) || !line.includes("=...")) continue;
    for (const match of line.matchAll(/(?:^|[,\s])(--?[A-Za-z][A-Za-z0-9-]*)/g)) {
      const option = match[1];
      if (option !== undefined) options.add(option);
    }
  }

  return options;
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
      } else if (entry.isFile() && TEXT_DOCUMENT_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        paths.push(path);
      }
    }
  }

  for (const root of PUBLIC_DOC_ROOTS) visit(root);
  return paths.sort();
}

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function shellDialect(language: string): ShellDialect {
  return language === "powershell" || language === "ps1" || language === "pwsh"
    ? "powershell"
    : "posix";
}

function markdownBlockquoteLine(line: string): { contents: string; depth: number } {
  let contents = line;
  let depth = 0;

  while (true) {
    const prefix = contents.match(/^ {0,3}>[ \t]?/);
    if (prefix === null) return { contents, depth };
    contents = contents.slice(prefix[0].length);
    depth += 1;
  }
}

function stripMarkdownBlockquoteDepth(line: string, depth: number): string | null {
  let contents = line;

  for (let index = 0; index < depth; index += 1) {
    const prefix = contents.match(/^ {0,3}>[ \t]?/);
    if (prefix === null) return null;
    contents = contents.slice(prefix[0].length);
  }

  return contents;
}

function markdownShellBlocks(contents: string): CommandExample[] {
  const blocks: CommandExample[] = [];
  const lines = contents.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const openingLine = markdownBlockquoteLine(lines[index] ?? "");
    const opening = openingLine.contents.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^\r]*)$/);
    if (opening === undefined || opening === null) continue;

    const fence = opening[1] ?? "";
    const info = (opening[2] ?? "").trim();
    const pandocLanguage = info.match(/^\{\.?([A-Za-z0-9_-]+)\}/)?.[1];
    const language = (pandocLanguage ?? info.split(/\s+/, 1)[0] ?? "").toLowerCase();
    const isShellBlock = SHELL_FENCE_LANGUAGES.has(language);
    const dialect = shellDialect(language);

    const blockStart = index + 1;
    let closed = false;
    for (index = blockStart; index < lines.length; index += 1) {
      const blockLine = stripMarkdownBlockquoteDepth(lines[index] ?? "", openingLine.depth);
      const closing = blockLine?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (closing === undefined || closing[0] !== fence[0] || closing.length < fence.length) continue;
      const blockContents = lines
        .slice(blockStart, index)
        .map((line) => stripMarkdownBlockquoteDepth(line, openingLine.depth) ?? line)
        .join("\n");
      const executableContents = isShellBlock
        ? blockContents
        : markdownNonFencedLines(blockContents).join("\n");
      if (isShellBlock || containsCommandShapedInvocation(executableContents, true)) {
        blocks.push({
          contents: executableContents,
          dialect,
          interactive: language === "console" || language === "shell-session" || language === "terminal"
        });
      }
      closed = true;
      break;
    }
    assert.ok(closed, "unterminated Markdown fence");
  }

  return blocks;
}

function markdownNonFencedLines(contents: string): string[] {
  const lines = contents.split(/\r?\n/);
  const visibleLines = lines.map((line) => markdownBlockquoteLine(line).contents);

  for (let index = 0; index < lines.length; index += 1) {
    const openingLine = markdownBlockquoteLine(lines[index] ?? "");
    const opening = openingLine.contents.match(/^ {0,3}(`{3,}|~{3,})[ \t]*[^\r]*$/)?.[1];
    if (opening === undefined) continue;

    visibleLines[index] = "";
    for (index += 1; index < lines.length; index += 1) {
      const blockLine = stripMarkdownBlockquoteDepth(lines[index] ?? "", openingLine.depth);
      const closing = blockLine?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
      visibleLines[index] = "";
      if (closing !== undefined && closing[0] === opening[0] && closing.length >= opening.length) break;
    }
  }

  return visibleLines;
}

function containsCommandShapedInvocation(
  contents: string,
  allowLauncherOnly = false,
  dialect: ShellDialect = "posix"
): boolean {
  return shellSegments(contents, dialect).some((segment) => {
    const tokens = shellInvocationTokens(segment, dialect);
    const launcher = skillSuitcaseLauncher(tokens.map((token) => token.value), dialect);
    return launcher !== null && (allowLauncherOnly || launcher.invocation[1] !== undefined);
  });
}

function markdownIndentedAndInlineCode(contents: string): CommandExample[] {
  const lines = markdownNonFencedLines(contents);
  const examples: CommandExample[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const firstLine = lines[index]?.match(/^(?: {4}|\t)(.*)$/)?.[1];
    if (firstLine === undefined) continue;

    const block = [firstLine];
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1] ?? "";
      const indented = nextLine.match(/^(?: {4}|\t)(.*)$/)?.[1];
      if (indented !== undefined) {
        block.push(indented);
        index += 1;
        continue;
      }
      if (nextLine.trim().length === 0) {
        block.push("");
        index += 1;
        continue;
      }
      break;
    }
    examples.push({ contents: block.join("\n"), dialect: "posix" });
  }

  const inlineSource = lines
    .map((line) => /^(?: {4}|\t)/.test(line) ? "" : line)
    .join("\n");
  for (const match of inlineSource.matchAll(/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g)) {
    const inlineCode = (match[2] ?? "").replace(/\r?\n/g, " ");
    if (containsCommandShapedInvocation(inlineCode)) {
      examples.push({ contents: inlineCode, dialect: "posix" });
    }
  }

  return examples;
}

function commandExamples(path: string, contents: string): CommandExample[] {
  const markdownBlocks = [
    ...markdownShellBlocks(contents),
    ...(path.endsWith(".md") ? markdownIndentedAndInlineCode(contents) : [])
  ];
  const htmlCodeBlocks = [...contents.matchAll(/<code\b([^>]*)>([\s\S]*?)<\/code>/gi)]
    .map((match) => {
      const attributes = match[1] ?? "";
      const language = attributes.match(/\b(?:lang|language)-([A-Za-z0-9_-]+)\b/i)?.[1]?.toLowerCase() ?? "";
      return {
        contents: decodeHtml(match[2] ?? ""),
        dialect: shellDialect(language),
        index: match.index ?? 0
      };
    })
    .filter((example) => {
      const prefix = contents.slice(0, example.index).toLowerCase();
      const isPreformatted = prefix.lastIndexOf("<pre") > prefix.lastIndexOf("</pre>");
      return isPreformatted || containsCommandShapedInvocation(example.contents, false, example.dialect);
    })
    .map(({ contents: exampleContents, dialect }) => ({ contents: exampleContents, dialect }));
  const htmlCommandLines = [...contents.matchAll(/<span\b([^>]*)>/g)]
    .filter((match) => {
      const classAttribute = (match[1] ?? "").match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/);
      const classNames = classAttribute?.[1] ?? classAttribute?.[2] ?? "";
      return classNames.split(/\s+/).includes("cmdline");
    })
    .map((match) => {
      const contentStart = (match.index ?? 0) + match[0].length;
      const contentEnd = contents.indexOf("</span>", contentStart);
      return {
        contents: decodeHtml(contentEnd < 0 ? contents.slice(contentStart) : contents.slice(contentStart, contentEnd)),
        dialect: "posix" as const
      };
    });
  const reusableTextCommands = REUSABLE_TEXT_COMMAND_EXTENSIONS.some((extension) => path.endsWith(extension))
    ? reusableTextCommandExamples(contents)
    : [];
  return [...markdownBlocks, ...htmlCodeBlocks, ...htmlCommandLines, ...reusableTextCommands];
}

function reusableTextCommandExamples(contents: string): CommandExample[] {
  const examples: CommandExample[] = [];
  const launcher = /(?<![$A-Za-z0-9_-])(?:skill-suitcase(?:\.(?:cmd|ps1))?|\$\{CLI\}|\$CLI|dist[\\/]src[\\/]cli\.js)(?=\s)/gi;

  for (const line of contents.split(/\r?\n/)) {
    for (const match of line.matchAll(launcher)) {
      if (!isReusableCommandPosition(line, match.index)) continue;
      const command = line
        .slice(match.index)
        .replace(/(?:\\[nrt]|[\s"'`,;.)}\]])+$/g, "");
      if (containsCommandShapedInvocation(command)) {
        examples.push({ contents: command, dialect: "posix" });
      }
    }
  }

  return examples;
}

function isReusableCommandPosition(line: string, start: number): boolean {
  const prefix = line.slice(0, start);
  if (/^\s*["'`]?\s*$/.test(prefix)) return true;

  const assignment = prefix.match(
    /(?:^|[,{;])\s*(?:(?:const|let|var)\s+)?["']?([-$A-Za-z_][-$A-Za-z0-9_]*)["']?\s*(?::|=)\s*["'`]?\s*$/
  );
  const name = assignment?.[1] ?? "";
  return /(?:^|[-_])(?:cmd|command|example|invocation|script)(?:$|[-_])/i.test(name);
}

function shellSegments(line: string, dialect: ShellDialect): string[] {
  const segments: string[] = [];
  collectShellSegments(line, segments, dialect);
  return segments;
}

function skipShellArithmetic(source: string, start: number, segments: string[]): number {
  let depth = 0;
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else if (quote === "\"" && character === "$" && source[index + 1] === "(") {
        if (source[index + 2] === "(") {
          index = skipShellArithmetic(source, index + 3, segments);
        } else {
          index = collectShellSegments(source, segments, "posix", index + 2, ")");
        }
      } else if (quote === "\"" && character === "`") {
        index = collectShellSegments(source, segments, "posix", index + 1, "`");
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === "$" && source[index + 1] === "(") {
      if (source[index + 2] === "(") {
        index = skipShellArithmetic(source, index + 3, segments);
      } else {
        index = collectShellSegments(source, segments, "posix", index + 2, ")");
      }
      continue;
    }
    if (character === "`") {
      index = collectShellSegments(source, segments, "posix", index + 1, "`");
      continue;
    }
    if (character !== ")") continue;
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    if (source[index + 1] === ")") return index + 1;
  }

  return source.length;
}

function collectShellSegments(
  source: string,
  segments: string[],
  dialect: ShellDialect,
  start = 0,
  terminator: ")" | "`" | null = null
): number {
  let segment = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  function finishSegment(): void {
    if (segment.trim().length > 0) segments.push(segment);
    segment = "";
  }

  for (let index = start; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (escaped) {
      segment += character;
      escaped = false;
      continue;
    }
    if (((dialect === "posix" && character === "\\") || (dialect === "powershell" && character === "`"))
      && quote !== "'") {
      segment += character;
      escaped = true;
      continue;
    }
    if (quote === "'") {
      segment += character;
      if (character === quote) quote = null;
      continue;
    }
    if (quote === "\"") {
      if (character === quote) {
        segment += character;
        quote = null;
      } else if (dialect === "posix"
        && character === "$"
        && source[index + 1] === "("
        && source[index + 2] === "(") {
        segment += SHELL_SUBSTITUTION_PLACEHOLDER;
        index = skipShellArithmetic(source, index + 3, segments);
      } else if (character === "$" && source[index + 1] === "(") {
        segment += SHELL_SUBSTITUTION_PLACEHOLDER;
        index = collectShellSegments(source, segments, dialect, index + 2, ")");
      } else if (dialect === "posix" && character === "`") {
        segment += SHELL_SUBSTITUTION_PLACEHOLDER;
        index = collectShellSegments(source, segments, dialect, index + 1, "`");
      } else {
        segment += character;
      }
      continue;
    }
    if (terminator !== null && character === terminator) {
      finishSegment();
      return index;
    }
    if (character === "\"" || character === "'") {
      segment += character;
      quote = character;
      continue;
    }
    if (dialect === "posix"
      && character === "$"
      && source[index + 1] === "("
      && source[index + 2] === "(") {
      segment += SHELL_SUBSTITUTION_PLACEHOLDER;
      index = skipShellArithmetic(source, index + 3, segments);
      continue;
    }
    if (character === "$" && source[index + 1] === "(") {
      segment += SHELL_SUBSTITUTION_PLACEHOLDER;
      index = collectShellSegments(source, segments, dialect, index + 2, ")");
      continue;
    }
    if (dialect === "posix" && (character === "<" || character === ">") && source[index + 1] === "(") {
      segment += SHELL_SUBSTITUTION_PLACEHOLDER;
      index = collectShellSegments(source, segments, dialect, index + 2, ")");
      continue;
    }
    if (dialect === "posix" && character === "`") {
      segment += SHELL_SUBSTITUTION_PLACEHOLDER;
      index = collectShellSegments(source, segments, dialect, index + 1, "`");
      continue;
    }
    if (character === "#" && (index === 0 || /[\s;&|()]/.test(source[index - 1] ?? ""))) {
      finishSegment();
      return source.length;
    }
    if (character === "(") {
      if (dialect === "posix" && source[index + 1] === "(") {
        segment += SHELL_SUBSTITUTION_PLACEHOLDER;
        index = skipShellArithmetic(source, index + 2, segments);
        continue;
      }
      finishSegment();
      index = collectShellSegments(source, segments, dialect, index + 1, ")");
      continue;
    }
    if (character === "&" && (source[index - 1] === ">" || source[index - 1] === "<" || source[index + 1] === ">")) {
      segment += character;
      continue;
    }
    if (character === "|" && source[index - 1] === ">") {
      segment += character;
      continue;
    }
    if (character === "\n" || character === "\r"
      || character === ")" || character === ";" || character === "|" || character === "&") {
      finishSegment();
      if ((character === "|" || character === "&") && source[index + 1] === character) index += 1;
      continue;
    }
    segment += character;
  }

  finishSegment();
  return source.length;
}

function shellTokens(segment: string, dialect: ShellDialect): ShellToken[] {
  const tokens: ShellToken[] = [];
  let token = "";
  let tokenProtected = false;
  let tokenSyntax = "";
  let tokenStarted = false;
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  function finishToken(): void {
    if (!tokenStarted) return;
    tokens.push({ protected: tokenProtected, syntax: tokenSyntax, value: token });
    token = "";
    tokenProtected = false;
    tokenSyntax = "";
    tokenStarted = false;
  }

  for (const character of segment) {
    if (escaped) {
      token += character;
      tokenProtected = true;
      tokenSyntax += "x";
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (((dialect === "posix" && character === "\\") || (dialect === "powershell" && character === "`"))
      && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
        tokenSyntax += "x";
      }
      tokenStarted = true;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      tokenProtected = true;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      finishToken();
      continue;
    }
    token += character;
    tokenSyntax += character;
    tokenStarted = true;
  }

  if (escaped) {
    token += dialect === "powershell" ? "`" : "\\";
    tokenProtected = true;
    tokenSyntax += "x";
  }
  finishToken();
  return tokens;
}

function isShellCommandPrefix(token: string): boolean {
  return SHELL_COMMAND_PREFIXES.has(token) || isShellAssignment(token);
}

function isShellAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function shellWrapperCommandTokens(tokens: string[], wrapper: "command" | "env" | "sudo"): string[] | null {
  const booleanOptions = wrapper === "env"
    ? new Set([
        "--debug",
        "--ignore-environment",
        "--list-signal-handling",
        "-i",
        "-v"
      ])
    : new Set([
        "--askpass",
        "--background",
        "--bell",
        "--login",
        "--non-interactive",
        "--preserve-groups",
        "--reset-timestamp",
        "--set-home",
        "--shell",
        "--stdin",
        "-A",
        "-B",
        "-b",
        "-E",
        "-H",
        "-i",
        "-k",
        "-n",
        "-P",
        "-S",
        "-s"
      ]);
  const optionsWithValues = wrapper === "env"
    ? new Set(["--argv0", "--chdir", "--unset", "-a", "-C", "-P", "-u"])
    : new Set([
        "--chdir",
        "--chroot",
        "--close-from",
        "--command-timeout",
        "--group",
        "--host",
        "--login-class",
        "--other-user",
        "--prompt",
        "--role",
        "--type",
        "--user",
        "-C",
        "-c",
        "-D",
        "-g",
        "-h",
        "-p",
        "-R",
        "-r",
        "-T",
        "-t",
        "-u"
      ]);
  const optionalValueOptions = wrapper === "env"
    ? new Set(["--block-signal", "--default-signal", "--ignore-signal"])
    : new Set(["--preserve-env"]);
  const nonExecutingOptions = wrapper === "sudo"
    ? new Set(["--edit", "--help", "--list", "--remove-timestamp", "--validate", "--version", "-K", "-V", "-e", "-l", "-v"])
    : new Set(["--null", "-0"]);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") return tokens.slice(index + 1);
    if (wrapper === "command") {
      if (token === "-p") continue;
      if (token === "-v" || token === "-V" || token.startsWith("-")) return null;
      return tokens.slice(index);
    }
    if (nonExecutingOptions.has(token)) return null;
    if (isShellAssignment(token)) {
      let commandIndex = index + 1;
      while (isShellAssignment(tokens[commandIndex] ?? "")) commandIndex += 1;
      return tokens.slice(commandIndex);
    }
    if (wrapper === "env" && isEnvLongSplitStringOption(token)) {
      assert.equal(
        containsCliLauncherText(tokens.slice(index)),
        false,
        "env split-string CLI launchers are unsupported in public examples"
      );
      return null;
    }
    if (optionsWithValues.has(token)) {
      index += 1;
      continue;
    }
    if ([...optionsWithValues].some((option) => option.startsWith("--") && token.startsWith(`${option}=`))) {
      continue;
    }
    if (booleanOptions.has(token)
      || optionalValueOptions.has(token)
      || [...optionalValueOptions].some((option) => token.startsWith(`${option}=`))
    ) {
      continue;
    }
    const shortOption = shortWrapperOption(token, wrapper);
    if (shortOption === "split-string") {
      assert.equal(
        containsCliLauncherText(tokens.slice(index)),
        false,
        "env split-string CLI launchers are unsupported in public examples"
      );
      return null;
    }
    if (shortOption === "non-executing") return null;
    if (shortOption === "value-next") {
      index += 1;
      continue;
    }
    if (shortOption === "consumed") continue;
    if (token.startsWith("-")) return null;
    return tokens.slice(index);
  }

  return null;
}

function containsCliLauncherText(tokens: string[]): boolean {
  return tokens.some((token) => {
    const normalized = token.replaceAll("\\", "/");
    return normalized.includes("skill-suitcase")
      || normalized.includes("dist/src/cli.js")
      || token.includes("$CLI")
      || token.includes("${CLI}");
  });
}

function isEnvLongSplitStringOption(token: string): boolean {
  return token === "--split-string"
    || token.startsWith("--split-string=");
}

function shortWrapperOption(
  token: string,
  wrapper: "env" | "sudo"
): "consumed" | "non-executing" | "split-string" | "unsupported" | "value-next" {
  if (!/^-[^-]/.test(token)) return "unsupported";
  const booleanOptions = wrapper === "env" ? new Set(["i", "v"]) : new Set(["A", "B", "E", "H", "P", "S", "b", "i", "k", "n", "s"]);
  const optionsWithValues = wrapper === "env" ? new Set(["C", "P", "a", "u"]) : new Set(["C", "D", "R", "T", "c", "g", "h", "p", "r", "t", "u"]);
  const nonExecutingOptions = wrapper === "env" ? new Set(["0"]) : new Set(["K", "V", "e", "l", "v"]);

  for (let index = 1; index < token.length; index += 1) {
    const option = token[index] ?? "";
    if (wrapper === "env" && option === "S") return "split-string";
    if (nonExecutingOptions.has(option)) return "non-executing";
    if (booleanOptions.has(option)) continue;
    if (optionsWithValues.has(option)) return index + 1 < token.length ? "consumed" : "value-next";
    return "unsupported";
  }
  return "consumed";
}

function shellCommandTokens(tokens: string[]): string[] | null {
  let commandTokens = tokens;
  while (commandTokens.length > 0) {
    let index = 0;
    while (isShellCommandPrefix(commandTokens[index] ?? "")) index += 1;
    commandTokens = commandTokens.slice(index);
    const wrapper = executableName(commandTokens[0] ?? "");
    if (wrapper !== "command" && wrapper !== "env" && wrapper !== "sudo"
      && wrapper !== "exec" && wrapper !== "nice" && wrapper !== "nohup"
      && wrapper !== "time" && wrapper !== "timeout") {
      return commandTokens;
    }
    const wrappedCommand = wrapper === "exec" || wrapper === "nice" || wrapper === "nohup"
      || wrapper === "time" || wrapper === "timeout"
      ? shellExecutionPrefixTokens(commandTokens, wrapper)
      : shellWrapperCommandTokens(commandTokens, wrapper);
    if (wrappedCommand === null) return null;
    commandTokens = wrappedCommand;
  }
  return null;
}

function shellExecutionPrefixTokens(
  tokens: string[],
  wrapper: "exec" | "nice" | "nohup" | "time" | "timeout"
): string[] | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      return wrapper === "timeout"
        ? (tokens[index + 2] === undefined ? null : tokens.slice(index + 2))
        : tokens.slice(index + 1);
    }
    if (wrapper === "exec") {
      if (token === "-a") {
        index += 1;
        continue;
      }
      if (/^-[cl]+$/.test(token)) continue;
    } else if (wrapper === "nice") {
      if (token === "-n" || token === "--adjustment") {
        index += 1;
        continue;
      }
      if (/^(?:--adjustment=|-)[+-]?\d+$/.test(token)) continue;
      if (token === "--help" || token === "--version") return null;
    } else if (wrapper === "nohup") {
      if (token === "--help" || token === "--version") return null;
    } else if (wrapper === "time" && token === "-p") {
      continue;
    } else if (wrapper === "timeout") {
      if (token === "--help" || token === "--version") return null;
      if (token === "-k" || token === "--kill-after" || token === "-s" || token === "--signal") {
        index += 1;
        continue;
      }
      if (token === "--foreground" || token === "--preserve-status" || token === "--verbose"
        || /^(?:--kill-after|--signal)=/.test(token)
        || /^-[ks].+/.test(token)) {
        continue;
      }
      if (!token.startsWith("-")) {
        return tokens[index + 1] === undefined ? null : tokens.slice(index + 1);
      }
    }
    if (token.startsWith("-")) return null;
    return tokens.slice(index);
  }

  return null;
}

function executableName(token: string): string {
  return token.replaceAll("\\", "/").split("/").at(-1) ?? token;
}

function executableNameForDialect(token: string, dialect: ShellDialect): string {
  const name = executableName(token);
  return dialect === "powershell" ? name.toLowerCase() : name;
}

function isSkillSuitcaseExecutable(
  token: string,
  allowPackageVersion = false,
  dialect: ShellDialect = "posix"
): boolean {
  const name = executableNameForDialect(token, dialect).replace(/\.(?:cmd|ps1)$/i, "");
  return name === "skill-suitcase"
    || (allowPackageVersion && /^skill-suitcase@[^/]+$/.test(name));
}

function packageRunnerExecutable(
  tokens: string[],
  start: number,
  runner: "bunx" | "npm" | "npx" | "pnpm" | "yarn",
  dialect: ShellDialect
): PackageRunnerExecutable | null {
  const booleanOptions = new Set(["--quiet", "--shell-mode", "--silent", "--yes", "-q", "-y"]);
  if (runner === "npm") booleanOptions.add("-p");
  const optionsWithValues = new Set([
    "--cache",
    "--config",
    "--cwd",
    "--dir",
    "--filter",
    "--package",
    "--prefix",
    "--registry",
    "--reporter",
    "--userconfig",
    "--workspace",
    "-C",
    "-w"
  ]);
  if (runner === "bunx" || runner === "npx" || runner === "yarn") optionsWithValues.add("-p");

  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      return isSkillSuitcaseExecutable(tokens[index + 1] ?? "", true, dialect)
        ? { executableIndex: index + 1, separatorBeforeExecutable: true }
        : null;
    }
    if ((runner === "npm" || runner === "npx")
      && (token === "--call" || token === "-c" || /^(?:--call|-c)=/.test(token))) {
      return null;
    }
    if (optionsWithValues.has(token)) {
      index += 1;
      continue;
    }
    if (booleanOptions.has(token) || /^--[^=]+=/.test(token)) continue;
    if (token.startsWith("-")) return null;
    return isSkillSuitcaseExecutable(token, true, dialect)
      ? { executableIndex: index, separatorBeforeExecutable: false }
      : null;
  }

  return null;
}

function packageRunnerActionIndex(
  tokens: string[],
  start: number,
  runner: "npm" | "pnpm" | "yarn"
): number {
  const booleanOptions = new Set(["--quiet", "--silent", "--verbose", "--yes", "-q", "-s", "-y"]);
  const optionsWithValues = new Set([
    "--cache",
    "--config",
    "--cwd",
    "--dir",
    "--filter",
    "--prefix",
    "--registry",
    "--reporter",
    "--userconfig",
    "--workspace",
    "-C",
    "-w"
  ]);

  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (optionsWithValues.has(token)) {
      index += 1;
      continue;
    }
    if (booleanOptions.has(token) || /^--[^=]+=/.test(token)) continue;
    if (token === "exec" || ((runner === "pnpm" || runner === "yarn") && token === "dlx")) {
      return index;
    }
    return -1;
  }

  return -1;
}

function isSourceCliEntrypoint(token: string, dialect: ShellDialect = "posix"): boolean {
  const normalized = dialect === "powershell"
    ? token.replaceAll("\\", "/").toLowerCase()
    : token.replaceAll("\\", "/");
  return normalized === (dialect === "powershell" ? "$cli" : "$CLI")
    || normalized === (dialect === "powershell" ? "${cli}" : "${CLI}")
    || /(?:^|\/)dist\/src\/cli\.js$/.test(normalized);
}

function powershellCommandTokens(tokens: string[]): string[] {
  const commandTokens = withoutPowershellPrompt(tokens.map((value) => ({ value })))
    .map((token) => token.value);
  const compactAssignment = commandTokens[0]?.match(
    /^\$(?:[A-Za-z_][A-Za-z0-9_]*:)?[A-Za-z_][A-Za-z0-9_]*=(.*)$/
  );

  if (compactAssignment !== undefined && compactAssignment !== null) {
    const firstCommandToken = compactAssignment[1] ?? "";
    return firstCommandToken.length > 0
      ? [firstCommandToken, ...commandTokens.slice(1)]
      : commandTokens.slice(1);
  }

  if (/^\$(?:[A-Za-z_][A-Za-z0-9_]*:)?[A-Za-z_][A-Za-z0-9_]*$/.test(commandTokens[0] ?? "")) {
    const assignment = commandTokens[1] ?? "";
    if (assignment === "=") return commandTokens.slice(2);
    if (assignment.startsWith("=")) {
      const firstCommandToken = assignment.slice(1);
      return firstCommandToken.length > 0
        ? [firstCommandToken, ...commandTokens.slice(2)]
        : commandTokens.slice(2);
    }
  }
  return commandTokens;
}

function nodeSourceCliEntrypointIndex(tokens: string[], start: number, dialect: ShellDialect): number {
  const fileLaunchOptions = new Set(["--watch", "--watch-preserve-output"]);
  const nonScriptOptions = new Set([
    "--check",
    "--completion-bash",
    "--eval",
    "--help",
    "--input-type",
    "--print",
    "--prof-process",
    "--run",
    "--test",
    "--version",
    "-c",
    "-e",
    "-h",
    "-p",
    "-v"
  ]);

  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") return isSourceCliEntrypoint(tokens[index + 1] ?? "", dialect) ? index + 1 : -1;
    if (nonScriptOptions.has(token)
      || /^(?:--eval|--input-type|--print|--run|-e|-p)=?./.test(token)) {
      return -1;
    }
    if (NODE_CLI_VALUE_OPTIONS.has(token)) {
      index += 1;
      continue;
    }
    if (fileLaunchOptions.has(token)
      || (token.startsWith("-") && allowedNodeEnvironmentFlags.has(token))
      || /^(?:--conditions|--env-file(?:-if-exists)?|--experimental-loader|--import|--inspect-port|--loader|--require|--title)=/.test(token)
      || /^-r.+/.test(token)) {
      continue;
    }
    if (token.startsWith("-")) return -1;
    return isSourceCliEntrypoint(token, dialect) ? index : -1;
  }

  return -1;
}

function skillSuitcaseLauncher(tokens: string[], dialect: ShellDialect = "posix"): CliLauncher | null {
  const dialectTokens = dialect === "powershell" ? powershellCommandTokens(tokens) : tokens;
  const commandTokens = shellCommandTokens(dialectTokens);
  if (commandTokens === null) return null;

  const candidate = commandTokens[0];
  if (candidate === undefined) return null;
  if (isSkillSuitcaseExecutable(candidate, false, dialect)) {
    return { invocation: commandTokens };
  }
  if (isSourceCliEntrypoint(candidate, dialect)) {
    return { invocation: commandTokens };
  }

  const wrapper = executableNameForDialect(candidate, dialect);
  if (wrapper === "npx" || wrapper === "bunx") {
    const executable = packageRunnerExecutable(commandTokens, 1, wrapper, dialect);
    return executable === null
      ? null
      : { invocation: commandTokens.slice(executable.executableIndex) };
  }

  if (wrapper === "node") {
    const executableIndex = nodeSourceCliEntrypointIndex(commandTokens, 1, dialect);
    return executableIndex < 0 ? null : { invocation: commandTokens.slice(executableIndex) };
  }

  if (wrapper === "npm" || wrapper === "pnpm" || wrapper === "yarn") {
    const actionIndex = packageRunnerActionIndex(commandTokens, 1, wrapper);
    if (actionIndex < 0) return null;
    const executable = packageRunnerExecutable(commandTokens, actionIndex + 1, wrapper, dialect);
    if (wrapper === "npm" && executable !== null) {
      assert.equal(
        executable.separatorBeforeExecutable,
        true,
        "npm exec examples must use -- before skill-suitcase"
      );
    }
    return executable === null
      ? null
      : { invocation: commandTokens.slice(executable.executableIndex) };
  }

  return null;
}

function withoutShellRedirections(tokens: ShellToken[]): ShellToken[] {
  const commandTokens: ShellToken[] = [];
  const standaloneOperator = /^(?:\d+|\*)?(?:>>>?|<<<|<<-?|<>|>\||>|<|>&|<&|&>>?)$/;
  const attachedRedirection = /^(?:(?:\d+|\*)?(?:>>>?|<<<|<<-?|<>|>\||>|<).+|(?:\d+|\*)?(?:>&|<&)(?:\d+|-)|&>>?.+)$/;

  function requireTarget(index: number): void {
    const target = tokens[index + 1];
    assert.ok(
      target !== undefined
        && !standaloneOperator.test(target.syntax)
        && !attachedRedirection.test(target.syntax),
      "shell redirection requires a target"
    );
  }

  function inlineRedirectionIndex(syntax: string): number {
    for (let index = 1; index < syntax.length; index += 1) {
      const character = syntax[index] ?? "";
      if (character !== "<" && character !== ">" && !(character === "&" && syntax[index + 1] === ">")) {
        continue;
      }
      const suffix = syntax.slice(index);
      if (standaloneOperator.test(suffix) || attachedRedirection.test(suffix)) return index;
    }
    return -1;
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (/^<[^<>]+>$/.test(token.syntax)) {
      commandTokens.push(token);
      continue;
    }
    if (standaloneOperator.test(token.syntax)) {
      requireTarget(index);
      index += 1;
      continue;
    }
    if (attachedRedirection.test(token.syntax)) continue;
    const redirectionIndex = inlineRedirectionIndex(token.syntax);
    if (redirectionIndex >= 0) {
      commandTokens.push({
        protected: token.protected,
        syntax: token.syntax.slice(0, redirectionIndex),
        value: token.value.slice(0, redirectionIndex)
      });
      if (standaloneOperator.test(token.syntax.slice(redirectionIndex))) {
        requireTarget(index);
        index += 1;
      }
      continue;
    }
    commandTokens.push(token);
  }

  return commandTokens;
}

function withoutPowershellPrompt<T extends { value: string }>(tokens: T[]): T[] {
  if (tokens[0]?.value === "PS>") return tokens.slice(1);
  if (tokens[0]?.value !== "PS") return tokens;

  const promptEnd = tokens.findIndex((token, index) => index > 0 && token.value.endsWith(">"));
  return promptEnd < 0 ? tokens : tokens.slice(promptEnd + 1);
}

function withoutPosixPrompt<T extends { value: string }>(tokens: T[], interactive: boolean): T[] {
  if (!interactive) return tokens;
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]*[$#%]$/.test(tokens[0]?.value ?? "")
    ? tokens.slice(1)
    : tokens;
}

function shellInvocationTokens(
  segment: string,
  dialect: ShellDialect,
  interactive = false
): ShellToken[] {
  const tokens = shellTokens(segment, dialect);
  const promptlessTokens = dialect === "powershell"
    ? withoutPowershellPrompt(tokens)
    : withoutPosixPrompt(tokens, interactive);
  return withoutShellRedirections(promptlessTokens);
}

function logicalShellLines(example: CommandExample): string[] {
  if (example.dialect === "powershell") {
    const lines = example.contents.split(/\r?\n/);
    const commandLines: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      let line = lines[index] ?? "";
      while (hasPowershellLineContinuation(line) && index + 1 < lines.length) {
        index += 1;
        line = `${line.slice(0, -1)} ${(lines[index] ?? "").replace(/^\s*/, "")}`;
      }
      commandLines.push(line);
    }

    return commandLines;
  }

  const lines = example.contents.split(/\r?\n/);

  const commandLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index] ?? "";
    while (hasPosixLineContinuation(line) && index + 1 < lines.length) {
      index += 1;
      line = `${line.slice(0, -1)} ${(lines[index] ?? "").replace(/^\s*/, "")}`;
    }
    commandLines.push(line);
    for (const heredoc of shellHeredocDelimiters(line)) {
      let found = false;
      while (index + 1 < lines.length) {
        index += 1;
        const bodyLine = lines[index] ?? "";
        const candidate = heredoc.stripTabs ? bodyLine.replace(/^\t+/, "") : bodyLine;
        if (candidate === heredoc.delimiter) {
          found = true;
          break;
        }
        if (!heredoc.quoted) commandLines.push(...shellHereDocExpansionSegments(bodyLine));
      }
      assert.ok(found, `shell here-document requires delimiter: ${heredoc.delimiter}`);
    }
  }

  return commandLines;
}

function hasPowershellLineContinuation(line: string): boolean {
  const trailingBackticks = line.match(/`+$/)?.[0] ?? "";
  if (trailingBackticks.length % 2 === 0) return false;

  let quote: "\"" | "'" | null = null;
  const continuationIndex = line.length - trailingBackticks.length;
  for (let index = 0; index < continuationIndex; index += 1) {
    const character = line[index] ?? "";
    if (quote === "'") {
      if (character !== "'") continue;
      if (line[index + 1] === "'") {
        index += 1;
      } else {
        quote = null;
      }
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
    if (character === "\"" || character === "'") quote = character;
  }

  return quote !== "'";
}

function hasPosixLineContinuation(line: string): boolean {
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      if (index === line.length - 1) return true;
      escaped = true;
      continue;
    }
    if (quote === null && (character === "\"" || character === "'")) {
      quote = character;
    } else if (character === quote) {
      quote = null;
    }
  }

  return false;
}

function shellHeredocDelimiters(line: string): Array<{ delimiter: string; quoted: boolean; stripTabs: boolean }> {
  const heredocs: Array<{ delimiter: string; quoted: boolean; stripTabs: boolean }> = [];

  for (const segment of shellSegments(line, "posix")) {
    const tokens = shellTokens(segment, "posix");
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === undefined) continue;
      const standalone = token.syntax.match(/^(?:\d*)<<(-?)$/);
      if (standalone !== null) {
        const delimiter = tokens[index + 1]?.value;
        assert.ok(delimiter !== undefined && delimiter.length > 0, "shell here-document requires a delimiter");
        heredocs.push({
          delimiter,
          quoted: tokens[index + 1]?.protected ?? false,
          stripTabs: standalone[1] === "-"
        });
        index += 1;
        continue;
      }
      const attached = token.syntax.match(/^(?:\d*)<<(-?)(?!<)(.+)$/);
      if (attached === null) continue;
      const operatorIndex = token.syntax.indexOf("<<");
      const delimiter = token.value.slice(operatorIndex + 2 + (attached[1] === "-" ? 1 : 0));
      assert.ok(delimiter.length > 0, "shell here-document requires a delimiter");
      heredocs.push({ delimiter, quoted: token.protected, stripTabs: attached[1] === "-" });
    }
  }

  return heredocs;
}

function shellHereDocExpansionSegments(line: string): string[] {
  const segments: string[] = [];

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "$" && line[index + 1] === "(") {
      if (line[index + 2] === "(") {
        index = skipShellArithmetic(line, index + 3, segments);
      } else {
        index = collectShellSegments(line, segments, "posix", index + 2, ")");
      }
      continue;
    }
    if (character === "`") {
      index = collectShellSegments(line, segments, "posix", index + 1, "`");
    }
  }

  return segments;
}

function isPublicUpstreamSubcommand(token: string | undefined): boolean {
  if (token === undefined) return false;
  try {
    return parseCommandArgs(["upstream", token, "--json"]).upstreamAction === token;
  } catch {
    return false;
  }
}

function validateCliExamples(path: string, contents: string): number {
  let invocationCount = 0;

  for (const example of commandExamples(path, contents)) {
    for (const line of logicalShellLines(example)) {
      for (const segment of shellSegments(line, example.dialect)) {
        const tokens = shellInvocationTokens(segment, example.dialect, example.interactive);
        const launcher = skillSuitcaseLauncher(tokens.map((token) => token.value), example.dialect);
        if (launcher === null) continue;

        invocationCount += 1;
        const invocation = launcher.invocation
          .filter((token) => !OPTIONAL_INVOCATION_PLACEHOLDERS.has(token));
        const command = invocation[1] ?? "";
        const possibleSubcommand = invocation[2];
        assert.ok(PUBLIC_COMMANDS.has(command), `${path} documents unknown command: ${command}`);
        if (command === "upstream") {
          assert.ok(
            isPublicUpstreamSubcommand(possibleSubcommand),
            `${path} documents unknown upstream command: ${possibleSubcommand ?? "<missing>"}`
          );
        }
        assert.ok(
          invocation.includes("--json"),
          `${path} has a CLI example without --json: ${invocation.join(" ")}`
        );
        let parsed: ReturnType<typeof parseCommandArgs>;
        try {
          parsed = parseCommandArgs(invocation.slice(1));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          assert.fail(`${path} has an invalid CLI invocation: ${invocation.join(" ")} (${message})`);
        }
        assert.ok(
          COMMAND_REGISTRY.find(parsed) !== null,
          `${path} CLI does not accept invocation: ${invocation.join(" ")}`
        );
      }
    }
  }

  return invocationCount;
}

function assertNoPrivateMachinePaths(path: string, contents: string): void {
  const normalizedContents = contents.replace(/\\{2,}/g, "\\").replaceAll("\\/", "/");
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

test("public and reusable docs contain no contributor-specific machine paths", () => {
  const documents = publicDocumentPaths();
  assert.ok(documents.length > 0, "public documentation inventory must not be empty");

  for (const path of documents) {
    const contents = readFileSync(path, "utf8");
    assertNoPrivateMachinePaths(path, contents);
  }
});

test("private machine path checks cover roots and Windows separators", () => {
  for (const privatePath of [
    "`/Users/alice`",
    "`/home/alice`",
    "`/root/project`",
    "Use /root.",
    "(/root)",
    "path:/root/project",
    "C:/Users/alice/project",
    "C:\\Users\\alice",
    "/mnt/c/Users/alice/project",
    "/c/Users/alice/project",
    "~alice/project",
    String.raw`\\server\Users\alice\project`,
    String.raw`{"path":"C:\\Users\\alice\\project"}`
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

  for (const path of publicDocumentPaths()) {
    const contents = readFileSync(path, "utf8");
    invocationCount += validateCliExamples(path, contents);
  }

  assert.ok(invocationCount > 0, "public documentation must contain checked CLI examples");
});

test("CLI example parsing rejects invalid tokens and validates each pipe segment", () => {
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nskill-suitcase status2 --json\n```"),
    /unknown command: status2/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nskill-suitcase upstream check2 --json\n```"),
    /unknown upstream command: check2/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```sh\nskill-suitcase status --source . --json | skill-suitcase validate\n```"
    ),
    /CLI example without --json: skill-suitcase validate/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```sh\nskill-suitcase status --source . --json | skill-suitcase bogus --json\n```"
    ),
    /unknown command: bogus/
  );
  for (const nodeFlag of ["--inspect", "--inspect-brk", "--no-deprecation", "--watch"]) {
    assert.throws(
      () => validateCliExamples(
        "fixture.md",
        `\`\`\`sh\nnode ${nodeFlag} dist/src/cli.js bogus --json\n\`\`\``
      ),
      /unknown command: bogus/
    );
  }
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nnpm exec -p skill-suitcase bogus --json\n```"),
    /npm exec examples must use -- before skill-suitcase/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nskill-suitcase status | jq --json\n```"),
    /CLI example without --json: skill-suitcase status/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nif skill-suitcase bogus --json; then exit 1; fi\n```"),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nskill-suitcase status # add --json for scripts\n```"),
    /CLI example without --json: skill-suitcase status/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nskill-suitcase status --not-a-real-flag --json\n```"),
    /invalid CLI invocation.*Unknown argument: --not-a-real-flag/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nskill-suitcase -- status --json\n```"),
    /unknown command: --/
  );
});

test("CLI example parsing covers common shell fence forms", () => {
  for (const fixture of [
    "~~~bash\nskill-suitcase bogus --json\n~~~",
    "```console\n$ skill-suitcase bogus --json\n```",
    "```console\nalice@host:~$ skill-suitcase bogus --json\n```",
    '```bash title="demo"\nskill-suitcase bogus --json\n```',
    "```shell-session\n$ skill-suitcase bogus --json\n```",
    "```shell-session\nalice@host:~/project$ skill-suitcase bogus --json\n```",
    "```zsh\nskill-suitcase bogus --json\n```",
    "```fish\nskill-suitcase bogus --json\n```",
    "```pwsh\nskill-suitcase bogus --json\n```",
    "```\nskill-suitcase bogus --json\n```",
    "```terminal\nskill-suitcase bogus --json\n```",
    "```shellscript\nskill-suitcase bogus --json\n```",
    "```text\nskill-suitcase bogus --json\n```",
    "```output\n$ skill-suitcase bogus --json\n```",
    "```{bash}\nskill-suitcase bogus --json\n```",
    "```bash\r\nskill-suitcase bogus --json\r\n```",
    "```BASH\nskill-suitcase bogus --json\n````"
  ]) {
    assert.throws(() => validateCliExamples("fixture.md", fixture), /unknown command: bogus/);
  }

  assert.equal(
    validateCliExamples("fixture.md", "````text\n```bash\nskill-suitcase bogus --json\n```\n````"),
    0
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      "````text\nskill-suitcase status --source . --json\n```bash\nskill-suitcase bogus --json\n```\n````"
    ),
    1
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```text\n$ skill-suitcase\n```"),
    /unknown command: /
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nskill-suitcase bogus --json"),
    /unterminated Markdown fence/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```text\nExample output:\nskill-suitcase bogus --json\n```"
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "> ```bash\n> skill-suitcase bogus --json\n> ```"
    ),
    /unknown command: bogus/
  );
});

test("CLI example parsing validates command substitutions and subshells", () => {
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nRESULT=$(skill-suitcase bogus --json)\n```"),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\n(skill-suitcase status)\n```"),
    /CLI example without --json: skill-suitcase status/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", '```sh\nRESULT="$(skill-suitcase bogus --json)"\n```'),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nRESULT=`skill-suitcase bogus --json`\n```"),
    /unknown command: bogus/
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\necho '$(skill-suitcase bogus --json)'\n```"),
    0
  );
  assert.equal(
    validateCliExamples("fixture.md", '```sh\nskill-suitcase status --source "$(pwd)" --json\n```'),
    1
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\nskill-suitcase status --source `pwd` --json\n```"),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      "```bash\nvalue=$((1 << 2))\n((value = 1 << 2))\nskill-suitcase status --source \"$((value + 1))\" --json\n```"
    ),
    1
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```bash\necho \"$(( $(skill-suitcase bogus --json) + 1 ))\"\n```"
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```bash\necho $((`skill-suitcase bogus --json` + 1))\n```"
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```pwsh\n$((skill-suitcase bogus --json))\n```"
    ),
    /unknown command: bogus/
  );
});

test("CLI example parsing recognizes wrappers and path-qualified executables", () => {
  for (const command of [
    "env -i skill-suitcase bogus --json",
    "env --unset HOME skill-suitcase bogus --json",
    "env --argv0 custom skill-suitcase bogus --json",
    "env -a custom skill-suitcase bogus --json",
    "env -uHOME skill-suitcase bogus --json",
    "env -vi skill-suitcase bogus --json",
    "sudo -E skill-suitcase bogus --json",
    "sudo --non-interactive skill-suitcase bogus --json",
    "sudo --preserve-env=HOME skill-suitcase bogus --json",
    "sudo --command-timeout 5 skill-suitcase bogus --json",
    "sudo --command-timeout=5 skill-suitcase bogus --json",
    "sudo --user root skill-suitcase bogus --json",
    "sudo -uroot skill-suitcase bogus --json",
    "sudo -nE skill-suitcase bogus --json",
    "sudo -E env -i command -- skill-suitcase bogus --json",
    "command -- skill-suitcase bogus --json"
  ]) {
    assert.throws(
      () => validateCliExamples("fixture.md", `\`\`\`sh\n${command}\n\`\`\``),
      /unknown command: bogus/
    );
  }

  assert.equal(
    validateCliExamples(
      "fixture.md",
      "```sh\nenv -i MODE=test sudo -E command -p skill-suitcase status --source . --json\n```"
    ),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      "```sh\nenv MODE=test -u HOME skill-suitcase status --source . --json\n```"
    ),
    0
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\ncommand -v skill-suitcase bogus --json\n```"),
    0
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\nsudo -e -- skill-suitcase bogus\n```"),
    0
  );
  for (const command of [
    "env -0 skill-suitcase bogus --json",
    "env --null skill-suitcase bogus --json"
  ]) {
    assert.equal(validateCliExamples("fixture.md", `\`\`\`sh\n${command}\n\`\`\``), 0);
  }
  for (const command of [
    "env -S 'skill-suitcase bogus --json'",
    "env -S '-i skill-suitcase bogus --json'",
    "env -S '-u HOME skill-suitcase bogus --json'",
    "env -S'skill-suitcase bogus --json'",
    "env -vS'skill-suitcase bogus --json'",
    "env --split-string='skill-suitcase bogus --json'",
    String.raw`env -S 'skill-suitcase\_bogus --json'`
  ]) {
    assert.throws(
      () => validateCliExamples("fixture.md", `\`\`\`sh\n${command}\n\`\`\``),
      /env split-string CLI launchers are unsupported/
    );
  }
  assert.equal(validateCliExamples("fixture.md", "```sh\nenv -S 'echo ok'\n```"), 0);

  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nnpx skill-suitcase bogus --json\n```"),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\n/usr/local/bin/skill-suitcase bogus --json\n```"),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nnode dist/src/cli.js bogus --json\n```"),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nnode \"$CLI\" bogus --json\n```"),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\n\"$CLI\" bogus --json\n```"),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\n${CLI} bogus --json\n```"),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```sh\nnode --require ./hook.js dist/src/cli.js bogus --json\n```"
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```sh\nnode -C development dist/src/cli.js bogus --json\n```"
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```sh\nnode --trace-event-categories node.async_hooks dist/src/cli.js bogus --json\n```"
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```sh\nnpm exec --package=skill-suitcase -- skill-suitcase bogus --json\n```"
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```sh\nnpm exec --workspace docs -- skill-suitcase bogus --json\n```"
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```sh\nnpm --silent exec -- skill-suitcase bogus --json\n```"
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```sh\nyarn dlx -p skill-suitcase skill-suitcase bogus --json\n```"
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```sh\nyarn --cwd docs dlx -p skill-suitcase skill-suitcase bogus --json\n```"
    ),
    /unknown command: bogus/
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\nnpx skill-suitcase status --source . --json\n```"),
    1
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\nnode \"$CLI\" status --source . --json\n```"),
    1
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\n\"$CLI\" status --source ./catalog --json\n```"),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      "```sh\nnpm exec --yes --package skill-suitcase -- skill-suitcase status --source . --json\n```"
    ),
    1
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\nnpm exec -- skill-suitcase status --source . --json\n```"),
    1
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nnpm exec skill-suitcase status --json\n```"),
    /npm exec examples must use -- before skill-suitcase/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nnpm exec -- skill-suitcase -- status --json\n```"),
    /unknown command: --/
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\nnpx cowsay -- skill-suitcase bogus --json\n```"),
    0
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nnpx skill-suitcase -- status --json\n```"),
    /unknown command: --/
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      "```sh\nnpm exec --call \"echo ok\" skill-suitcase status --json\n```"
    ),
    0
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\nnode --require dist/src/cli.js other.js bogus --json\n```"),
    0
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\nnode -e \"console.log('ok')\" dist/src/cli.js bogus --json\n```"),
    0
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\nnode no-deprecation dist/src/cli.js status --json\n```"),
    0
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\nnode --input-type=module dist/src/cli.js status --json\n```"),
    0
  );
  for (const command of [
    "time skill-suitcase bogus --json",
    "exec skill-suitcase bogus --json",
    "nohup skill-suitcase bogus --json",
    "nice -n 5 skill-suitcase bogus --json",
    "timeout 30 skill-suitcase bogus --json",
    "timeout -sTERM 30 skill-suitcase bogus --json",
    "timeout -k5s 30 skill-suitcase bogus --json"
  ]) {
    assert.throws(
      () => validateCliExamples("fixture.md", `\`\`\`sh\n${command}\n\`\`\``),
      /unknown command: bogus/
    );
  }
});

test("CLI example parsing excludes shell redirections from CLI arguments", () => {
  for (const command of [
    "skill-suitcase status --source . --json > status.json",
    "skill-suitcase status --source . --json 2>errors.log",
    "skill-suitcase status --source . --json 2>&1",
    "skill-suitcase status --source . --json &> combined.log",
    "skill-suitcase status --source . --json &>> combined.log",
    "skill-suitcase status --source . --json >| status.json",
    "skill-suitcase status --source . --json>status.json"
  ]) {
    assert.equal(validateCliExamples("fixture.md", `\`\`\`sh\n${command}\n\`\`\``), 1);
  }

  for (const source of ['">"', '">catalog"', "\\>"]) {
    assert.equal(
      validateCliExamples("fixture.md", `\`\`\`sh\nskill-suitcase status --source ${source} --json\n\`\`\``),
      1
    );
  }

  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nskill-suitcase status > --json\n```"),
    /CLI example without --json: skill-suitcase status/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\n>status.json skill-suitcase bogus --json\n```"),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nnpx 2>/dev/null skill-suitcase bogus --json\n```"),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nskill-suitcase status --json >\n```"),
    /shell redirection requires a target/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nskill-suitcase status --json > >status.json\n```"),
    /shell redirection requires a target/
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      "```bash\nskill-suitcase status --source <(make-catalog) --json\n```"
    ),
    1
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```bash\nskill-suitcase status --source <(skill-suitcase bogus --json) --json\n```"
    ),
    /unknown command: bogus/
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      "```bash\nskill-suitcase status --source . --json <<EOF\nskill-suitcase bogus --json\nEOF\n```"
    ),
    1
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```bash\nskill-suitcase status --json <<EOF\nmissing\n```"),
    /shell here-document requires delimiter: EOF/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```bash\ncat <<EOF\n$(skill-suitcase bogus --json)\nEOF\n```"
    ),
    /unknown command: bogus/
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      "```bash\ncat <<'EOF'\n$(skill-suitcase bogus --json)\nEOF\n```"
    ),
    0
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      ["```bash", "cat <<'EOF'", `body${"\\"}`, "EOF", "skill-suitcase status --source . --json", "```"].join("\n")
    ),
    1
  );
});

test("CLI example parsing applies PowerShell continuation and escaping", () => {
  assert.equal(
    validateCliExamples(
      "fixture.md",
      "```pwsh\nskill-suitcase status `\n  --source \"C:\\catalog` name\" `\n  --json > status.json\n```"
    ),
    1
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```powershell\nskill-suitcase bogus `\n  --json\n```"
    ),
    /unknown command: bogus/
  );
  for (const command of [
    "PS> skill-suitcase bogus --json",
    "$result = skill-suitcase bogus --json",
    "$result=skill-suitcase bogus --json",
    String.raw`.\skill-suitcase.cmd bogus --json`,
    String.raw`C:\tools\skill-suitcase.ps1 bogus --json`,
    String.raw`C:\tools\Skill-Suitcase.cmd bogus --json`,
    "NPX Skill-Suitcase bogus --json",
    "NPM exec -- Skill-Suitcase bogus --json"
  ]) {
    assert.throws(
      () => validateCliExamples("fixture.md", `\`\`\`pwsh\n${command}\n\`\`\``),
      /unknown command: bogus/
    );
  }
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```pwsh\nWrite-Output ok``\nskill-suitcase bogus --json\n```"
    ),
    /unknown command: bogus/
  );
});

test("CLI example parsing covers command strings in reusable text formats", () => {
  for (const [path, contents] of [
    ["fixture.yaml", "command: skill-suitcase bogus --json\n"],
    ["fixture.json", '{"command":"skill-suitcase bogus --json"}\n'],
    ["fixture.js", 'const command = "skill-suitcase bogus --json";\n'],
    ["fixture.css", ':root { --example: "skill-suitcase bogus --json"; }\n'],
    ["fixture.txt", "skill-suitcase bogus --json\n"]
  ] as const) {
    assert.throws(
      () => validateCliExamples(path, contents),
      /unknown command: bogus/
    );
  }

  for (const [path, contents] of [
    ["fixture.yaml", "description: skill-suitcase status reports target state.\n"],
    ["fixture.yaml", "default_prompt: Run skill-suitcase bogus --json\n"],
    ["fixture.json", '{"description":"Run skill-suitcase bogus --json"}\n'],
    ["fixture.js", 'const description = "Run skill-suitcase bogus --json";\n'],
    ["fixture.css", ':root { --description: "Run skill-suitcase bogus --json"; }\n'],
    ["fixture.txt", "Run skill-suitcase bogus --json\n"]
  ] as const) {
    assert.equal(validateCliExamples(path, contents), 0);
  }
});

test("HTML command examples include visible cmdline elements", () => {
  assert.throws(
    () => validateCliExamples(
      "fixture.html",
      '<span class="what"><span class="example cmdline">skill-suitcase bogus --json</span>Details.</span>'
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.html",
      '<pre class="example">\n  <code class="language-shell">skill-suitcase bogus --json</code>\n</pre>'
    ),
    /unknown command: bogus/
  );
  assert.equal(
    validateCliExamples(
      "fixture.html",
      '<pre><code class="language-powershell">skill-suitcase status --source . `\n  --json</code></pre>'
    ),
    1
  );
  for (const path of ["fixture.html", "fixture.md"]) {
    assert.throws(
      () => validateCliExamples(path, "<code>skill-suitcase bogus --json</code>"),
      /unknown command: bogus/
    );
    assert.throws(
      () => validateCliExamples(
        path,
        '<pre><code class="language-shell">skill-suitcase bogus --json</code></pre>'
      ),
      /unknown command: bogus/
    );
  }
});

test("CLI example parsing recognizes POSIX control and grouping prefixes", () => {
  for (const command of [
    "else skill-suitcase bogus --json",
    "{ skill-suitcase bogus --json; }"
  ]) {
    assert.throws(
      () => validateCliExamples("fixture.md", `\`\`\`sh\n${command}\n\`\`\``),
      /unknown command: bogus/
    );
  }
});

test("CLI example parsing validates registry acceptance", () => {
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nskill-suitcase status --json\n```"),
    /CLI does not accept invocation: skill-suitcase status --json/
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\nskill-suitcase status --source . --json\n```"),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      "```sh\n$CLI status --source . --target <target-id> <local-overrides> --json\n```"
    ),
    1
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```sh\n$CLI status --source . <unknown-placeholder> --json\n```"
    ),
    /invalid CLI invocation.*Unknown argument: <unknown-placeholder>/
  );
});

test("CLI example parsing covers indented and inline Markdown code", () => {
  assert.throws(
    () => validateCliExamples("fixture.md", "    skill-suitcase bogus --json\n"),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "Run `skill-suitcase bogus --json` now.\n"),
    /unknown command: bogus/
  );
  assert.equal(
    validateCliExamples("fixture.md", "Run ``skill-suitcase status --source . --json`` now.\n"),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      "The `skill-suitcase` binary reads `skill-suitcase.yaml`.\n"
    ),
    0
  );
  assert.throws(
    () => validateCliExamples("fixture.md", ">     skill-suitcase bogus --json\n"),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      [
        "```sh",
        "echo example \\\\",
        "skill-suitcase bogus --json",
        "```"
      ].join("\n")
    ),
    /unknown command: bogus/
  );
});
