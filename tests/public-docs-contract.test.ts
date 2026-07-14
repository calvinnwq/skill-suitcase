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
const HTML_PROSE_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dt",
  "figcaption",
  "footer",
  "header",
  "li",
  "main",
  "nav",
  "p",
  "section",
  "summary",
  "td",
  "th"
]);
const COMMAND_VALUE_KEYS = new Set(["command", "commands", "example", "examples", "run", "runs", "script", "scripts"]);
const ARGV_VALUE_KEYS = new Set(["command", "example", "run", "script"]);
const COMMAND_CONTAINER_KEYS = new Set(["commands", "examples", "runs", "scripts"]);
const CLI_REFERENCE_DATA_COMMANDS = new Set(["cd", "echo", "gh", "git", "printf"]);
const COMMAND_REGISTRY = createCommandRegistry();
const PUBLIC_COMMANDS: ReadonlySet<string> = new Set(COMMAND_REGISTRY.names());
const OPTIONAL_INVOCATION_PLACEHOLDERS = new Set(["<local-overrides>"]);
const CLI_VALUE_FLAGS = new Set([
  "--agents-skills",
  "--artifact",
  "--claude-skills",
  "--codex-home",
  "--codex-skills",
  "--grok-skills",
  "--hermes-skills",
  "--lock",
  "--mode",
  "--output",
  "--plan-id",
  "--receipt",
  "--skill",
  "--source",
  "--target",
  "--target-skill"
]);
const POWERSHELL_CALL_WRAPPER = "__powershell_call__";
const CMD_FLAG_OPTIONS = new Set(["/?", "/a", "/d", "/q", "/s", "/u"]);
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
  "stdbuf",
  "sudo",
  "timeout",
  "time",
  "watch",
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
const NODE_RUNTIME_FLAG_OPTIONS = new Set(["--enable-source-maps", "--no-warnings"]);
const NODE_SHORT_VALUE_OPTIONS = new Set(["-C", "-r"]);
const ENV_SPLIT_ESCAPE_VALUES: Readonly<Record<string, string>> = {
  "#": "#",
  "$": "$",
  "\"": "\"",
  "'": "'",
  "\\": "\\",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  _: " "
};
const TIMEOUT_DURATION_PATTERN = /^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|0[xX](?:[\dA-Fa-f]+(?:\.[\dA-Fa-f]*)?|\.[\dA-Fa-f]+)[pP][+-]?\d+)[smhd]?$/;
const TIMEOUT_SIGNAL_PATTERN = /^(?:\d+|(?:SIG)?[A-Za-z][A-Za-z0-9]*)$/;
const NPM_EXEC_VALUE_OPTIONS = new Set([
  "-c",
  "-C",
  "-w",
  "--cache",
  "--call",
  "--package",
  "--prefix",
  "--registry",
  "--script-shell",
  "--userconfig",
  "--workspace"
]);
const NPM_RUNNER_FLAG_OPTIONS = new Set([
  "-p",
  "-s",
  "--include-workspace-root",
  "--no",
  "--offline",
  "--prefer-offline",
  "--prefer-online",
  "--silent",
  "--workspaces",
  "--yes"
]);
const NPM_ACTIONS = new Set([
  "access",
  "adduser",
  "approve-scripts",
  "audit",
  "bugs",
  "cache",
  "ci",
  "completion",
  "config",
  "dedupe",
  "deny-scripts",
  "deprecate",
  "diff",
  "dist-tag",
  "docs",
  "doctor",
  "edit",
  "exec",
  "explain",
  "explore",
  "find-dupes",
  "fund",
  "get",
  "help",
  "help-search",
  "init",
  "install",
  "install-ci-test",
  "install-test",
  "link",
  "ll",
  "login",
  "logout",
  "ls",
  "org",
  "outdated",
  "owner",
  "pack",
  "ping",
  "pkg",
  "prefix",
  "profile",
  "prune",
  "publish",
  "query",
  "rebuild",
  "repo",
  "restart",
  "root",
  "run",
  "run-script",
  "sbom",
  "search",
  "set",
  "shrinkwrap",
  "stage",
  "star",
  "stars",
  "start",
  "stop",
  "team",
  "test",
  "token",
  "trust",
  "undeprecate",
  "uninstall",
  "unpublish",
  "unstar",
  "update",
  "version",
  "view",
  "whoami",
  "x"
]);
const NPX_VALUE_OPTIONS = new Set([
  "-c",
  "-C",
  "-p",
  "-w",
  "--cache",
  "--call",
  "--package",
  "--prefix",
  "--registry",
  "--script-shell",
  "--userconfig",
  "--workspace"
]);
const PNPM_RUNNER_VALUE_OPTIONS = new Set(["--allow-build", "--package", "--reporter"]);
const YARN_RUNNER_VALUE_OPTIONS = new Set(["-p", "--package"]);
const NPX_RUNNER_FLAG_OPTIONS = new Set(["-y", "--no", "--no-install", "--yes"]);
const PNPM_RUNNER_FLAG_OPTIONS = new Set([
  "-c",
  "-s",
  "-w",
  "--shell-mode",
  "--silent",
  "--workspace-root"
]);
const YARN_RUNNER_FLAG_OPTIONS = new Set<string>();
const POSIX_SHELL_FLAG_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  bash: new Set([
    "-a", "-b", "-e", "-f", "-h", "-i", "-k", "-l", "-m", "-n", "-p", "-t", "-u", "-v", "-x",
    "-B", "-C", "-E", "-H", "-P", "-T",
    "--debugger", "--login", "--noediting", "--noprofile", "--norc", "--posix", "--restricted", "--verbose"
  ]),
  dash: new Set(["-a", "-b", "-e", "-f", "-i", "-l", "-m", "-n", "-p", "-u", "-v", "-x"]),
  fish: new Set(["-i", "-l", "-N", "-n", "-P", "--interactive", "--login", "--no-config", "--no-execute", "--private"]),
  ksh: new Set(["-a", "-b", "-e", "-f", "-h", "-i", "-l", "-m", "-n", "-p", "-u", "-v", "-x"]),
  sh: new Set(["-a", "-b", "-e", "-f", "-h", "-i", "-l", "-m", "-n", "-p", "-u", "-v", "-x"]),
  zsh: new Set(["-d", "-f", "-i", "-l", "-m", "-n", "-s", "-t", "-v", "-x"])
};
const POSIX_SHELL_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  bash: new Set(["-c", "-O", "-o", "--init-file", "--rcfile"]),
  dash: new Set(["-c", "-o"]),
  fish: new Set(["-c", "-C", "-d", "-o", "-p", "--command", "--debug", "--debug-output", "--features", "--init-command", "--profile"]),
  ksh: new Set(["-c", "-o"]),
  sh: new Set(["-c", "-o"]),
  zsh: new Set(["-c", "-o"])
};
const POWERSHELL_FLAG_OPTIONS = new Set([
  "-interactive",
  "-login",
  "-mta",
  "-noexit",
  "-nologo",
  "-noninteractive",
  "-noprofile",
  "-noprofileloadtime",
  "-sta"
]);
const POWERSHELL_VALUE_OPTIONS = new Set([
  "-configurationname",
  "-custompipename",
  "-encodedarguments",
  "-encodedcommand",
  "-executionpolicy",
  "-file",
  "-inputformat",
  "-outputformat",
  "-settingsfile",
  "-workingdirectory"
]);
const START_PROCESS_FLAG_PARAMETERS = new Set([
  "-confirm",
  "-loaduserprofile",
  "-nonewwindow",
  "-passthru",
  "-usenewenvironment",
  "-wait",
  "-whatif"
]);
const START_PROCESS_VALUE_PARAMETERS = new Set([
  "-credential",
  "-environment",
  "-redirectstandarderror",
  "-redirectstandardinput",
  "-redirectstandardoutput",
  "-verb",
  "-windowstyle",
  "-workingdirectory"
]);
const NO_WRAPPER_FLAG_OPTIONS = new Set<string>();
const NO_WRAPPER_OPTIONAL_VALUE_OPTIONS = new Map<string, RegExp>();
const NO_WRAPPER_VALUE_OPTIONS = new Set<string>();
const WRAPPER_FLAG_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  command: new Set(["-p", "-v", "-V"]),
  env: new Set(["-i", "-v", "--debug", "--ignore-environment"]),
  exec: new Set(["-c", "-l"]),
  sudo: new Set([
    "-A",
    "-b",
    "-E",
    "-e",
    "-H",
    "-n",
    "-P",
    "-S",
    "--askpass",
    "--background",
    "--edit",
    "--non-interactive",
    "--set-home",
    "--stdin"
  ]),
  stdbuf: new Set<string>(),
  timeout: new Set(["-f", "-p", "-v", "--foreground", "--preserve-status", "--verbose"]),
  time: new Set(["-a", "-p", "-v", "--append", "--portability", "--verbose"]),
  watch: new Set([
    "-b",
    "-e",
    "-g",
    "-p",
    "-t",
    "-w",
    "-x",
    "--beep",
    "--chgexit",
    "--errexit",
    "--exec",
    "--no-title",
    "--no-wrap",
    "--precise"
  ]),
  xargs: new Set([
    "-0",
    "-o",
    "-p",
    "-r",
    "-t",
    "-x",
    "--exit",
    "--interactive",
    "--no-run-if-empty",
    "--null",
    "--open-tty",
    "--verbose"
  ])
};
const WRAPPER_OPTIONAL_VALUE_OPTIONS: Readonly<Record<string, ReadonlyMap<string, RegExp>>> = {
  sudo: new Map([
    ["--preserve-env", /^[A-Za-z_][A-Za-z0-9_]*(?:,[A-Za-z_][A-Za-z0-9_]*)*$/]
  ]),
  watch: new Map([
    ["-d", /^(?:1|permanent)$/],
    ["--differences", /^(?:1|permanent)$/]
  ]),
  xargs: new Map([
    ["-e", /^.*$/],
    ["-i", /^.*$/],
    ["-l", /^[1-9]\d*$/],
    ["--eof", /^.*$/],
    ["--max-lines", /^[1-9]\d*$/],
    ["--replace", /^.*$/]
  ])
};
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-a", "-C", "-P", "-S", "-u", "--argv0", "--chdir", "--split-string", "--unset"]),
  exec: new Set(["-a"]),
  nice: new Set(["-n", "--adjustment"]),
  stdbuf: new Set(["-e", "-i", "-o", "--error", "--input", "--output"]),
  sudo: new Set([
    "-C",
    "-D",
    "-g",
    "-h",
    "-p",
    "-R",
    "-r",
    "-T",
    "-t",
    "-u",
    "--chdir",
    "--chroot",
    "--command-timeout",
    "--group",
    "--host",
    "--prompt",
    "--role",
    "--type",
    "--user"
  ]),
  timeout: new Set(["-k", "-s", "--kill-after", "--signal"]),
  time: new Set(["-f", "-o", "--format", "--output"]),
  watch: new Set(["-n", "--interval"]),
  xargs: new Set([
    "-E",
    "-I",
    "-J",
    "-L",
    "-n",
    "-P",
    "-R",
    "-S",
    "-a",
    "-d",
    "-s",
    "--arg-file",
    "--delimiter",
    "--max-args",
    "--max-chars",
    "--max-procs",
    "--process-slot-var",
  ])
};
const WRAPPER_VALUE_PATTERNS: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  nice: {
    "-n": /^[+-]?\d+$/,
    "--adjustment": /^[+-]?\d+$/
  },
  stdbuf: {
    "-e": /^(?:L|\d+(?:[KMGTPEZYRQ](?:i?B)?)?)$/i,
    "-i": /^\d+(?:[KMGTPEZYRQ](?:i?B)?)?$/i,
    "-o": /^(?:L|\d+(?:[KMGTPEZYRQ](?:i?B)?)?)$/i,
    "--error": /^(?:L|\d+(?:[KMGTPEZYRQ](?:i?B)?)?)$/i,
    "--input": /^\d+(?:[KMGTPEZYRQ](?:i?B)?)?$/i,
    "--output": /^(?:L|\d+(?:[KMGTPEZYRQ](?:i?B)?)?)$/i
  },
  timeout: {
    "-k": TIMEOUT_DURATION_PATTERN,
    "-s": TIMEOUT_SIGNAL_PATTERN,
    "--kill-after": TIMEOUT_DURATION_PATTERN,
    "--signal": TIMEOUT_SIGNAL_PATTERN
  },
  xargs: {
    "-L": /^[1-9]\d*$/,
    "-n": /^[1-9]\d*$/,
    "-P": /^\d+$/,
    "-R": /^[1-9]\d*$/,
    "-S": /^[1-9]\d*$/,
    "-s": /^[1-9]\d*$/,
    "--max-args": /^[1-9]\d*$/,
    "--max-chars": /^[1-9]\d*$/,
    "--max-procs": /^\d+$/
  }
};

