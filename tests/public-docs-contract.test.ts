import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const PUBLIC_DOC_ROOTS = ["docs", "skills", "examples"];
const TEXT_DOCUMENT_EXTENSIONS = [".css", ".html", ".js", ".json", ".md", ".yaml", ".yml"];
const PUBLIC_COMMANDS = new Set([
  "apply",
  "diff",
  "import",
  "import-target",
  "pack",
  "plan",
  "promote",
  "prune",
  "reconcile",
  "repair",
  "rollback",
  "status",
  "targets",
  "track",
  "upstream",
  "validate"
]);
const UPSTREAM_SUBCOMMANDS = new Set(["check", "fetch", "import"]);

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

function commandExamples(path: string, contents: string): string[] {
  const markdownBlocks = [...contents.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)\n```/g)]
    .map((match) => match[1] ?? "");
  const htmlBlocks = [...contents.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)]
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

function validateCliExamples(path: string, contents: string): number {
  let invocationCount = 0;

  for (const block of commandExamples(path, contents)) {
    const logicalLines = block.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/);
    for (const line of logicalLines) {
      for (const segment of line.split(/&&|\|\||[;|]/)) {
        const match = segment.match(/^\s*skill-suitcase\s+([^\s;&|]+)(?:\s+([^\s;&|]+))?/);
        if (!match) continue;

        invocationCount += 1;
        const command = match[1] ?? "";
        const possibleSubcommand = match[2];
        assert.ok(PUBLIC_COMMANDS.has(command), `${path} documents unknown command: ${command}`);
        if (command === "upstream") {
          assert.ok(
            possibleSubcommand && UPSTREAM_SUBCOMMANDS.has(possibleSubcommand),
            `${path} documents unknown upstream command: ${possibleSubcommand ?? "<missing>"}`
          );
        }
        assert.match(
          segment,
          /(?:^|\s)--json(?:\s|$)/,
          `${path} has a CLI example without --json: ${segment.trim()}`
        );
      }
    }
  }

  return invocationCount;
}

test("public and reusable docs contain no contributor-specific machine paths", () => {
  const documents = publicDocumentPaths();
  assert.ok(documents.length > 0, "public documentation inventory must not be empty");

  for (const path of documents) {
    const contents = readFileSync(path, "utf8");
    assert.doesNotMatch(contents, /\/Users\/[^/\s]+\//, `${path} contains a macOS user path`);
    assert.doesNotMatch(contents, /\/home\/[^/\s]+\//, `${path} contains a Linux user path`);
    assert.doesNotMatch(contents, /[A-Z]:\\Users\\[^\\\s]+\\/i, `${path} contains a Windows user path`);
  }
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
});

test("HTML command examples include visible cmdline elements", () => {
  assert.throws(
    () => validateCliExamples(
      "fixture.html",
      '<span class="what"><span class="example cmdline">skill-suitcase bogus --json</span>Details.</span>'
    ),
    /unknown command: bogus/
  );
});
