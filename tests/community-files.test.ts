import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const COMMUNITY_FILES = [
  "CONTRIBUTING.md",
  "DEVELOPING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CODE_OF_CONDUCT.md",
  "CLAUDE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/support_question.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/PULL_REQUEST_TEMPLATE.md"
];

const PRIVATE_LOCAL_IDENTIFIERS = [
  /\/Users\//,
  /C:\\Users\\/i,
  /\/home\/(?!\$|<)/,
  /orca\/workspaces/i,
  /linear\.app/i
];

test("public repository shell includes contributor and community files", async () => {
  for (const file of COMMUNITY_FILES) {
    const content = await readFile(file, "utf8");
    assert.ok(content.trim().length > 0, `${file} should not be empty`);
  }
});

test("public contributor and community files avoid private local identifiers", async () => {
  for (const file of COMMUNITY_FILES) {
    const content = await readFile(file, "utf8");
    for (const pattern of PRIVATE_LOCAL_IDENTIFIERS) {
      assert.doesNotMatch(content, pattern, `${file} should not contain ${pattern}`);
    }
  }
});

test("security and support guidance route sensitive reports away from public issues", async () => {
  const security = (await readFile("SECURITY.md", "utf8")).toLowerCase();
  const support = (await readFile("SUPPORT.md", "utf8")).toLowerCase();
  const codeOfConduct = (await readFile("CODE_OF_CONDUCT.md", "utf8")).toLowerCase();

  assert.ok(security.includes("do not open a public issue"));
  assert.ok(security.includes("private vulnerability reporting"));
  assert.ok(support.includes("security.md"));
  assert.ok(support.includes("not through the public issue tracker"));
  assert.ok(support.includes("support question"));
  assert.ok(codeOfConduct.includes("reporting-abuse-or-spam"));
  assert.ok(codeOfConduct.includes("outside the control of project maintainers"));
});