interface CommandExample {
  block: boolean;
  contents: string;
  language?: string;
}

interface PhrasingChunk {
  formatted: boolean;
  inlineCode: boolean;
  text: string;
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
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "CHANGELOG.md")
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

function phrasingCommandExamples(
  chunks: PhrasingChunk[],
  allowUnformattedLauncher = false
): CommandExample[] {
  const text = chunks.map((chunk) => chunk.text).join("");
  const spans = chunks.map((chunk, index) => ({
    chunk,
    end: chunks.slice(0, index + 1).reduce((length, item) => length + item.text.length, 0)
  }));
  const launchers = [...text.matchAll(
    /(?<![A-Za-z0-9._~/-])(?:skill-suitcase|\$\{?CLI\}?|dist[\\/]src[\\/]cli\.js)(?=\s|$)/gi
  )];
  const extracted: CommandExample[] = [];

  for (let index = 0; index < launchers.length; index += 1) {
    const launcher = launchers[index];
    if (launcher === undefined) continue;
    const start = launcher.index;
    if (start === undefined) continue;
    const span = spans.find((item) => item.end > start);
    const prefix = text.slice(0, start);
    const commandCue = /(?:^|[\s:])(?:execute|invoke|run|try)\s*$/i.test(prefix);
    if (span === undefined || (!span.chunk.formatted && !commandCue && !allowUnformattedLauncher)) continue;
    if (span.chunk.inlineCode && span.chunk.text.trim() !== launcher[0]) continue;

    const nextLauncher = launchers[index + 1]?.index ?? text.length;
    const tail = text.slice(start, nextLauncher);
    const sentence = tail.match(/\S[.!?](?:\s|$)/);
    const sentenceEnd = sentence?.index === undefined ? tail.length : sentence.index + sentence[0].trimEnd().length;
    const command = tail.slice(0, sentenceEnd).trim();
    const commandName = command.match(/^\S+\s+(\S+)/)?.[1] ?? "";
    if (!PUBLIC_COMMANDS.has(commandName) && !commandCue && !command.includes("--json")) continue;
    extracted.push(...textCommandExamples(command, commandCue));
  }

  return extracted;
}

function htmlPhrasingChunks(node: HtmlNode, formatted = false): PhrasingChunk[] {
  if (node.nodeName === "#text") {
    return [{ formatted, inlineCode: false, text: node.value ?? "" }];
  }
  const tagName = node.tagName?.toLowerCase();
  const classes = node.attrs?.find((attribute) => attribute.name === "class")?.value.split(/\s+/) ?? [];
  const inlineCode = tagName === "code";
  const childFormatted = formatted || inlineCode || classes.includes("cmdline");
  return (node.childNodes ?? []).flatMap((child) => htmlPhrasingChunks(child, childFormatted));
}

function hasNestedHtmlCommandElement(node: HtmlNode): boolean {
  return (node.childNodes ?? []).some((child) => {
    const tagName = child.tagName?.toLowerCase();
    const classes = child.attrs?.find((attribute) => attribute.name === "class")?.value.split(/\s+/) ?? [];
    return tagName === "code" || classes.includes("cmdline") || hasNestedHtmlCommandElement(child);
  });
}

function hasIncompleteNestedHtmlCommandElement(node: HtmlNode): boolean {
  return (node.childNodes ?? []).some((child) => {
    const tagName = child.tagName?.toLowerCase();
    const classes = child.attrs?.find((attribute) => attribute.name === "class")?.value.split(/\s+/) ?? [];
    const commandElement = tagName === "code" || classes.includes("cmdline");
    const text = commandElement ? htmlText(child) : "";
    return (commandElement && hasCliReference(text) && !text.includes("--json"))
      || hasIncompleteNestedHtmlCommandElement(child);
  });
}

function hasNestedHtmlProseElement(node: HtmlNode): boolean {
  return (node.childNodes ?? []).some((child) => {
    const tagName = child.tagName?.toLowerCase();
    return tagName === "pre"
      || (tagName !== undefined && HTML_PROSE_ELEMENTS.has(tagName))
      || hasNestedHtmlProseElement(child);
  });
}

function isHtmlCommandAttribute(attribute: HtmlAttribute): boolean {
  const name = attribute.name.toLowerCase().replace(/^data-/, "");
  return COMMAND_VALUE_KEYS.has(name);
}

function htmlCommandExamples(contents: string, fragment = false): CommandExample[] {
  const root = (fragment ? parseFragment(contents) : parseHtml(contents)) as unknown as HtmlNode;
  const examples: CommandExample[] = [];

  function visit(node: HtmlNode, insidePre: boolean, inheritedLanguage?: string): void {
    const tagName = node.tagName?.toLowerCase();
    if (tagName === "script" || tagName === "style" || tagName === "template") return;
    const classes = node.attrs?.find((attribute) => attribute.name === "class")?.value.split(/\s+/) ?? [];
    const cmdline = classes.includes("cmdline");
    const code = tagName === "code";
    const plainPre = tagName === "pre" && !hasNestedHtmlCommandElement(node);
    const languageClass = classes.find((className) => className.startsWith("language-"));
    const language = languageClass?.slice("language-".length).toLowerCase() ?? inheritedLanguage;

    for (const attribute of node.attrs ?? []) {
      if (isHtmlCommandAttribute(attribute) && hasCliReference(attribute.value)) {
        examples.push({
          block: true,
          contents: attribute.value,
          ...(language === undefined ? {} : { language })
        });
      }
    }

    if (cmdline || code || plainPre) {
      const text = htmlText(node);
      if (hasCliReference(text)) {
        examples.push({
          block: cmdline || plainPre || insidePre,
          contents: text,
          ...(language === undefined ? {} : { language })
        });
      }
      return;
    }

    if (
      tagName !== undefined
      && HTML_PROSE_ELEMENTS.has(tagName)
      && !hasNestedHtmlProseElement(node)
    ) {
      if (!hasNestedHtmlCommandElement(node)) {
        examples.push(...textCommandExamples(htmlText(node)));
        return;
      }
      if (hasIncompleteNestedHtmlCommandElement(node)) {
        const phrasingExamples = phrasingCommandExamples(htmlPhrasingChunks(node), true);
        examples.push(...phrasingExamples);
        if (phrasingExamples.length > 0) return;
      }
    }

    if (!fragment && node.nodeName === "#text") {
      examples.push(...textCommandExamples(node.value ?? ""));
      return;
    }

    for (const child of node.childNodes ?? []) visit(child, insidePre || tagName === "pre", language);
  }

  visit(root, false);
  return examples;
}

function markdownCommandExamples(contents: string): CommandExample[] {
  const root = fromMarkdown(contents) as unknown as MarkdownNode;
  const examples: CommandExample[] = [];

  function inlineChunks(node: MarkdownNode, formatted = false): PhrasingChunk[] {
    if (node.type === "text" || node.type === "inlineCode") {
      return [{
        formatted: formatted || node.type === "inlineCode",
        inlineCode: node.type === "inlineCode",
        text: node.value ?? ""
      }];
    }
    const prose = node.type === "heading" || node.type === "paragraph" || node.type === "tableCell";
    return (node.children ?? []).flatMap((child) => inlineChunks(child, formatted || !prose));
  }

  function proseExamples(node: MarkdownNode): CommandExample[] {
    return phrasingCommandExamples(inlineChunks(node));
  }

  function visit(node: MarkdownNode, proseContents = new Set<string>()): void {
    const prose = node.type === "heading" || node.type === "paragraph" || node.type === "tableCell";
    const extractedProse = prose ? proseExamples(node) : [];
    examples.push(...extractedProse);
    const capturedContents = prose
      ? new Set(extractedProse.map((example) => example.contents))
      : proseContents;
    if (
      (node.type === "code" || node.type === "inlineCode")
      && node.value !== undefined
      && hasCliReference(node.value)
      && !(node.type === "inlineCode" && capturedContents.has(node.value))
    ) {
      const language = node.lang?.toLowerCase();
      const structuredExamples = node.type === "code"
        ? structuredFenceCommandExamples(node.value, language)
        : null;
      examples.push(...(structuredExamples ?? [{
        block: node.type === "code",
        contents: node.value,
        ...(language === undefined ? {} : { language })
      }]));
    }
    if (node.type === "html" && node.value !== undefined && hasCliReference(node.value)) {
      examples.push(...htmlCommandExamples(node.value, true));
    }
    if (
      node.type === "text"
      && node.value !== undefined
      && hasCliReference(node.value)
      && !capturedContents.has(node.value)
    ) {
      examples.push(...textCommandExamples(node.value));
    }
    for (const child of node.children ?? []) visit(child, capturedContents);
  }

  visit(root);
  examples.push(...htmlCommandExamples(contents, true));
  return examples;
}

function structuredFenceCommandExamples(contents: string, language?: string): CommandExample[] | null {
  const languages = (language ?? "")
    .replace(/[{}]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^\./, "").toLowerCase());
  if (languages.some((value) => value === "yaml" || value === "yml")) {
    return structuredCommandExamples(parseYaml(contents) as unknown);
  }
  if (languages.includes("json")) {
    return structuredCommandExamples(JSON.parse(contents) as unknown);
  }
  if (languages.some((value) => value === "javascript" || value === "js" || value === "typescript" || value === "ts")) {
    return javascriptCommandExamples("fenced-example.ts", contents);
  }
  if (languages.includes("css")) return cssCommandExamples(contents);
  return null;
}

function renderArgv(items: string[]): string {
  return items.map((item) => `'${item.replaceAll("'", "'\\''")}'`).join(" ");
}

function argvWords(items: string[]): Word[] {
  return items.map((value) => ({ end: value.length, pos: 0, text: value, value }));
}

function renderStructuredArgv(items: string[]): string {
  const variableReference = items.some((item) => /^\$\{?CLI\}?$/i.test(item));
  assert.ok(
    !variableReference || invocationFromWords(argvWords(items), "posix") === null,
    "structured argv CLI launchers must use a literal executable"
  );
  return renderArgv(items);
}

