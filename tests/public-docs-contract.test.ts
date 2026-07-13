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

function commandCodeBlocks(path: string, contents: string): string[] {
  const markdownBlocks = [...contents.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)\n```/g)]
    .map((match) => match[1] ?? "");
  const htmlBlocks = [...contents.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)]
    .map((match) => decodeHtml(match[1] ?? ""));
  return path.endsWith(".html") ? htmlBlocks : markdownBlocks;
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
    for (const block of commandCodeBlocks(path, contents)) {
      const logicalLines = block.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/);
      for (const line of logicalLines) {
        const matches = [...line.matchAll(
          /(?:^|&&|\|\||;)\s*skill-suitcase\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g
        )];
        for (const [index, match] of matches.entries()) {
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
          const invocationStart = match.index ?? 0;
          const invocationEnd = matches[index + 1]?.index ?? line.length;
          const invocation = line.slice(invocationStart, invocationEnd).replace(/(?:&&|\|\||;)\s*$/, "");
          assert.match(
            invocation,
            /(?:^|\s)--json(?:\s|$)/,
            `${path} has a CLI example without --json: ${invocation.trim()}`
          );
        }
      }
    }
  }

  assert.ok(invocationCount > 0, "public documentation must contain checked CLI examples");
});
