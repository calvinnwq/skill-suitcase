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
  const issueConfig = await readFile(".github/ISSUE_TEMPLATE/config.yml", "utf8");

  assert.ok(security.includes("do not open a public issue"));
  assert.match(security, /mailto:[^\s)]+\?subject=skill%20suitcase%20security%20report/i);
  assert.ok(support.includes("security.md"));
  assert.ok(support.includes("not through the public issue tracker"));
  assert.ok(support.includes("support question"));
  assert.match(codeOfConduct, /mailto:[^\s)]+\?subject=skill%20suitcase%20conduct%20report/i);
  assert.ok(codeOfConduct.includes("reporting-abuse-or-spam"));
  assert.ok(codeOfConduct.includes("outside the control of project maintainers"));
  assert.ok(issueConfig.includes("blob/main/SECURITY.md"));
  assert.ok(!issueConfig.includes("security/advisories/new"));
});

test("development setup pins pnpm across the supported Node.js range", async () => {
  const developing = await readFile("DEVELOPING.md", "utf8");
  const install = await readFile("INSTALL.md", "utf8");
  const operatorSkill = await readFile("skills/skill-suitcase/SKILL.md", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    packageManager?: string;
  };
  const workflows = await Promise.all(
    [".github/workflows/ci.yml", ".github/workflows/release-please.yml"].map((file) =>
      readFile(file, "utf8")
    )
  );

  assert.equal(packageJson.packageManager, "pnpm@10.34.4");
  for (const guide of [developing, install, operatorSkill]) {
    const pinnedRunner = guide.indexOf("npm exec --yes --package=pnpm@10.34.4 -- pnpm");
    const versionCheck = guide.indexOf('test "$(pnpm --version)" = "10.34.4"');
    const frozenInstall = guide.indexOf("pnpm install --frozen-lockfile");

    assert.ok(pinnedRunner >= 0 && pinnedRunner < versionCheck);
    assert.ok(versionCheck < frozenInstall);
    assert.ok(guide.includes('test "$(pnpm --version)" = "10.34.4"'));
    assert.ok(!guide.includes("corepack@latest"));
    assert.ok(!guide.includes("npm install --global corepack"));
    assert.doesNotMatch(guide, /npm install --global(?: --force)? pnpm@/);
  }
  assert.match(
    operatorSkill,
    /pnpm\(\) \{[\s\S]+npm exec --yes --package=pnpm@10\.34\.4 -- pnpm "\$@"[\s\S]+test "\$\(pnpm --version\)" = "10\.34\.4" \\[\s\S]+&& pnpm install --frozen-lockfile/
  );
  for (const workflow of workflows) {
    assert.ok(workflow.includes("pnpm/action-setup@v6"));
    assert.ok(!workflow.includes("version: latest"));
  }
});