function structuredCommandExamples(
  value: unknown,
  ownerKey?: string,
  seen = new Set<object>(),
  argvVector = false
): CommandExample[] {
  if (typeof value === "string") {
    return ownerKey !== undefined && COMMAND_VALUE_KEYS.has(ownerKey.toLowerCase()) && hasCliReference(value)
      ? [{ block: true, contents: value }]
      : [];
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    if (
      (argvVector || (ownerKey !== undefined && ARGV_VALUE_KEYS.has(ownerKey.toLowerCase())))
      && value.length > 0
      && value.every((item) => typeof item === "string")
    ) {
      const contents = renderStructuredArgv(value);
      return hasCliReference(contents) ? [{ block: true, contents }] : [];
    }
    return value.flatMap((item) => structuredCommandExamples(
      item,
      ownerKey,
      seen,
      Array.isArray(item) && ownerKey !== undefined && COMMAND_CONTAINER_KEYS.has(ownerKey.toLowerCase())
    ));
  }

  const inheritedOwner = ownerKey !== undefined && COMMAND_VALUE_KEYS.has(ownerKey.toLowerCase())
    ? ownerKey
    : undefined;
  return Object.entries(value).flatMap(([key, item]) => structuredCommandExamples(
    item,
    inheritedOwner !== undefined && (typeof item === "string" || Array.isArray(item)) ? inheritedOwner : key,
    seen,
    Array.isArray(item) && inheritedOwner !== undefined && COMMAND_CONTAINER_KEYS.has(inheritedOwner.toLowerCase())
  ));
}

function textCommandExamples(contents: string, forceCommand = false): CommandExample[] {
  if (!hasCliReference(contents)) return [];
  const lines = contents.split(/\r?\n/);
  const examples: CommandExample[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const source = [lines[index] ?? ""];
    while (posixLineState(source.at(-1) ?? "").continuation && index + 1 < lines.length) {
      index += 1;
      source.push(lines[index] ?? "");
    }
    const command = source.join("\n");
    if (hasCliReference(command) && (forceCommand || !plainTextCliProse(command))) {
      examples.push({ block: false, contents: command });
    }
  }
  return examples;
}

