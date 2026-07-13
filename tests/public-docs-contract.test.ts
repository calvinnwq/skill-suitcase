import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createCommandRegistry, parseCommandArgs } from "../src/commands/index.js";

const PUBLIC_DOC_ROOTS = ["docs", "skills", "examples"];
const TEXT_DOCUMENT_EXTENSIONS = [".css", ".html", ".js", ".json", ".md", ".yaml", ".yml"];
const PUBLIC_COMMANDS: ReadonlySet<string> = new Set(createCommandRegistry().names());
const SHELL_COMMAND_PREFIXES = new Set(["$", "!", "command", "do", "elif", "env", "if", "sudo", "then", "until", "while"]);
const SHELL_FENCE_LANGUAGES = new Set([
  "bash",
  "console",
  "fish",
  "powershell",
  "pwsh",
  "sh",
  "shell",
  "shell-session",
  "zsh"
]);
const SHELL_SUBSTITUTION_PLACEHOLDER = "__shell_command_substitution__";

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

function markdownShellBlocks(contents: string): string[] {
  const blocks: string[] = [];
  const lines = contents.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index]?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^\r]*)$/);
    if (opening === undefined || opening === null) continue;

    const fence = opening[1] ?? "";
    const info = (opening[2] ?? "").trim();
    const pandocLanguage = info.match(/^\{\.?([A-Za-z0-9_-]+)\}/)?.[1];
    const language = (pandocLanguage ?? info.split(/\s+/, 1)[0] ?? "").toLowerCase();
    const isShellBlock = SHELL_FENCE_LANGUAGES.has(language);

    const blockStart = index + 1;
    for (index = blockStart; index < lines.length; index += 1) {
      const closing = lines[index]?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (closing === undefined || closing[0] !== fence[0] || closing.length < fence.length) continue;
      if (isShellBlock) blocks.push(lines.slice(blockStart, index).join("\n"));
      break;
    }
  }

  return blocks;
}

function commandExamples(path: string, contents: string): string[] {
  const markdownBlocks = markdownShellBlocks(contents);
  const htmlBlocks = [...contents.matchAll(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi)]
    .map((match) => decodeHtml(match[1] ?? ""));
  const htmlCommandLines = [...contents.matchAll(/<span\b([^>]*)>/g)]
    .filter((match) => {
      const classAttribute = (match[1] ?? "").match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/);
      const classNames = classAttribute?.[1] ?? classAttribute?.[2] ?? "";
      return classNames.split(/\s+/).includes("cmdline");
    })
    .map((match) => {
      const contentStart = (match.index ?? 0) + match[0].length;
      const contentEnd = contents.indexOf("</span>", contentStart);
      return decodeHtml(contentEnd < 0 ? contents.slice(contentStart) : contents.slice(contentStart, contentEnd));
    });
  return path.endsWith(".html") ? [...htmlBlocks, ...htmlCommandLines] : markdownBlocks;
}

function shellSegments(line: string): string[] {
  const segments: string[] = [];
  collectShellSegments(line, segments);
  return segments;
}

function collectShellSegments(
  source: string,
  segments: string[],
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
    if (character === "\\" && quote !== "'") {
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
      } else if (character === "$" && source[index + 1] === "(") {
        segment += SHELL_SUBSTITUTION_PLACEHOLDER;
        index = collectShellSegments(source, segments, index + 2, ")");
      } else if (character === "`") {
        segment += SHELL_SUBSTITUTION_PLACEHOLDER;
        index = collectShellSegments(source, segments, index + 1, "`");
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
    if (character === "$" && source[index + 1] === "(") {
      segment += SHELL_SUBSTITUTION_PLACEHOLDER;
      index = collectShellSegments(source, segments, index + 2, ")");
      continue;
    }
    if (character === "`") {
      segment += SHELL_SUBSTITUTION_PLACEHOLDER;
      index = collectShellSegments(source, segments, index + 1, "`");
      continue;
    }
    if (character === "#" && (index === 0 || /[\s;&|()]/.test(source[index - 1] ?? ""))) {
      finishSegment();
      return source.length;
    }
    if (character === "(") {
      finishSegment();
      index = collectShellSegments(source, segments, index + 1, ")");
      continue;
    }
    if (character === ")" || character === ";" || character === "|" || character === "&") {
      finishSegment();
      if ((character === "|" || character === "&") && source[index + 1] === character) index += 1;
      continue;
    }
    segment += character;
  }

  finishSegment();
  return source.length;
}

