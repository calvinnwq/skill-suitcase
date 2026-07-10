import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const REQUIRED_COMMUNITY_FILES = [
  "LICENSE",
  "CONTRIBUTING.md",
  "DEVELOPING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CODE_OF_CONDUCT.md",
  "CLAUDE.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/config.yml"
] as const;

const PORTABLE_COMMUNITY_FILES = [
  "CONTRIBUTING.md",
  "DEVELOPING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CODE_OF_CONDUCT.md",
  "CLAUDE.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml"
] as const;

test("repository includes its public community and contributor files", async () => {
  await Promise.all(REQUIRED_COMMUNITY_FILES.map((file) => access(file)));
});

test("community guidance does not contain contributor-specific local paths", async () => {
  const contents = await Promise.all(
    PORTABLE_COMMUNITY_FILES.map(async (file) => ({ file, text: await readFile(file, "utf8") }))
  );

  for (const { file, text } of contents) {
    assert.doesNotMatch(text, /\/Users\/[^/\s]+\//, `${file} should not contain a macOS user path`);
    assert.doesNotMatch(text, /\/home\/[^/\s]+\//, `${file} should not contain a Linux user path`);
    assert.doesNotMatch(text, /[A-Z]:\\Users\\[^\\\s]+\\/i, `${file} should not contain a Windows user path`);
  }
});

test("issue forms route public support and private security reports", async () => {
  const config = await readFile(".github/ISSUE_TEMPLATE/config.yml", "utf8");
  const bugReport = await readFile(".github/ISSUE_TEMPLATE/bug_report.yml", "utf8");

  assert.match(config, /blank_issues_enabled: false/);
  assert.match(config, /SUPPORT\.md/);
  assert.match(config, /SECURITY\.md/);
  assert.match(bugReport, /not a security vulnerability/i);
});