function posixLineState(line: string): { comment: boolean; continuation: boolean } {
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === "\\") {
      if (index === line.length - 1) return { comment: false, continuation: true };
      const escaped = line[index + 1] ?? "";
      if (quote === null || /[$`"\\]/.test(escaped)) index += 1;
      continue;
    }
    if (quote === "\"") {
      if (character === "\"") quote = null;
      continue;
    }
    if (character === "#" && (index === 0 || /[\s;&|()]/.test(line[index - 1] ?? ""))) {
      return { comment: true, continuation: false };
    }
    if (character === "\"" || character === "'") quote = character;
  }
  return { comment: false, continuation: false };
}

function plainTextCliProse(line: string): boolean {
  const trimmed = line.trim();
  const match = trimmed.match(/^skill-suitcase\s+(\S+)\s+(.+)[.!?]$/);
  if (match === null || !PUBLIC_COMMANDS.has(match[1] ?? "")) return false;
  const command = match[1] ?? "";
  const arguments_ = match[2]?.trim().split(/\s+/) ?? [];
  const commandLike = arguments_[0]?.startsWith("-")
    || (command === "upstream"
      && ["check", "fetch", "import"].includes(arguments_[0] ?? "")
      && arguments_[1]?.startsWith("-"));
  if (commandLike) return false;
  return !posixLineState(line).comment && !/\s\.$/.test(trimmed) && !/[;&|`]/.test(line);
}

function javascriptCommandExamples(path: string, contents: string): CommandExample[] {
  const sourceFile = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true);
  const examples = new Set<string>();

  function expressionText(node: ts.Expression): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (!ts.isTemplateExpression(node)) return null;
    let value = node.head.text;
    for (const span of node.templateSpans) {
      if (ts.isIdentifier(span.expression) && span.expression.text.toLowerCase() === "cli") {
        value += `$CLI${span.literal.text}`;
        continue;
      }
      const precedingToken = value
        .trimEnd()
        .replace(/["']$/, "")
        .trimEnd()
        .split(/\s+/)
        .at(-1)
        ?.replace(/=$/, "") ?? "";
      const assignment = /(?:^|[\s;&|])(?:[A-Za-z_][A-Za-z0-9_]*)=[^\s;&|]*$/.test(value.trimEnd());
      if (!CLI_VALUE_FLAGS.has(precedingToken) && !assignment) {
        const literalText = `${node.head.text}${node.templateSpans.map((item) => item.literal.text).join("")}`;
        assert.ok(!hasCliReference(literalText), "unsupported interpolation in CLI command template");
        return null;
      }
      value += `value${span.literal.text}`;
    }
    return value;
  }

  function collectStrings(node: ts.Expression, ownerKey: string): void {
    const text = expressionText(node);
    if (text !== null) {
      if (hasCliReference(text)) examples.add(text);
    } else if (ts.isArrayLiteralExpression(node)) {
      const argv = ARGV_VALUE_KEYS.has(ownerKey)
        ? node.elements.map((element) => expressionText(element))
        : [];
      if (argv.length > 0 && argv.every((item): item is string => item !== null)) {
        const example = renderStructuredArgv(argv);
        if (hasCliReference(example)) examples.add(example);
        return;
      }
      for (const element of node.elements) {
        collectStrings(
          element,
          COMMAND_CONTAINER_KEYS.has(ownerKey) && ts.isArrayLiteralExpression(element) ? "command" : ownerKey
        );
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = propertyName(property.name);
        if (name !== null && COMMAND_VALUE_KEYS.has(name)) {
          collectStrings(property.initializer, name);
        } else if (
          COMMAND_CONTAINER_KEYS.has(ownerKey)
          && (expressionText(property.initializer) !== null
            || ts.isArrayLiteralExpression(property.initializer))
        ) {
          collectStrings(
            property.initializer,
            ts.isArrayLiteralExpression(property.initializer) ? "command" : ownerKey
          );
        }
      }
    }
  }

  function propertyName(node: ts.PropertyName | ts.BindingName): string | null {
    return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text.toLowerCase() : null;
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const name = propertyName(node.name);
      if (name !== null && COMMAND_VALUE_KEYS.has(name)) collectStrings(node.initializer, name);
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name !== null && COMMAND_VALUE_KEYS.has(name)) collectStrings(node.initializer, name);
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

function languageNames(language?: string): string[] {
  return (language ?? "")
    .toLowerCase()
    .replace(/[{}]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^\./, ""));
}

function normalizeInteractiveSource(contents: string, language?: string): string {
  const consoleTranscript = languageNames(language)
    .some((value) => value === "console" || value === "shell-session" || value === "terminal");
  return contents
    .split(/\r?\n/)
    .map((line) => {
      const normalized = line
        .replace(/^\s*\$\s+(?=\S)/, "")
        .replace(/^\s*[^\s@]+@[^\s:]+:[^$]*\$\s+/, "");
      return consoleTranscript ? normalized.replace(/^\s*#\s+(?=\S)/, "") : normalized;
    })
    .join("\n");
}

function shellDialect(language?: string): ShellDialect {
  const languages = languageNames(language);
  if (languages.some((value) => value === "powershell" || value === "ps1" || value === "pwsh")) {
    return "powershell";
  }
  return languages.includes("fish") ? "fish" : "posix";
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
    /^(\s*)&\s+("(?:`.|[^"])*"|'(?:''|[^'])*'|[^\s;&|]+)/,
    (match, indent: string, launcher: string) => {
      const quote = launcher[0];
      const value = (quote === "\"" || quote === "'") && launcher.at(-1) === quote
        ? launcher.slice(1, -1)
        : launcher;
      return isCliExecutable(value, "powershell") || isSourceEntrypoint(value, "powershell")
        ? `${indent}${POWERSHELL_CALL_WRAPPER} ${launcher}`
        : match;
    }
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

function normalizePowershellSource(contents: string, language?: string): string {
  const logicalLines: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  const normalizedContents = normalizePowershellHereStrings(
    normalizeInteractiveSource(contents, language)
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

function normalizeFishSource(contents: string, language?: string): string {
  return normalizeInteractiveSource(contents, language)
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
    ? normalizePowershellSource(example.contents, example.language)
    : dialect === "fish"
      ? normalizeFishSource(example.contents, example.language)
      : normalizeInteractiveSource(example.contents, example.language);
  return source
    .replace(/[\u00a0\u2000-\u200b\u2028\u2029\u202f\u205f\u3000]/g, " ")
    .replace(/<([A-Za-z][^>\s]*)>/g, (placeholder) =>
      OPTIONAL_INVOCATION_PLACEHOLDERS.has(placeholder) ? " ".repeat(placeholder.length) : "x".repeat(placeholder.length)
    );
}

function executableName(value: string, dialect: ShellDialect): string {
  const normalized = dialect === "powershell" ? value.replaceAll("\\", "/") : value;
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
  return dialect === "powershell" ? basename.toLowerCase() : basename;
}

function isCliVariable(value: string, dialect: ShellDialect): boolean {
  return dialect === "powershell"
    ? /^\$\{?cli\}?$/i.test(value)
    : value === "$CLI" || value === "${CLI}";
}

function isCliExecutable(value: string, dialect: ShellDialect): boolean {
  const executable = executableName(value, dialect);
  const normalized = dialect === "powershell" ? executable.replace(/\.(?:cmd|exe|ps1)$/, "") : executable;
  return normalized === "skill-suitcase" || isCliVariable(value, dialect);
}

function isCliPackageSpecifier(value: string, dialect: ShellDialect): boolean {
  const normalized = dialect === "powershell" ? value.toLowerCase() : value;
  return /^skill-suitcase(?:@[^@\s]+)?$/.test(normalized);
}

function isCliPackageReference(value: string): boolean {
  return /^skill-suitcase(?:@[^@\s]+)?$/i.test(value);
}

function isCliLauncherReference(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
  return /^skill-suitcase(?:\.(?:cmd|exe|ps1))?$/i.test(basename)
    || /^\$\{?cli\}?$/i.test(value)
    || /(?:^|\/)dist\/src\/cli\.js$/i.test(normalized);
}

function isSourceEntrypoint(value: string, dialect: ShellDialect): boolean {
  if (isCliVariable(value, dialect)) return true;
  const normalized = dialect === "powershell" ? value.replaceAll("\\", "/").toLowerCase() : value;
  return /(?:^|\/)dist\/src\/cli\.js$/.test(normalized);
}

function nodeEntrypointIndex(words: Word[]): number | null {
  for (let index = 1; index < words.length; index += 1) {
    const token = words[index]?.value ?? "";
    if (token === "--") return index + 1 < words.length ? index + 1 : null;
    if (nodeOptionPreventsCliLaunch(token)) return null;
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
    if (token.length > 2 && NODE_SHORT_VALUE_OPTIONS.has(token.slice(0, 2))) {
      continue;
    }
    if (NODE_RUNTIME_FLAG_OPTIONS.has(token)) continue;
    if (token.startsWith("-")) return null;
    return index;
  }
  return null;
}

function nodeOptionPreventsCliLaunch(token: string): boolean {
  const option = token.split("=", 1)[0] ?? token;
  return /^(?:-[cehipv]|--(?:check|completion-bash|eval|help|interactive|print|run|test|v8-options|version|watch)(?:-|$))/.test(option);
}

function packageRunnerCommandIndex(
  words: Word[],
  start: number,
  runner: string,
  flagOptions: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>
): number | null {
  for (let index = start; index < words.length; index += 1) {
    const token = words[index]?.value ?? "";
    if (token === "--") return index + 1 < words.length ? index + 1 : null;
    if (token.startsWith("-")) {
      assert.ok(
        isSupportedWrapperOption(token, flagOptions, NO_WRAPPER_OPTIONAL_VALUE_OPTIONS, valueOptions),
        `unsupported ${runner} package-runner option: ${token}`
      );
    }
    const valueMode = wrapperOptionValueMode(token, valueOptions);
    if (valueMode === "separate") index += 1;
    if (token.startsWith("-")) continue;
    return index;
  }
  return null;
}

function packageRunnerActionIndex(
  words: Word[],
  runner: string,
  flagOptions: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>
): number | null {
  for (let index = 1; index < words.length; index += 1) {
    const token = words[index]?.value ?? "";
    if (token === "--") return null;
    if (!token.startsWith("-") || token === "-") {
      return token === "dlx" || token === "exec" ? index : null;
    }
    assert.ok(
      isSupportedWrapperOption(token, flagOptions, NO_WRAPPER_OPTIONAL_VALUE_OPTIONS, valueOptions),
      `unsupported ${runner} package-runner option: ${token}`
    );
    if (wrapperOptionValueMode(token, valueOptions) === "separate") {
      assert.ok(words[index + 1] !== undefined, `${runner} package-runner option requires a value: ${token}`);
      index += 1;
    }
  }
  return null;
}

function npmActionIndex(words: Word[]): number | null {
  for (let index = 1; index < words.length; index += 1) {
    const token = words[index]?.value ?? "";
    if (token === "--") return null;
    if (!token.startsWith("-") || token === "-") return index;
    assert.ok(
      isSupportedWrapperOption(
        token,
        NPM_RUNNER_FLAG_OPTIONS,
        NO_WRAPPER_OPTIONAL_VALUE_OPTIONS,
        NPM_EXEC_VALUE_OPTIONS
      ),
      `unsupported npm package-runner option: ${token}`
    );
    if (wrapperOptionValueMode(token, NPM_EXEC_VALUE_OPTIONS) === "separate") {
      assert.ok(words[index + 1] !== undefined, `npm package-runner option requires a value: ${token}`);
      index += 1;
    }
  }
  return null;
}

function npmExecActionIndex(words: Word[]): number | null {
  const action = npmActionIndex(words);
  return action !== null && (words[action]?.value === "exec" || words[action]?.value === "x") ? action : null;
}

function npmExecSeparatorIndex(words: Word[], action: number): number | null {
  let positional = false;
  for (let index = action + 1; index < words.length; index += 1) {
    const token = words[index]?.value ?? "";
    if (token === "--") return positional ? null : index;
    if (!token.startsWith("-") || token === "-") {
      if (isCliLauncherReference(token) || isCliPackageReference(token)) return null;
      positional = true;
      continue;
    }
    assert.ok(
      isSupportedWrapperOption(
        token,
        NPM_RUNNER_FLAG_OPTIONS,
        NO_WRAPPER_OPTIONAL_VALUE_OPTIONS,
        NPM_EXEC_VALUE_OPTIONS
      ),
      `unsupported npm package-runner option: ${token}`
    );
    if (wrapperOptionValueMode(token, NPM_EXEC_VALUE_OPTIONS) === "separate") {
      assert.ok(words[index + 1] !== undefined, `npm package-runner option requires a value: ${token}`);
      index += 1;
    }
  }
  return null;
}

function npmExecPositionalLauncher(words: Word[], action: number): string | null {
  for (let index = action + 1; index < words.length; index += 1) {
    const token = words[index]?.value ?? "";
    if (token === "--") return null;
    if (!token.startsWith("-") || token === "-") return token;
    if (wrapperOptionValueMode(token, NPM_EXEC_VALUE_OPTIONS) === "separate") index += 1;
  }
  return null;
}

function packageRunnerInvocation(words: Word[], dialect: ShellDialect): string[] | null {
  const executable = executableName(words[0]?.value ?? "", dialect);
  const values = words.map((word) => word.value);
  if (!values.some(hasCliReference)) return null;

  if (executable === "npm") {
    const actionIndex = npmActionIndex(words);
    if (actionIndex === null) return null;
    const action = values[actionIndex] ?? "";
    assert.ok(NPM_ACTIONS.has(action), `unsupported npm package-runner action: ${action}`);
    if (action !== "exec" && action !== "x") return null;
    const execIndex = actionIndex;
    const separator = npmExecSeparatorIndex(words, execIndex);
    if (separator === null) return null;
    const launcher = separator + 1;
    const launchValue = values[launcher] ?? "";
    if (isCliExecutable(launchValue, dialect) || isCliPackageSpecifier(launchValue, dialect)) {
      return values.slice(launcher + 1);
    }
    assert.ok(
      !isCliLauncherReference(launchValue) && !isCliPackageReference(launchValue),
      `unsupported CLI package-runner launch form: ${launchValue}`
    );
    return null;
  }

  if (executable === "npx") {
    const launcher = packageRunnerCommandIndex(words, 1, executable, NPX_RUNNER_FLAG_OPTIONS, NPX_VALUE_OPTIONS);
    const launchValue = launcher === null ? "" : values[launcher] ?? "";
    if (launcher !== null && isCliPackageSpecifier(launchValue, dialect)) return values.slice(launcher + 1);
    assert.ok(!isCliPackageReference(launchValue), `unsupported CLI package-runner launch form: ${launchValue}`);
    return null;
  }

  if (executable === "pnpm" || executable === "yarn") {
    const valueOptions = executable === "pnpm" ? PNPM_RUNNER_VALUE_OPTIONS : YARN_RUNNER_VALUE_OPTIONS;
    const flagOptions = executable === "pnpm" ? PNPM_RUNNER_FLAG_OPTIONS : YARN_RUNNER_FLAG_OPTIONS;
    const action = packageRunnerActionIndex(words, executable, flagOptions, valueOptions);
    const launcher = action === null
      ? null
      : packageRunnerCommandIndex(words, action + 1, executable, flagOptions, valueOptions);
    const launchValue = launcher === null ? "" : values[launcher] ?? "";
    const packageLaunch = action !== null
      && values[action] === "dlx"
      && isCliPackageSpecifier(launchValue, dialect);
    if (launcher !== null && (packageLaunch || isCliExecutable(launchValue, dialect))) {
      return values.slice(launcher + 1);
    }
    assert.ok(
      !isCliLauncherReference(launchValue) && !isCliPackageReference(launchValue),
      `unsupported CLI package-runner launch form: ${launchValue}`
    );
    return null;
  }

  return null;
}

function packageRunnerCommandString(
  words: Word[],
  start: number,
  runner: string,
  flagOptions: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>,
  stopAtPositional: boolean
): string | undefined {
  for (let index = start; index < words.length; index += 1) {
    const token = words[index]?.value ?? "";
    if (token === "--") return undefined;
    if (token === "-c" || token === "--call") return words[index + 1]?.value;
    if (token.startsWith("--call=")) return token.slice("--call=".length);
    if (/^-c.+/.test(token)) return token.slice(2);
    if (token.startsWith("-")) {
      assert.ok(
        isSupportedWrapperOption(token, flagOptions, NO_WRAPPER_OPTIONAL_VALUE_OPTIONS, valueOptions),
        `unsupported ${runner} package-runner option: ${token}`
      );
    }
    const valueMode = wrapperOptionValueMode(token, valueOptions);
    if (valueMode === "separate") {
      assert.ok(words[index + 1] !== undefined, `${runner} package-runner option requires a value: ${token}`);
      index += 1;
    }
    if (token.startsWith("-")) continue;
    if (isCliLauncherReference(token) || isCliPackageReference(token)) return undefined;
    if (stopAtPositional) return undefined;
  }
  return undefined;
}

interface WrapperOptionValue {
  mode: "attached" | "separate";
  option: string;
  value?: string;
}

function wrapperOptionValue(token: string, valueOptions: ReadonlySet<string>): WrapperOptionValue | null {
  const equalsIndex = token.indexOf("=");
  const option = equalsIndex < 0 ? token : token.slice(0, equalsIndex);
  if (valueOptions.has(option)) {
    return equalsIndex < 0
      ? { mode: "separate", option }
      : { mode: "attached", option, value: token.slice(equalsIndex + 1) };
  }
  if (!/^-[^-]/.test(token)) return null;
  for (let index = 1; index < token.length; index += 1) {
    const shortOption = `-${token[index] ?? ""}`;
    if (!valueOptions.has(shortOption)) continue;
    const attachedValue = token.slice(index + 1);
    return attachedValue === ""
      ? { mode: "separate", option: shortOption }
      : { mode: "attached", option: shortOption, value: attachedValue.replace(/^=/, "") };
  }
  return null;
}

function wrapperOptionValueMode(token: string, valueOptions: ReadonlySet<string>): "attached" | "separate" | null {
  return wrapperOptionValue(token, valueOptions)?.mode ?? null;
}

function assertWrapperOptionValue(
  executable: string,
  optionValue: WrapperOptionValue,
  separateValue: string | undefined
): void {
  const value = optionValue.mode === "attached" ? optionValue.value : separateValue;
  const pattern = WRAPPER_VALUE_PATTERNS[executable]?.[optionValue.option];
  assert.ok(
    value !== undefined && value !== "" && (pattern === undefined || pattern.test(value)),
    `invalid ${executable} wrapper option value: ${optionValue.option}`
  );
}

function isSupportedWrapperOption(
  token: string,
  flagOptions: ReadonlySet<string>,
  optionalValueOptions: ReadonlyMap<string, RegExp>,
  valueOptions: ReadonlySet<string>
): boolean {
  const equalsIndex = token.indexOf("=");
  const option = equalsIndex < 0 ? token : token.slice(0, equalsIndex);
  if (token.startsWith("--")) {
    const optionalValue = optionalValueOptions.get(option);
    if (optionalValue !== undefined) {
      return equalsIndex < 0 || optionalValue.test(token.slice(equalsIndex + 1));
    }
    return valueOptions.has(option) || (equalsIndex < 0 && flagOptions.has(token));
  }
  if (!/^-[^-]/.test(token)) return false;

  for (let index = 1; index < token.length; index += 1) {
    const shortOption = `-${token[index] ?? ""}`;
    const optionalValue = optionalValueOptions.get(shortOption);
    if (optionalValue !== undefined) {
      if (index === token.length - 1) return true;
      return optionalValue.test(token.slice(index + 1).replace(/^=/, ""));
    }
    if (valueOptions.has(shortOption)) return true;
    if (!flagOptions.has(shortOption)) return false;
  }
  return true;
}

function wrapperCommandIndex(executable: string, words: Word[]): number | null {
  const flagOptions = WRAPPER_FLAG_OPTIONS[executable] ?? NO_WRAPPER_FLAG_OPTIONS;
  const optionalValueOptions = WRAPPER_OPTIONAL_VALUE_OPTIONS[executable] ?? NO_WRAPPER_OPTIONAL_VALUE_OPTIONS;
  const valueOptions = WRAPPER_VALUE_OPTIONS[executable] ?? NO_WRAPPER_VALUE_OPTIONS;
  let index = 1;

  while (index < words.length) {
    const token = words[index]?.value ?? "";
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") break;
    assert.ok(
      isSupportedWrapperOption(token, flagOptions, optionalValueOptions, valueOptions),
      `unsupported ${executable} wrapper option: ${token}`
    );
    const optionValue = wrapperOptionValue(token, valueOptions);
    if (optionValue !== null) assertWrapperOptionValue(executable, optionValue, words[index + 1]?.value);
    index += optionValue?.mode === "separate" ? 2 : 1;
  }

  if (executable === "env" || executable === "sudo") {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.value ?? "")) index += 1;
  }
  if (executable === "timeout") {
    const duration = words[index]?.value;
    assert.ok(duration !== undefined && isTimeoutDuration(duration), `invalid timeout duration: ${duration ?? ""}`);
    index += 1;
  }
  return index < words.length ? index : null;
}

function isTimeoutDuration(value: string): boolean {
  return TIMEOUT_DURATION_PATTERN.test(value);
}

function wrapperPrefixHasOption(
  executable: string,
  words: Word[],
  commandIndex: number | null,
  option: string
): boolean {
  const optionalValueOptions = WRAPPER_OPTIONAL_VALUE_OPTIONS[executable] ?? NO_WRAPPER_OPTIONAL_VALUE_OPTIONS;
  const valueOptions = WRAPPER_VALUE_OPTIONS[executable] ?? NO_WRAPPER_VALUE_OPTIONS;
  const prefixEnd = commandIndex ?? words.length;

  for (let index = 1; index < prefixEnd; index += 1) {
    const token = words[index]?.value ?? "";
    if (option.startsWith("--")) {
      if (token === option) return true;
    } else if (/^-[^-]/.test(token)) {
      for (let character = 1; character < token.length; character += 1) {
        const shortOption = `-${token[character] ?? ""}`;
        if (shortOption === option) return true;
        if (optionalValueOptions.has(shortOption) || valueOptions.has(shortOption)) break;
      }
    }
    if (wrapperOptionValueMode(token, valueOptions) === "separate") index += 1;
  }
  return false;
}

function envSplitStringWords(contents: string): string[] {
  const words: string[] = [];
  let current = "";
  let argumentStarted = false;
  let quote: "\"" | "'" | null = null;

  function append(value: string): void {
    current += value;
    argumentStarted = true;
  }

  function finishWord(): void {
    if (!argumentStarted) return;
    words.push(current);
    current = "";
    argumentStarted = false;
  }

  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index] ?? "";
    if (quote === "'" && character !== "'" && character !== "\\") {
      append(character);
      continue;
    }
    if (character === "'" && quote !== "\"") {
      quote = quote === "'" ? null : "'";
      argumentStarted = true;
      continue;
    }
    if (character === "\"" && quote !== "'") {
      quote = quote === "\"" ? null : "\"";
      argumentStarted = true;
      continue;
    }
    if (character === "\\") {
      const escaped = contents[index + 1];
      assert.ok(escaped !== undefined, "env -S split string ends with an escape");
      if (quote === "'" && escaped !== "'" && escaped !== "\\") {
        append(`\\${escaped}`);
        index += 1;
        continue;
      }
      assert.ok(!(quote === "\"" && escaped === "c"), "env -S split string uses \\c inside double quotes");
      if (escaped === "c") break;
      if (escaped === "_" && quote !== "\"") {
        finishWord();
        index += 1;
        continue;
      }
      const value = ENV_SPLIT_ESCAPE_VALUES[escaped];
      assert.ok(value !== undefined, `unsupported env -S escape: \\${escaped}`);
      if (/\s/.test(value) && quote === null) finishWord();
      else append(value);
      index += 1;
      continue;
    }
    if (character === "$") {
      const expansion = contents.slice(index).match(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}/)?.[0];
      assert.ok(expansion !== undefined, "env -S supports only ${VARNAME} expansion");
      append(expansion === "${CLI}" ? expansion : "value");
      index += expansion.length - 1;
      continue;
    }
    if (quote === null && /[\t\n\v\f\r ]/.test(character)) {
      finishWord();
      continue;
    }
    if (quote === null && character === "#" && !argumentStarted) break;
    append(character);
  }

  assert.equal(quote, null, "env -S split string has an unterminated quote");
  finishWord();
  return words;
}