function shellTokens(segment: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  function finishToken(): void {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  }

  for (const character of segment) {
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      finishToken();
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (escaped) token += "\\";
  finishToken();
  return tokens;
}

function isShellCommandPrefix(token: string): boolean {
  return SHELL_COMMAND_PREFIXES.has(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function executableName(token: string): string {
  return token.replaceAll("\\", "/").split("/").at(-1) ?? token;
}

function isSkillSuitcaseExecutable(token: string, allowPackageVersion = false): boolean {
  const name = executableName(token);
  return name === "skill-suitcase" || (allowPackageVersion && /^skill-suitcase@[^/]+$/.test(name));
}

function skillSuitcaseExecutableIndex(tokens: string[]): number {
  let index = 0;
  while (isShellCommandPrefix(tokens[index] ?? "")) index += 1;

  const candidate = tokens[index];
  if (candidate === undefined) return -1;
  if (isSkillSuitcaseExecutable(candidate)) return index;

  const wrapper = executableName(candidate);
  if (wrapper === "npx" || wrapper === "bunx") {
    index += 1;
    while (["--", "--quiet", "--yes", "-q", "-y"].includes(tokens[index] ?? "")) index += 1;
    return isSkillSuitcaseExecutable(tokens[index] ?? "", true) ? index : -1;
  }

  const action = tokens[index + 1];
  if ((wrapper === "npm" && action === "exec")
    || ((wrapper === "pnpm" || wrapper === "yarn") && (action === "dlx" || action === "exec"))) {
    index += 2;
    if (tokens[index] === "--") index += 1;
    return isSkillSuitcaseExecutable(tokens[index] ?? "", true) ? index : -1;
  }

  return -1;
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

  for (const block of commandExamples(path, contents)) {
    const logicalLines = block.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/);
    for (const line of logicalLines) {
      for (const segment of shellSegments(line)) {
        const tokens = shellTokens(segment);
        const executableIndex = skillSuitcaseExecutableIndex(tokens);
        if (executableIndex < 0) continue;

        invocationCount += 1;
        const invocation = tokens.slice(executableIndex);
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
        try {
          parseCommandArgs(invocation.slice(1));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          assert.fail(`${path} has an invalid CLI invocation: ${invocation.join(" ")} (${message})`);
        }
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
  assert.doesNotMatch(localPathContents, /[A-Z]:[\\/]Users[\\/][^\\/\s`"']+/i, `${path} contains a Windows user path`);
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
    String.raw`{"path":"C:\\Users\\alice\\project"}`
  ]) {
    assert.throws(() => assertNoPrivateMachinePaths("fixture.md", privatePath), /contains a .* user path/);
  }

  assert.doesNotThrow(() => assertNoPrivateMachinePaths(
    "fixture.md",
    "See /target/root/project, https://docs.example.com/home/alice/setup, and https://docs.example.com/root/project."
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
      "```sh\nskill-suitcase status --json | skill-suitcase validate\n```"
    ),
    /CLI example without --json: skill-suitcase validate/
  );
  assert.throws(
    () => validateCliExamples(
      "fixture.md",
      "```sh\nskill-suitcase status --json | skill-suitcase bogus --json\n```"
    ),
    /unknown command: bogus/
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
});

test("CLI example parsing covers common shell fence forms", () => {
  for (const fixture of [
    "~~~bash\nskill-suitcase bogus --json\n~~~",
    "```console\n$ skill-suitcase bogus --json\n```",
    '```bash title="demo"\nskill-suitcase bogus --json\n```',
    "```shell-session\n$ skill-suitcase bogus --json\n```",
    "```zsh\nskill-suitcase bogus --json\n```",
    "```fish\nskill-suitcase bogus --json\n```",
    "```pwsh\nskill-suitcase bogus --json\n```",
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
});

test("CLI example parsing recognizes wrappers and path-qualified executables", () => {
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\nnpx skill-suitcase bogus --json\n```"),
    /unknown command: bogus/
  );
  assert.throws(
    () => validateCliExamples("fixture.md", "```sh\n/usr/local/bin/skill-suitcase bogus --json\n```"),
    /unknown command: bogus/
  );
  assert.equal(
    validateCliExamples("fixture.md", "```sh\nnpx skill-suitcase status --json\n```"),
    1
  );
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
});