function expandedEnvSplitWords(words: Word[]): string[] | null {
  const flagOptions = WRAPPER_FLAG_OPTIONS.env ?? NO_WRAPPER_FLAG_OPTIONS;
  const optionalValueOptions = WRAPPER_OPTIONAL_VALUE_OPTIONS.env ?? NO_WRAPPER_OPTIONAL_VALUE_OPTIONS;
  const valueOptions = WRAPPER_VALUE_OPTIONS.env ?? NO_WRAPPER_VALUE_OPTIONS;

  for (let index = 1; index < words.length; index += 1) {
    const token = words[index]?.value ?? "";
    if (token === "--" || !token.startsWith("-") || token === "-") return null;
    assert.ok(
      isSupportedWrapperOption(token, flagOptions, optionalValueOptions, valueOptions),
      `unsupported env wrapper option: ${token}`
    );
    if (token === "-S" || token === "--split-string") {
      const contents = words[index + 1]?.value;
      return contents === undefined
        ? null
        : [
          ...words.slice(0, index).map((word) => word.value),
          ...envSplitStringWords(contents),
          ...words.slice(index + 2).map((word) => word.value)
        ];
    }
    if (token.startsWith("--split-string=")) {
      return [
        ...words.slice(0, index).map((word) => word.value),
        ...envSplitStringWords(token.slice("--split-string=".length)),
        ...words.slice(index + 1).map((word) => word.value)
      ];
    }
    if (/^-[^-]/.test(token)) {
      for (let character = 1; character < token.length; character += 1) {
        const option = `-${token[character] ?? ""}`;
        if (option === "-S") {
          const attachedValue = token.slice(character + 1);
          const contents = attachedValue === "" ? words[index + 1]?.value : attachedValue;
          if (contents === undefined) return null;
          const retainedOptions = token.slice(0, character);
          const trailingIndex = attachedValue === "" ? index + 2 : index + 1;
          return [
            ...words.slice(0, index).map((word) => word.value),
            ...(retainedOptions === "-" ? [] : [retainedOptions]),
            ...envSplitStringWords(contents),
            ...words.slice(trailingIndex).map((word) => word.value)
          ];
        }
        if (valueOptions.has(option)) break;
      }
    }
    if (wrapperOptionValueMode(token, valueOptions) === "separate") index += 1;
  }
  return null;
}

function wrappedCommandWords(executable: string, words: Word[]): Word[] | null {
  if (!EXECUTION_WRAPPERS.has(executable)) return null;
  if (executable === "env" && expandedEnvSplitWords(words) !== null) return null;
  const commandIndex = wrapperCommandIndex(executable, words);
  if (
    executable === "command"
    && (wrapperPrefixHasOption(executable, words, commandIndex, "-v")
      || wrapperPrefixHasOption(executable, words, commandIndex, "-V"))
  ) return null;
  if (
    executable === "sudo"
    && (wrapperPrefixHasOption(executable, words, commandIndex, "-e")
      || wrapperPrefixHasOption(executable, words, commandIndex, "--edit"))
  ) return null;
  return commandIndex === null ? null : words.slice(commandIndex);
}

function invocationFromWords(
  words: Word[],
  dialect: ShellDialect,
  powershellCallOperator = false
): string[] | null {
  const first = words[0]?.value;
  if (first === undefined) return null;
  if (isCliExecutable(first, dialect) || isSourceEntrypoint(first, dialect)) {
    const variableLauncher = isCliVariable(first, dialect);
    const quotedLauncher = /^(?:"[\s\S]*"|'[\s\S]*')$/.test(words[0]?.text ?? "");
    if (dialect === "powershell" && (variableLauncher || quotedLauncher) && !powershellCallOperator) {
      if (words[1]?.value === "=" || words.length === 1) return null;
      assert.fail("PowerShell variable and quoted CLI launchers require the call operator: & $CLI");
    }
    return words.slice(1).map((word) => word.value);
  }
  assert.ok(!isCliLauncherReference(first), `unsupported CLI launch form: ${first}`);

  const executable = executableName(first, dialect);
  if (executable === POWERSHELL_CALL_WRAPPER) {
    return invocationFromWords(words.slice(1), dialect, true);
  }
  if (executable === "node" || executable === "node.exe") {
    const entrypoint = nodeEntrypointIndex(words);
    return entrypoint !== null && isSourceEntrypoint(words[entrypoint]?.value ?? "", dialect)
      ? words.slice(entrypoint + 1).map((word) => word.value)
      : null;
  }

  const packageInvocation = packageRunnerInvocation(words, dialect);
  if (packageInvocation !== null) return packageInvocation;

  const wrappedWords = wrappedCommandWords(executable, words);
  return wrappedWords === null
    ? null
    : invocationFromWords(wrappedWords, dialect, dialect === "powershell");
}

function powershellStartProcessExample(words: Word[]): CommandExample[] {
  const suffix = words.slice(1);
  let launcherIndex: number | null = null;
  let argumentListOption: number | null = null;
  let positionalArgumentStart: number | null = null;

  for (let index = 0; index < suffix.length; index += 1) {
    const token = suffix[index]?.value ?? "";
    const parameter = token.toLowerCase();
    if (parameter === "-filepath") {
      assert.ok(suffix[index + 1] !== undefined, "Start-Process -FilePath requires a value");
      assert.equal(launcherIndex, null, "Start-Process defines FilePath more than once");
      launcherIndex = index + 1;
      index += 1;
      continue;
    }
    if (parameter === "-argumentlist" || parameter === "-args") {
      argumentListOption = index;
      while (
        index + 1 < suffix.length
        && !(suffix[index + 1]?.text === suffix[index + 1]?.value && /^-[A-Za-z]/.test(suffix[index + 1]?.value ?? ""))
      ) index += 1;
      continue;
    }
    if (START_PROCESS_FLAG_PARAMETERS.has(parameter)) continue;
    if (START_PROCESS_VALUE_PARAMETERS.has(parameter)) {
      assert.ok(suffix[index + 1] !== undefined, `Start-Process parameter requires a value: ${token}`);
      index += 1;
      continue;
    }
    if (token.startsWith("-")) assert.fail(`unsupported Start-Process parameter: ${token}`);
    if (launcherIndex === null) launcherIndex = index;
    else if (argumentListOption === null && positionalArgumentStart === null) positionalArgumentStart = index;
  }

  if (launcherIndex === null) return [];
  const launcher = suffix[launcherIndex]?.value ?? "";
  if (!isCliExecutable(launcher, "powershell") && !isSourceEntrypoint(launcher, "powershell")) return [];

  const argumentStart = argumentListOption === null ? positionalArgumentStart : argumentListOption + 1;
  const nextOption = argumentStart === null
    ? -1
    : suffix.slice(argumentStart)
      .findIndex((word) => word.text === word.value && /^-[A-Za-z]/.test(word.value));
  const argumentWords = argumentStart === null
    ? []
    : suffix.slice(argumentStart, nextOption < 0 ? suffix.length : argumentStart + nextOption);
  const argumentsSource = argumentWords
    .map((word) => word.value.replace(/,$/, ""))
    .join(" ");
  return [{
    block: true,
    contents: `${POWERSHELL_CALL_WRAPPER} ${renderArgv([launcher])}${argumentsSource === "" ? "" : ` ${argumentsSource}`}`,
    language: "powershell"
  }];
}

function powershellCommandString(name: string, suffix: Word[]): string | undefined {
  for (let index = 0; index < suffix.length; index += 1) {
    const token = suffix[index]?.value ?? "";
    const option = token.toLowerCase();
    if (option === "-c" || option === "-command") {
      return suffix.slice(index + 1).map((word) => word.value).join(" ") || undefined;
    }
    if (!token.startsWith("-") || token === "--") return undefined;
    assert.ok(
      POWERSHELL_FLAG_OPTIONS.has(option) || POWERSHELL_VALUE_OPTIONS.has(option),
      `unsupported ${name} shell option: ${token}`
    );
    if (POWERSHELL_VALUE_OPTIONS.has(option)) {
      assert.ok(suffix[index + 1] !== undefined, `${name} shell option requires a value: ${token}`);
      index += 1;
    }
  }
  return undefined;
}

function posixShellCommandString(name: string, suffix: Word[]): string | undefined {
  const flagOptions = POSIX_SHELL_FLAG_OPTIONS[name] ?? NO_WRAPPER_FLAG_OPTIONS;
  const valueOptions = POSIX_SHELL_VALUE_OPTIONS[name] ?? NO_WRAPPER_VALUE_OPTIONS;
  for (let index = 0; index < suffix.length; index += 1) {
    const token = suffix[index]?.value ?? "";
    if (token === "--" || !token.startsWith("-") || token === "-") return undefined;
    if (token.startsWith("--")) {
      const equalsIndex = token.indexOf("=");
      const option = equalsIndex < 0 ? token : token.slice(0, equalsIndex);
      assert.ok(flagOptions.has(token) || valueOptions.has(option), `unsupported ${name} shell option: ${token}`);
      if (option === "--command") {
        return equalsIndex < 0 ? suffix[index + 1]?.value : token.slice(equalsIndex + 1);
      }
      if (valueOptions.has(option) && equalsIndex < 0) {
        assert.ok(suffix[index + 1] !== undefined, `${name} shell option requires a value: ${token}`);
        index += 1;
      }
      continue;
    }
    if (valueOptions.has(token) && token !== "-c") {
      assert.ok(suffix[index + 1] !== undefined, `${name} shell option requires a value: ${token}`);
      index += 1;
      continue;
    }

    let command = false;
    for (let character = 1; character < token.length; character += 1) {
      const option = `-${token[character] ?? ""}`;
      if (option === "-c") command = true;
      else assert.ok(flagOptions.has(option), `unsupported ${name} shell option: ${option}`);
    }
    if (command) {
      assert.ok(suffix[index + 1] !== undefined, `${name} shell option requires a command: ${token}`);
      return suffix[index + 1]?.value;
    }
  }
  return undefined;
}

function cmdCommandIndex(suffix: Word[]): number | null {
  for (let index = 0; index < suffix.length; index += 1) {
    const token = suffix[index]?.value ?? "";
    if (!token.startsWith("/")) return null;
    const options = token.split("/").filter(Boolean).map((option) => `/${option.toLowerCase()}`);
    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      const option = options[optionIndex] ?? "";
      if (option === "/c" || option === "/k") {
        assert.equal(optionIndex, options.length - 1, `unsupported cmd shell option: ${token}`);
        return index;
      }
      assert.ok(
        CMD_FLAG_OPTIONS.has(option) || /^\/[efv]:(?:on|off)$/.test(option),
        `unsupported cmd shell option: ${token}`
      );
    }
  }
  return null;
}

function nestedCommandExamplesFromWords(words: Word[], inheritedLanguage?: string): CommandExample[] {
  const dialect = shellDialect(inheritedLanguage);
  const name = executableName(words[0]?.value ?? "", dialect);
  const suffix = words.slice(1);
  if (!words.some((word) => hasCliReference(word.value))) return [];

  if (dialect === "powershell" && name === "start-process") {
    return powershellStartProcessExample(words);
  }

  if (SHELL_EXECUTORS.has(name)) {
    const powershell = name === "powershell" || name === "powershell.exe" || name === "pwsh" || name === "pwsh.exe";
    const contents = powershell
      ? powershellCommandString(name, suffix)
      : posixShellCommandString(name, suffix);
    if (contents === undefined) return [];
    const language = name === "fish"
      ? "fish"
      : powershell
        ? "powershell"
        : "sh";
    return [{ block: true, contents, language }];
  }

  if (name === "cmd" || name === "cmd.exe") {
    const option = cmdCommandIndex(suffix);
    return option !== null
      ? [{ block: true, contents: suffix.slice(option + 1).map((word) => word.value).join(" ") }]
      : [];
  }

  if (name === "npm" || name === "npx") {
    const action = name === "npm" ? npmExecActionIndex(words) : null;
    const start = name === "npm" ? (action ?? -1) : 0;
    const valueOptions = name === "npx" ? NPX_VALUE_OPTIONS : NPM_EXEC_VALUE_OPTIONS;
    const flagOptions = name === "npx" ? NPX_RUNNER_FLAG_OPTIONS : NPM_RUNNER_FLAG_OPTIONS;
    const contents = (name === "npx" || action !== null)
      ? packageRunnerCommandString(suffix, start, name, flagOptions, valueOptions, name === "npx")
      : undefined;
    if (contents !== undefined) {
      return [{
        block: true,
        contents,
        ...(inheritedLanguage === undefined ? {} : { language: inheritedLanguage })
      }];
    }
  }

  if (name === "pnpm") {
    const actionIndex = packageRunnerActionIndex(
      words,
      name,
      PNPM_RUNNER_FLAG_OPTIONS,
      PNPM_RUNNER_VALUE_OPTIONS
    );
    const action = actionIndex === null ? -1 : actionIndex - 1;
    const leadingShellMode = action < 0
      ? -1
      : suffix.slice(0, action).findIndex((word) => word.value === "-c" || word.value === "--shell-mode");
    let shellMode = leadingShellMode;
    for (let index = action + 1; action >= 0 && index < suffix.length; index += 1) {
      const token = suffix[index]?.value ?? "";
      if (token === "--") break;
      if (token === "-c" || token === "--shell-mode") {
        shellMode = index;
        break;
      }
      const valueMode = wrapperOptionValueMode(token, PNPM_RUNNER_VALUE_OPTIONS);
      if (valueMode === "separate") index += 1;
      if (!token.startsWith("-")) break;
    }
    const commandStart = leadingShellMode >= 0
      ? packageRunnerCommandIndex(
        suffix,
        action + 1,
        name,
        PNPM_RUNNER_FLAG_OPTIONS,
        PNPM_RUNNER_VALUE_OPTIONS
      )
      : shellMode + 1;
    if (shellMode >= 0 && commandStart !== null && suffix[commandStart] !== undefined) {
      return [{
        block: true,
        contents: suffix.slice(commandStart).map((word) => word.value).join(" "),
        ...(inheritedLanguage === undefined ? {} : { language: inheritedLanguage })
      }];
    }
  }

  if (name === "find") {
    const examples: CommandExample[] = [];
    let searchFrom = 0;
    while (searchFrom < suffix.length) {
      const relativeOption = suffix.slice(searchFrom)
        .findIndex((word) => word.value === "-exec" || word.value === "-execdir");
      if (relativeOption < 0) break;
      const option = searchFrom + relativeOption;
      const relativeTerminator = suffix.slice(option + 1)
        .findIndex((word) => word.value === ";" || word.value === "+");
      assert.ok(relativeTerminator >= 0, "find -exec requires a terminator");
      const terminator = option + 1 + relativeTerminator;
      const executionWords = suffix.slice(option + 1, terminator);
      if (executionWords.length > 0) {
        examples.push({
          block: true,
          contents: renderArgv(executionWords.map((word) => word.value)),
          ...(inheritedLanguage === undefined ? {} : { language: inheritedLanguage })
        });
      }
      searchFrom = terminator + 1;
    }
    return examples;
  }

  if (name === "env") {
    const expandedWords = expandedEnvSplitWords(words);
    if (expandedWords !== null) {
      return [{
        block: true,
        contents: renderArgv(expandedWords),
        ...(inheritedLanguage === undefined ? {} : { language: inheritedLanguage })
      }];
    }
  }

  if (name === "eval" && dialect !== "powershell" && suffix.length > 0) {
    return [{
      block: true,
      contents: suffix.map((word) => word.value).join(" "),
      ...(inheritedLanguage === undefined ? {} : { language: inheritedLanguage })
    }];
  }

  const wrappedWords = wrappedCommandWords(name, words);
  return wrappedWords === null
    ? []
    : nestedCommandExamplesFromWords(wrappedWords, inheritedLanguage);
}

function nestedCommandExamples(command: Command, inheritedLanguage?: string): CommandExample[] {
  return nestedCommandExamplesFromWords(commandWords(command), inheritedLanguage);
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

function isClassifiedCliReferenceContext(executable: string, dialect: ShellDialect): boolean {
  return EXECUTION_WRAPPERS.has(executable)
    || SHELL_EXECUTORS.has(executable)
    || CLI_REFERENCE_DATA_COMMANDS.has(executable)
    || ["cmd", "cmd.exe", "find", "node", "node.exe", "npm", "npx", "pnpm", "yarn"].includes(executable)
    || (dialect !== "powershell" && executable === "eval")
    || (dialect === "powershell" && executable === "start-process")
    || executable === POWERSHELL_CALL_WRAPPER;
}

function validateCommandExample(path: string, example: CommandExample): number {
  const commands = parseCommandExample(path, example);
  const dialect = shellDialect(example.language);
  let invocationCount = 0;

  for (const command of commands) {
    for (const nested of nestedCommandExamples(command, example.language)) {
      if (hasCliReference(nested.contents)) invocationCount += validateCommandExample(path, nested);
    }

    const words = commandWords(command);
    const invocation = invocationFromWords(words, dialect);
    if (invocation !== null) {
      if (!example.block && invocation.length === 0) continue;
      validateInvocation(path, invocation);
      invocationCount += 1;
      continue;
    }

    const executable = executableName(words[0]?.value ?? "", dialect);
    const npmExecAction = executable === "npm" ? npmExecActionIndex(words) : null;
    const npmLauncher = npmExecAction === null ? null : npmExecPositionalLauncher(words, npmExecAction);
    assert.ok(
      npmLauncher === null
        || (!isCliExecutable(npmLauncher, dialect) && !isCliPackageSpecifier(npmLauncher, dialect)),
      `${path} npm exec CLI examples must use -- before skill-suitcase`
    );
    const unsupportedNodeLaunch = (executable === "node" || executable === "node.exe")
      && words.some((word) => hasCliReference(word.value));
    assert.ok(!unsupportedNodeLaunch, `${path} has an unsupported Node CLI launch form`);
    const launcherArgument = words.slice(1).findIndex((word) => isCliLauncherReference(word.value));
    const unsupportedWrapper = words[1]?.value !== "="
      && !isClassifiedCliReferenceContext(executable, dialect)
      && launcherArgument >= 0
      && launcherArgument + 2 < words.length;
    assert.ok(!unsupportedWrapper, `${path} has unsupported execution wrapper: ${executable}`);
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
  const normalizedContents = `${contents}\n${decodedDocumentText(contents)}`
    .replace(/\\{2,}/g, "\\")
    .replaceAll("\\/", "/");
  const localPathContents = normalizedContents.replace(/\bhttps?:\/\/[^\s`"'<>]+/gi, "");
  assert.doesNotMatch(localPathContents, /\/Users\/[^/\\\s`"']+/, `${path} contains a macOS user path`);
  assert.doesNotMatch(localPathContents, /\/home\/[^/\\\s`"']+/, `${path} contains a Linux user path`);
  assert.doesNotMatch(
    localPathContents,
    /(?:^|[^A-Za-z0-9._~/-]|file:\/{2,}|\/)\/root(?=[^A-Za-z0-9_-]|$)/m,
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

test("generated changelog is excluded from current documentation contracts", () => {
  const documents = publicDocumentPaths();
  assert.ok(documents.includes("README.md"));
  assert.ok(!documents.includes("CHANGELOG.md"));
});

test("private machine path checks cover portable and private forms", () => {
  for (const privatePath of [
    "`/Users/alice`",
    "`/home/alice`",
    "Use /root.",
    "file:///root/project",
    "//root/project",
    "C:/Users/alice/project",
    "C:\\Users\\alice",
    "/mnt/c/Users/alice/project",
    "/c/Users/alice/project",
    "~alice/project",
    String.raw`\\server\Users\alice\project`,
    String.raw`C:&#92;Users&#92;alice&#92;project`,
    String.raw`C:&bsol;Users&bsol;alice&bsol;project`,
    "<file:///Users/alice/project>",
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
    ["fixture.md", "skill-suitcase bogus --json"],
    ["fixture.md", "    skill-suitcase bogus --json"],
    ["fixture.md", "<code>skill-suitcase&#32;bogus --json</code>"],
    ["fixture.md", "```yaml\ncommand: skill-suitcase bogus --json\n```"],
    ["fixture.html", "<pre>skill-suitcase bogus --json</pre>"],
    ["fixture.html", "<pre><code>skill-suitcase&nbsp;bogus --json</code></pre>"],
    ["fixture.html", "<span class=\"cmdline\">skill-suitcase bogus --json</span>"],
    ["fixture.html", "<p>skill-suitcase bogus --json</p>"],
    ["fixture.html", "<div><span>skill-suitcase</span> bogus --json</div>"],
    ["fixture.html", "<button data-command=\"skill-suitcase bogus --json\">Run</button>"],
    ["fixture.yaml", "command: skill-suitcase bogus --json"],
    ["fixture.yaml", "command: [skill-suitcase, bogus, --json]"],
    ["fixture.yaml", "commands:\n  - skill-suitcase bogus --json"],
    ["fixture.yaml", "commands: { smoke: skill-suitcase bogus --json }"],
    ["fixture.yaml", "commands: { smoke: [skill-suitcase, bogus, --json] }"],
    ["fixture.json", "{\"commands\":[\"skill-suitcase bogus --json\"]}"],
    ["fixture.json", "{\"command\":[\"skill-suitcase\",\"bogus\",\"--json\"]}"],
    ["fixture.json", "{\"commands\":{\"smoke\":\"skill-suitcase bogus --json\"}}"],
    ["fixture.json", "{\"commands\":{\"smoke\":[\"skill-suitcase\",\"bogus\",\"--json\"]}}"],
    ["fixture.js", "const commands = ['echo ok', 'skill-suitcase bogus --json'];"],
    ["fixture.js", "const commands = { smoke: 'skill-suitcase bogus --json' };"],
    ["fixture.js", "const commands = { smoke: ['skill-suitcase', 'bogus', '--json'] };"],
    ["fixture.js", "const command = ['skill-suitcase', 'bogus', '--json'];"],
    ["fixture.js", "const command = `skill-suitcase bogus --source ${root} --json`;"],
    ["fixture.js", "const command = `skill-suitcase bogus --source ${root} --skill ${skill} --json`;"],
    ["fixture.js", "const command = `skill-suitcase bogus --source=${root} --json`;"],
    ["fixture.js", "const command = `skill-suitcase bogus --source \"${root}\" --json`;"],
    ["fixture.js", "const command = `${CLI} bogus --json`;"],
    ["fixture.css", ":root { --example: 'skill-suitcase bogus --json'; }"],
    ["fixture.txt", "skill-suitcase bogus --json"]
  ] as const;
  for (const [path, contents] of invalidFixtures) {
    assert.throws(() => validateCliExamples(path, contents), /unknown command: bogus/, `${path}: ${contents}`);
  }

  assert.equal(validateCliExamples("fixture.md", "The `skill-suitcase` binary reads `skill-suitcase.yaml`."), 0);
  assert.equal(validateCliExamples("fixture.yaml", "description: Run skill-suitcase bogus --json"), 0);
  assert.equal(
    validateCliExamples("fixture.yaml", "commands:\n  smoke:\n    description: Run skill-suitcase bogus --json"),
    0
  );
  assert.equal(validateCliExamples("fixture.json", "{\"description\":\"Run skill-suitcase bogus --json\"}"), 0);
  assert.equal(validateCliExamples("fixture.js", "const description = 'Run skill-suitcase bogus --json';"), 0);
  assert.equal(
    validateCliExamples(
      "fixture.js",
      "const commands = { smoke: { description: 'Run skill-suitcase bogus --json' } };"
    ),
    0
  );
  assert.equal(validateCliExamples("fixture.css", ":root { --description: 'Run skill-suitcase bogus --json'; }"), 0);
  assert.equal(validateCliExamples("fixture.txt", "skill-suitcase"), 0);
  assert.equal(validateCliExamples("fixture.txt", "skill-suitcase status reports target state."), 0);
  assert.equal(validateCliExamples("fixture.txt", "skill-suitcase status requires --source and --json."), 0);
  assert.equal(validateCliExamples("fixture.html", "<p>skill-suitcase status --source . --json</p>"), 1);
  assert.equal(validateCliExamples("fixture.html", "<p>skill-suitcase status reports target state.</p>"), 0);
  assert.equal(
    validateCliExamples(
      "fixture.txt",
      "skill-suitcase status reports target state.\nskill-suitcase status --source . --json"
    ),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.txt",
      "skill-suitcase status \\\n  --source . \\\n  --json"
    ),
    1
  );
  assert.throws(
    () => validateCliExamples("fixture.txt", "skill-suitcase status --source . # Show status."),
    /without --json/
  );
  assert.equal(validateCliExamples("fixture.yaml", "command: >\n  skill-suitcase status --source .\n  --json"), 1);
  assert.equal(validateCliExamples(
    "fixture.yaml",
    "command: [skill-suitcase, status, --source, ., --json]"
  ), 1);
  assert.equal(validateCliExamples(
    "fixture.json",
    "{\"command\":[\"skill-suitcase\",\"status\",\"--source\",\".\",\"--json\"]}"
  ), 1);
  assert.equal(validateCliExamples(
    "fixture.js",
    "const command = ['skill-suitcase', 'status', '--source', '.', '--json'];"
  ), 1);
  assert.equal(validateCliExamples(
    "fixture.js",
    "const command = `skill-suitcase status --source ${root} --json`;"
  ), 1);
  assert.equal(validateCliExamples(
    "fixture.js",
    "const command = `skill-suitcase upstream fetch --source ${root} --skill ${skill} --dry-run --json`;"
  ), 1);
  assert.equal(validateCliExamples(
    "fixture.js",
    "const command = `ROOT=\"${root}\" skill-suitcase status --source . --json`;"
  ), 1);
  assert.equal(validateCliExamples(
    "fixture.yaml",
    "commands: { smoke: [skill-suitcase, status, --source, ., --json] }"
  ), 1);
  assert.equal(validateCliExamples(
    "fixture.json",
    "{\"commands\":{\"smoke\":[\"skill-suitcase\",\"status\",\"--source\",\".\",\"--json\"]}}"
  ), 1);
  assert.equal(validateCliExamples(
    "fixture.js",
    "const commands = { smoke: ['skill-suitcase', 'status', '--source', '.', '--json'] };"
  ), 1);

  for (const [path, contents] of [
    ["fixture.yaml", "command: [$CLI, status, --source, ., --json]"],
    ["fixture.yaml", "command: [env, $CLI, status, --source, ., --json]"],
    ["fixture.json", "{\"command\":[\"$CLI\",\"status\",\"--source\",\".\",\"--json\"]}"],
    ["fixture.js", "const command = ['$CLI', 'status', '--source', '.', '--json'];"]
  ] as const) {
    assert.throws(
      () => validateCliExamples(path, contents),
      /structured argv CLI launchers must use a literal executable/,
      `${path}: ${contents}`
    );
  }
  assert.equal(validateCliExamples("fixture.yaml", "command: [echo, $CLI]"), 0);
});

test("documentation parsers reject fragmented and malformed CLI launches", async (t) => {
  await t.test("unformatted Markdown command cue", () => {
    assert.throws(
      () => validateCliExamples("fixture.md", "Run skill-suitcase bogus --json"),
      /unknown command: bogus/
    );
  });

  await t.test("cue-prefixed known Markdown command", () => {
    assert.throws(
      () => validateCliExamples(
        "fixture.md",
        "Run skill-suitcase status ignored --not-a-real-flag --json."
      ),
      /without --json|invalid CLI invocation/
    );
  });

  await t.test("HTML prose with inline command markup", () => {
    assert.throws(
      () => validateCliExamples(
        "fixture.html",
        "<p>Run <code>skill-suitcase</code> bogus --json</p>"
      ),
      /unknown command: bogus/
    );
  });

  await t.test("punctuated plain-text command", () => {
    assert.throws(
      () => validateCliExamples(
        "fixture.txt",
        "skill-suitcase status --source . --not-a-real-flag --json."
      ),
      /without --json/
    );
  });

  await t.test("formatted Markdown launcher", () => {
    for (const source of [
      "Run **skill-suitcase** bogus",
      "Run **skill-suitcase** bogus --json",
      "Run **skill-suitcase** bogus --source . --json"
    ]) {
      assert.throws(
        () => validateCliExamples("fixture.md", source),
        /unknown command: bogus/
      );
    }
  });

  await t.test("inline Markdown command count", () => {
    for (const source of [
      "`skill-suitcase status --source . --json`",
      "Use **skill-suitcase** to run commands such as `skill-suitcase status --source . --json`."
    ]) {
      assert.equal(validateCliExamples("fixture.md", source), 1, source);
    }
  });

  await t.test("JavaScript template assignment", () => {
    assert.throws(
      () => validateCliExamples("fixture.js", "const command = `ROOT=${root} skill-suitcase bogus --json`;"),
      /unknown command: bogus/
    );
  });

  await t.test("pnpm option value", () => {
    assert.throws(
      () => validateCliExamples(
        "fixture.md",
        markdownFixture("pnpm --reporter exec dlx skill-suitcase bogus --json")
      ),
      /unknown command: bogus/
    );
  });

  await t.test("cmd option prefix", () => {
    assert.throws(
      () => validateCliExamples(
        "fixture.md",
        markdownFixture("cmd /not-a-real-switch /c skill-suitcase status --source . --json")
      ),
      /unsupported cmd shell option: \/not-a-real-switch/
    );
  });

  await t.test("find exec terminator", () => {
    assert.throws(
      () => validateCliExamples(
        "fixture.md",
        markdownFixture("find . -exec skill-suitcase status --source . --json")
      ),
      /find -exec requires a terminator/
    );
  });
});

test("console prompt normalization validates root prompt commands", () => {
  for (const language of ["console", "shell-session"]) {
    assert.throws(
      () => validateCliExamples("fixture.md", markdownFixture("# skill-suitcase bogus --json", language)),
      /unknown command: bogus/,
      language
    );
  }

  assert.equal(validateCliExamples("fixture.md", markdownFixture("# skill-suitcase bogus --json", "sh")), 0);
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
    "./dist/src/cli.js bogus --json",
    "env -i skill-suitcase bogus --json",
    "env -S 'skill-suitcase bogus --json'",
    "env -S '${CLI} bogus --json'",
    "env --split-string='skill-suitcase bogus --json'",
    "env -vS'skill-suitcase bogus --json'",
    "env -vS 'skill-suitcase bogus --json'",
    "env -vS'-i skill-suitcase bogus --json'",
    "env --split-string='skill-suitcase bogus' --json",
    "env -S 'HOME=/tmp skill-suitcase bogus --json'",
    "sudo -Eu root skill-suitcase bogus --json",
    "sudo HOME=/tmp skill-suitcase bogus --json",
    "sudo -E command -- skill-suitcase bogus --json",
    "command -p skill-suitcase bogus --json -v",
    "nohup skill-suitcase bogus --json",
    "nice -n 5 skill-suitcase bogus --json",
    "timeout -sTERM 30 skill-suitcase bogus --json",
    "watch skill-suitcase bogus --json",
    "xargs -n1 skill-suitcase bogus --json",
    "stdbuf -oL skill-suitcase bogus --json",
    "/usr/local/bin/skill-suitcase bogus --json",
    "node dist/src/cli.js bogus --json",
    "\"$CLI\" bogus --json",
    "npx skill-suitcase bogus --json",
    "npx --cache /tmp skill-suitcase bogus --json",
    "npx -c 'skill-suitcase bogus --json'",
    "npx skill-suitcase@latest bogus --json",
    "npm exec --call='skill-suitcase bogus --json'",
    "npm exec -p --call='skill-suitcase bogus --json'",
    "npm exec --prefix /tmp --call='skill-suitcase bogus --json'",
    "npm exec cowsay --call='skill-suitcase bogus --json'",
    "npm exec --package=skill-suitcase -- skill-suitcase bogus --json",
    "pnpm dlx skill-suitcase bogus --json",
    "pnpm dlx -w skill-suitcase bogus --json",
    "pnpm dlx -c 'skill-suitcase bogus --json'",
    "pnpm -c dlx 'skill-suitcase bogus --json'",
    "pnpm -c exec 'skill-suitcase bogus --json'",
    "pnpm -c dlx --package skill-suitcase 'skill-suitcase bogus --json'",
    "pnpm dlx skill-suitcase@latest bogus --json",
    "yarn dlx skill-suitcase@latest bogus --json",
    "sh -c 'skill-suitcase bogus --json'",
    "eval 'skill-suitcase bogus --json'",
    "exec sh -c 'skill-suitcase bogus --json'",
    "cmd /c skill-suitcase bogus --json",
    "find . -exec skill-suitcase bogus --json \\;",
    "find . -exec echo {} \\; -exec skill-suitcase bogus --json \\;",
    "not skill-suitcase bogus --json"
  ];
  for (const source of invalidLaunchers) {
    assert.throws(
      () => validateCliExamples("fixture.md", markdownFixture(source)),
      /unknown command: bogus/,
      source
    );
  }

  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("xargs -n -t skill-suitcase status --source . --json")
    ),
    /invalid xargs wrapper option value: -n/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("xargs --max-args= skill-suitcase status --source . --json")
    ),
    /invalid xargs wrapper option value: --max-args/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("stdbuf --definitely-invalid skill-suitcase status --source . --json")
    ),
    /unsupported stdbuf wrapper option: --definitely-invalid/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("env --definitely-invalid skill-suitcase status --source . --json")
    ),
    /unsupported env wrapper option: --definitely-invalid/
  );
  for (const option of ["-0", "--null"]) {
    assert.throws(
      () => validateCliExamples(
        "fixture.md",
        markdownFixture(`env ${option} skill-suitcase status --source . --json`)
      ),
      new RegExp(`unsupported env wrapper option: ${option}`)
    );
  }
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("env -S 'skill-suitcase\\_bogus --json'")
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("env -S 'skill-suitcase status --source . --json >out'")
    ),
    /invalid CLI invocation/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("pnpm dlx --definitely-invalid ignored skill-suitcase bogus --json")
    ),
    /unsupported pnpm package-runner option: --definitely-invalid/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("npx --definitely-invalid ignored skill-suitcase status --source . --json")
    ),
    /unsupported npx package-runner option: --definitely-invalid/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("pnpm --definitely-invalid ignored dlx skill-suitcase status --source . --json")
    ),
    /unsupported pnpm package-runner option: --definitely-invalid/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("timeout -v skill-suitcase status --source . --json")
    ),
    /invalid timeout duration: skill-suitcase/
  );
  for (const source of [
    "timeout -k -v 5 skill-suitcase status --source . --json",
    "timeout --kill-after=-v 5 skill-suitcase status --source . --json",
    "timeout -s -v 5 skill-suitcase status --source . --json",
    "timeout --signal=-v 5 skill-suitcase status --source . --json"
  ]) {
    assert.throws(
      () => validateCliExamples("fixture.md", markdownFixture(source)),
      /invalid timeout wrapper option value/,
      source
    );
  }
  for (const source of [
    "setsid skill-suitcase bogus --json",
    "setsid \"skill-suitcase\" bogus --json"
  ]) {
    assert.throws(
      () => validateCliExamples("fixture.md", markdownFixture(source)),
      /unsupported execution wrapper: setsid/,
      source
    );
  }
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("command --definitely-invalid -v skill-suitcase")
    ),
    /unsupported command wrapper option: --definitely-invalid/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("sudo --definitely-invalid -e skill-suitcase")
    ),
    /unsupported sudo wrapper option: --definitely-invalid/
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("env -i -u HOME skill-suitcase status --source . --json")
    ),
    1
  );
  for (const source of [
    "env -P /tmp skill-suitcase status --source . --json",
    "env --split-string 'skill-suitcase status --source . --json'",
    "env --split-string='skill-suitcase status --source . --json'",
    "env -S 'ROOT=${ROOT} skill-suitcase\\_status --source . --json'",
    "env -S '${CLI} status --source . --json'",
    "env -S 'skill-suitcase\\tstatus --source . --json\\c ignored'",
    "env -vS'skill-suitcase status --source . --json'",
    "env -vS 'skill-suitcase status --source . --json'",
    "env --split-string='skill-suitcase status' --source . --json",
    "sudo --preserve-env=HOME,PATH skill-suitcase status --source . --json",
    "timeout -f -p 5 skill-suitcase status --source . --json",
    "timeout 0.5s skill-suitcase status --source . --json",
    "timeout -v 5 skill-suitcase status --source . --json",
    "timeout -k 1s -s TERM 5 skill-suitcase status --source . --json",
    "timeout --kill-after=1m --signal=9 5 skill-suitcase status --source . --json",
    "watch -d1 skill-suitcase status --source . --json",
    "watch --differences=permanent skill-suitcase status --source . --json",
    "xargs -n 1 skill-suitcase status --source . --json",
    "xargs -tn1 skill-suitcase status --source . --json",
    "xargs -l1 skill-suitcase status --source . --json",
    "xargs --max-lines skill-suitcase status --source . --json",
    "xargs --max-lines=1 skill-suitcase status --source . --json",
    "stdbuf -oL skill-suitcase status --source . --json",
    "stdbuf --output=L skill-suitcase status --source . --json",
    "stdbuf --output=1MiB skill-suitcase status --source . --json",
    "cmd /d /s /c skill-suitcase status --source . --json"
  ]) {
    assert.equal(validateCliExamples("fixture.md", markdownFixture(source)), 1, source);
  }
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("watch --differences=sometimes skill-suitcase status --source . --json")
    ),
    /unsupported watch wrapper option: --differences=sometimes/
  );

  assert.equal(validateCliExamples("fixture.md", markdownFixture("node \"$CLI\" status --source . --json")), 1);
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("node --no-warnings --enable-source-maps dist/src/cli.js status --source . --json")
    ),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("node -r./bootstrap.cjs dist/src/cli.js status --source . --json")
    ),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("exec sh -c 'skill-suitcase status --source . --json'")
    ),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("find . -exec echo skill-suitcase bogus --json \\;")
    ),
    0
  );
  for (const source of [
    "npx --yes skill-suitcase status --source . --json",
    "pnpm dlx --silent skill-suitcase status --source . --json",
    "npx -c 'skill-suitcase status --source . --json'",
    "npm exec --call='skill-suitcase status --source . --json'",
    "pnpm dlx -c 'skill-suitcase status --source . --json'",
    "pnpm -c dlx 'skill-suitcase status --source . --json'",
    "pnpm -c exec 'skill-suitcase status --source . --json'",
    "pnpm -c dlx --package skill-suitcase 'skill-suitcase status --source . --json'"
  ]) {
    assert.equal(validateCliExamples("fixture.md", markdownFixture(source)), 1, source);
  }
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("eval 'skill-suitcase status --source . --json'")
    ),
    1
  );
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
  assert.equal(validateCliExamples("fixture.md", markdownFixture("npm exec cowsay -- skill-suitcase bogus --json")), 0);
  assert.equal(validateCliExamples("fixture.md", markdownFixture("npm run exec -- skill-suitcase bogus --json")), 0);
  assert.equal(validateCliExamples("fixture.md", markdownFixture("npx cowsay -- skill-suitcase bogus --json")), 0);
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("npx cowsay --call='skill-suitcase status --source . --json'")
    ),
    0
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("pnpm dlx cowsay -- -c 'skill-suitcase status --source . --json'")
    ),
    0
  );
  assert.equal(validateCliExamples("fixture.md", markdownFixture("xargs -n1 echo skill-suitcase bogus --json")), 0);
  assert.equal(validateCliExamples("fixture.md", markdownFixture("command -v skill-suitcase || true")), 0);
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("env -S='skill-suitcase status --source . --json'")
    ),
    0
  );
  assert.equal(validateCliExamples("fixture.md", markdownFixture("printf '%s\\n' 'skill-suitcase bogus --json'")), 0);
  assert.throws(
    () => validateCliExamples("fixture.md", markdownFixture("npm exec skill-suitcase bogus --json")),
    /must use -- before skill-suitcase/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("npm bogus exec -- skill-suitcase status --source . --json")
    ),
    /unsupported npm package-runner action: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("npm --definitely-invalid exec -- skill-suitcase status --source . --json")
    ),
    /unsupported npm package-runner option: --definitely-invalid/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("bash --definitely-invalid -c 'skill-suitcase status --source . --json'")
    ),
    /unsupported bash shell option: --definitely-invalid/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("bash -cQ 'skill-suitcase status --source . --json'")
    ),
    /unsupported bash shell option: -Q/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("pwsh -DefinitelyInvalid -Command skill-suitcase status --source . --json", "powershell")
    ),
    /unsupported pwsh shell option: -DefinitelyInvalid/
  );
  for (const [source, language] of [
    ["bash --noprofile -lc 'skill-suitcase status --source . --json'", "sh"],
    ["bash -cl 'skill-suitcase status --source . --json'", "sh"],
    ["fish --no-config --command 'skill-suitcase status --source . --json'", "fish"],
    ["pwsh -NoProfile -WorkingDirectory . -Command skill-suitcase status --source . --json", "powershell"]
  ] as const) {
    assert.equal(validateCliExamples("fixture.md", markdownFixture(source, language)), 1, source);
  }
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("npm --prefix . exec -- skill-suitcase status --source . --json")
    ),
    1
  );
  for (const source of [
    "Skill-Suitcase status --source . --json",
    "skill-suitcase.cmd status --source . --json",
    "sudo Skill-Suitcase status --source . --json",
    "npx Skill-Suitcase@latest status --source . --json"
  ]) {
    assert.throws(
      () => validateCliExamples("fixture.md", markdownFixture(source)),
      /unsupported CLI (?:package-runner )?launch form/,
      source
    );
  }
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
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("PS C:\\repo> skill-suitcase bogus --json", "{.powershell}")
    ),
    /unknown command: bogus/
  );
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
    ["pwsh -Command skill-suitcase bogus --json", "powershell"],
    ["fish -c 'if not skill-suitcase bogus --json'", "fish"]
  ] as const) {
    assert.throws(
      () => validateCliExamples("fixture.md", markdownFixture(source, language)),
      /unknown command: bogus/,
      source
    );
  }
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture("pwsh -Command skill-suitcase status --source . --json", "powershell")
    ),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture(
        String.raw`Start-Process -FilePath 'C:\tools\Skill-Suitcase.cmd' -ArgumentList 'status', '--source', '.', '--json'`,
        "powershell"
      )
    ),
    1
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("Start-Process skill-suitcase -ArgumentList 'bogus --json'", "powershell")
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture(
        "Start-Process -WorkingDirectory . skill-suitcase -ArgumentList 'bogus --json'",
        "powershell"
      )
    ),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("Start-Process -WorkingDirectory . skill-suitcase 'bogus --json'", "powershell")
    ),
    /unknown command: bogus/
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture(
        "Start-Process -FilePath skill-suitcase -ArgumentList 'status --source . --json' -Wait",
        "powershell"
      )
    ),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture(
        "Start-Process -WorkingDirectory . skill-suitcase -ArgumentList 'status --source . --json' -Wait",
        "powershell"
      )
    ),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture(
        "Start-Process -WorkingDirectory . skill-suitcase 'status --source . --json' -Wait",
        "powershell"
      )
    ),
    1
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("$CLI status --source . --json", "powershell")
    ),
    /PowerShell variable and quoted CLI launchers require the call operator/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture("Write-Host ready; $CLI status --source . --json", "powershell")
    ),
    /PowerShell variable and quoted CLI launchers require the call operator/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      markdownFixture('"skill-suitcase" status --source . --json', "powershell")
    ),
    /PowerShell variable and quoted CLI launchers require the call operator/
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
      markdownFixture('& "skill-suitcase" status --source . --json', "powershell")
    ),
    1
  );
  assert.equal(
    validateCliExamples(
      "fixture.md",
      markdownFixture(String.raw`& "C:\Program Files\skill-suitcase.cmd" status --source . --json`, "powershell")
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
      markdownFixture("$command = 'skill-suitcase status --source . --json'", "powershell")
    ),
    0
  );
  assert.equal(
    validateCliExamples("fixture.md", markdownFixture("$command = 'skill-suitcase'", "powershell")),
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
