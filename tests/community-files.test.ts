import assert from "node:assert/strict";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { test } from "node:test";
import { parseDocument } from "yaml";

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
  ".github/ISSUE_TEMPLATE/support_request.yml",
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
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/support_request.yml"
] as const;

const PACKAGED_COMMUNITY_FILES = [
  "CONTRIBUTING.md",
  "DEVELOPING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CODE_OF_CONDUCT.md",
  "CLAUDE.md"
] as const;

const COMMUNITY_MARKDOWN_FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "DEVELOPING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CODE_OF_CONDUCT.md",
  "CLAUDE.md",
  ".github/PULL_REQUEST_TEMPLATE.md"
] as const;

type UnknownRecord = Record<string, unknown>;

const REPOSITORY_ROOT = resolve(".");

function expectRecord(value: unknown, context: string): UnknownRecord {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${context} must be an object`);
  return value as UnknownRecord;
}

function expectString(value: unknown, context: string): string {
  assert.equal(typeof value, "string", `${context} must be a string`);
  assert.notEqual((value as string).trim(), "", `${context} must not be empty`);
  return value as string;
}

function expectArray(value: unknown, context: string): unknown[] {
  assert.ok(Array.isArray(value), `${context} must be an array`);
  return value;
}

async function readYaml(file: string): Promise<UnknownRecord> {
  const document = parseDocument(await readFile(file, "utf8"), { uniqueKeys: true });
  assert.deepEqual(
    document.errors.map((error) => error.message),
    [],
    `${file} must contain valid YAML`
  );
  return expectRecord(document.toJS(), file);
}

function validateIssueForm(file: string, form: UnknownRecord): UnknownRecord[] {
  expectString(form.name, `${file}.name`);
  expectString(form.description, `${file}.description`);
  expectString(form.title, `${file}.title`);

  const labels = expectArray(form.labels, `${file}.labels`);
  assert.ok(labels.length > 0, `${file}.labels must not be empty`);
  for (const [index, label] of labels.entries()) {
    expectString(label, `${file}.labels[${index}]`);
  }

  const body = expectArray(form.body, `${file}.body`).map((item, index) =>
    expectRecord(item, `${file}.body[${index}]`)
  );
  assert.ok(body.length > 0, `${file}.body must not be empty`);

  const ids = new Set<string>();
  for (const [index, item] of body.entries()) {
    const context = `${file}.body[${index}]`;
    const type = expectString(item.type, `${context}.type`);
    assert.ok(
      ["markdown", "input", "textarea", "dropdown", "checkboxes"].includes(type),
      `${context}.type is not supported by GitHub issue forms`
    );
    const attributes = expectRecord(item.attributes, `${context}.attributes`);

    if (type === "markdown") {
      expectString(attributes.value, `${context}.attributes.value`);
      continue;
    }

    const id = expectString(item.id, `${context}.id`);
    assert.match(id, /^[A-Za-z0-9_-]+$/, `${context}.id contains unsupported characters`);
    assert.ok(!ids.has(id), `${file} contains duplicate field id ${id}`);
    ids.add(id);
    expectString(attributes.label, `${context}.attributes.label`);

    if (item.validations !== undefined) {
      const validations = expectRecord(item.validations, `${context}.validations`);
      assert.equal(typeof validations.required, "boolean", `${context}.validations.required must be a boolean`);
    }

    if (type === "dropdown") {
      for (const [optionIndex, option] of expectArray(attributes.options, `${context}.attributes.options`).entries()) {
        expectString(option, `${context}.attributes.options[${optionIndex}]`);
      }
    }

    if (type === "checkboxes") {
      const options = expectArray(attributes.options, `${context}.attributes.options`);
      assert.ok(options.length > 0, `${context}.attributes.options must not be empty`);
      for (const [optionIndex, option] of options.entries()) {
        const optionRecord = expectRecord(option, `${context}.attributes.options[${optionIndex}]`);
        expectString(optionRecord.label, `${context}.attributes.options[${optionIndex}].label`);
        assert.equal(
          typeof optionRecord.required,
          "boolean",
          `${context}.attributes.options[${optionIndex}].required must be a boolean`
        );
      }
    }
  }

  return body;
}

function fieldIds(body: UnknownRecord[]): string[] {
  return body.flatMap((item) => (typeof item.id === "string" ? [item.id] : []));
}

function assertRequiredFields(file: string, body: UnknownRecord[], fieldIdsToCheck: string[]): void {
  for (const id of fieldIdsToCheck) {
    const field = body.find((item) => item.id === id);
    assert.ok(field, `${file} must include ${id}`);
    const validations = expectRecord(field.validations, `${file}.${id}.validations`);
    assert.equal(validations.required, true, `${file}.${id} must be required`);
  }
}

function expectRequiredChecklist(file: string, body: UnknownRecord[], id: string): unknown[] {
  const checklist = body.find((item) => item.id === id);
  assert.ok(checklist, `${file} must include the ${id} checklist`);
  const attributes = expectRecord(checklist.attributes, `${file}.${id}.attributes`);
  const options = expectArray(attributes.options, `${file}.${id}.attributes.options`);
  for (const [index, option] of options.entries()) {
    const optionRecord = expectRecord(option, `${file}.${id}.attributes.options[${index}]`);
    assert.equal(optionRecord.required, true, `${file}.${id}.attributes.options[${index}] must be required`);
  }
  return options;
}

function markdownLinkTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim();
  const angleTarget = /^<([^>]+)>/.exec(trimmed);
  return angleTarget?.[1] ?? trimmed.split(/\s+(?=["'])/, 1)[0] ?? "";
}

function isWithinRepository(repositoryRoot: string, path: string): boolean {
  const repositoryPath = relative(repositoryRoot, path);
  return repositoryPath === "" || (repositoryPath !== ".." && !repositoryPath.startsWith(`..${sep}`) && !isAbsolute(repositoryPath));
}

async function assertRepositoryFile(sourceFile: string, localPath: string, target: string): Promise<void> {
  assert.ok(
    !isAbsolute(localPath) && !win32.isAbsolute(localPath),
    `${sourceFile} contains an absolute local link: ${target}`
  );

  const resolvedTarget = resolve(dirname(resolve(sourceFile)), localPath);
  assert.ok(
    isWithinRepository(REPOSITORY_ROOT, resolvedTarget),
    `${sourceFile} contains a local link outside the repository: ${target}`
  );

  const targetStat = await stat(resolvedTarget).catch(() =>
    assert.fail(`${sourceFile} contains a broken local link: ${target}`)
  );
  assert.ok(targetStat.isFile(), `${sourceFile} contains a local link that is not a regular file: ${target}`);

  const canonicalRepositoryRoot = await realpath(REPOSITORY_ROOT);
  const canonicalTarget = await realpath(resolvedTarget);
  assert.ok(
    isWithinRepository(canonicalRepositoryRoot, canonicalTarget),
    `${sourceFile} contains a local link outside the repository: ${target}`
  );
}

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

test("issue forms conform to the expected GitHub schemas", async () => {
  const bugFile = ".github/ISSUE_TEMPLATE/bug_report.yml";
  const featureFile = ".github/ISSUE_TEMPLATE/feature_request.yml";
  const supportFile = ".github/ISSUE_TEMPLATE/support_request.yml";
  const bugBody = validateIssueForm(bugFile, await readYaml(bugFile));
  const featureBody = validateIssueForm(featureFile, await readYaml(featureFile));
  const supportBody = validateIssueForm(supportFile, await readYaml(supportFile));

  assert.deepEqual(fieldIds(bugBody), ["summary", "reproduce", "expected", "environment", "output", "safety"]);
  assert.deepEqual(fieldIds(featureBody), ["problem", "outcome", "alternatives", "contract", "checks"]);
  assert.deepEqual(fieldIds(supportBody), ["question", "attempted", "environment", "safety"]);

  assertRequiredFields(bugFile, bugBody, ["summary", "reproduce", "expected", "environment"]);
  assertRequiredFields(featureFile, featureBody, ["problem", "outcome"]);
  assertRequiredFields(supportFile, supportBody, ["question", "attempted", "environment"]);
  const safetyOptions = expectRequiredChecklist(bugFile, bugBody, "safety");
  expectRequiredChecklist(featureFile, featureBody, "checks");
  expectRequiredChecklist(supportFile, supportBody, "safety");
  assert.ok(
    safetyOptions.some((option) => /not a security vulnerability/i.test(expectString(expectRecord(option, "safety option").label, "safety option label"))),
    `${bugFile} must direct security vulnerabilities to the private reporting process`
  );
});

test("issue template config routes support and security contacts", async () => {
  const file = ".github/ISSUE_TEMPLATE/config.yml";
  const config = await readYaml(file);
  assert.equal(config.blank_issues_enabled, false, `${file} must disable blank issues`);

  const contactLinks = expectArray(config.contact_links, `${file}.contact_links`);
  assert.equal(contactLinks.length, 2, `${file} must define support and security contacts`);
  const expectedTargets = new Set(["SUPPORT.md", "SECURITY.md"]);
  const repositoryPath = "/calvinnwq/skill-suitcase/blob/main/";

  for (const [index, contactLink] of contactLinks.entries()) {
    const contact = expectRecord(contactLink, `${file}.contact_links[${index}]`);
    expectString(contact.name, `${file}.contact_links[${index}].name`);
    expectString(contact.about, `${file}.contact_links[${index}].about`);
    const url = new URL(expectString(contact.url, `${file}.contact_links[${index}].url`));
    assert.equal(url.protocol, "https:", `${file} contact URLs must use HTTPS`);
    assert.equal(url.hostname, "github.com", `${file} contact URLs must point to GitHub`);
    assert.ok(url.pathname.startsWith(repositoryPath), `${file} contact URLs must point to this repository's main branch`);
    const target = decodeURIComponent(url.pathname.slice(repositoryPath.length));
    assert.ok(expectedTargets.delete(target), `${file} contains an unexpected or duplicate contact target ${target}`);
    await access(target);
  }

  assert.deepEqual([...expectedTargets], [], `${file} must link to both support and security guidance`);
});

test("npm package includes README-linked community guidance", async () => {
  const packageJson = expectRecord(JSON.parse(await readFile("package.json", "utf8")), "package.json");
  const packagedFiles = new Set(
    expectArray(packageJson.files, "package.json.files").map((file, index) =>
      expectString(file, `package.json.files[${index}]`)
    )
  );

  for (const file of PACKAGED_COMMUNITY_FILES) {
    assert.ok(packagedFiles.has(file), `package.json.files must include ${file}`);
  }
});

test("release publishing uses the Trusted Publishing safety boundary", async () => {
  const file = ".github/workflows/release-please.yml";
  const workflowText = await readFile(file, "utf8");
  const workflow = await readYaml(file);
  const jobs = expectRecord(workflow.jobs, `${file}.jobs`);
  const releaseJob = expectRecord(jobs["release-please"], `${file}.jobs.release-please`);
  const permissions = expectRecord(
    releaseJob.permissions ?? workflow.permissions,
    `${file}.jobs.release-please effective permissions`
  );
  assert.equal(permissions["id-token"], "write", `${file} must grant OIDC token permission`);

  const steps = expectArray(releaseJob.steps, `${file}.jobs.release-please.steps`).map((step, index) =>
    expectRecord(step, `${file}.jobs.release-please.steps[${index}]`)
  );
  const releaseStepIndex = steps.findIndex(
    (step) =>
      step.id === "release" &&
      typeof step.uses === "string" &&
      step.uses.startsWith("googleapis/release-please-action@")
  );
  assert.notEqual(releaseStepIndex, -1, `${file} must define the Release Please output step`);

  const releaseCreatedCondition = "${{ steps.release.outputs.release_created == 'true' }}";
  for (const [index, step] of steps.entries()) {
    if (index > releaseStepIndex) {
      assert.equal(
        step.if,
        releaseCreatedCondition,
        `${file}.jobs.release-please.steps[${index}] must require a created release`
      );
    }
  }

  const publishSteps = Object.entries(jobs).flatMap(([jobName, jobValue]) => {
    const job = expectRecord(jobValue, `${file}.jobs.${jobName}`);
    const jobSteps = job.steps === undefined ? [] : expectArray(job.steps, `${file}.jobs.${jobName}.steps`);
    return jobSteps
      .map((step, index) => ({
        index,
        jobName,
        step: expectRecord(step, `${file}.jobs.${jobName}.steps[${index}]`)
      }))
      .filter(
        ({ step }) =>
          typeof step.run === "string" && /(?:^|\n)\s*npm publish\b(?![^\n]*--dry-run)/m.test(step.run)
      );
  });
  assert.equal(publishSteps.length, 1, `${file} must contain exactly one non-dry-run npm publish step`);
  const publishStep = publishSteps[0];
  assert.ok(publishStep, `${file} must define a non-dry-run npm publish step`);
  assert.equal(publishStep.jobName, "release-please", `${file} npm publish must run in the release-please job`);
  assert.ok(publishStep.index > releaseStepIndex, `${file} npm publish must run after Release Please`);
  assert.equal(publishStep.step.if, releaseCreatedCondition, `${file} npm publish must require a created release`);
  const publishCommand = expectString(publishStep.step.run, `${file} publish command`);
  assert.match(publishCommand, /(?:^|\s)--provenance(?:\s|$)/, `${file} npm publish must attest provenance`);
  assert.match(publishCommand, /(?:^|\s)--access\s+public(?:\s|$)/, `${file} npm publish must remain public`);
  assert.doesNotMatch(
    workflowText,
    /\b(?:npm|node)[_-]?(?:auth[_-]?)?token\b/i,
    `${file} must not reference a long-lived npm authentication token`
  );
  assert.doesNotMatch(
    workflowText,
    /\$\{\{\s*secrets\./i,
    `${file} must publish through OIDC without repository secrets`
  );
});

test("repository file validation rejects unsafe and non-file targets", async () => {
  await assert.doesNotReject(assertRepositoryFile("README.md", "LICENSE", "LICENSE"));
  await assert.rejects(assertRepositoryFile("README.md", "/LICENSE", "/LICENSE"), /absolute local link/);
  await assert.rejects(assertRepositoryFile("README.md", "C:\\LICENSE", "C:\\LICENSE"), /absolute local link/);
  await assert.rejects(assertRepositoryFile("README.md", "../", "../"), /outside the repository/);
  await assert.rejects(assertRepositoryFile("README.md", ".", "."), /not a regular file/);
});

test("local Markdown links resolve to repository files", async () => {
  for (const file of COMMUNITY_MARKDOWN_FILES) {
    const markdown = await readFile(file, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = markdownLinkTarget(match[1] ?? "");
      const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target);
      if (target === "" || target.startsWith("#") || target.startsWith("//") || (hasScheme && !win32.isAbsolute(target))) {
        continue;
      }

      const encodedPath = target.split(/[?#]/, 1)[0] ?? "";
      let localPath: string;
      try {
        localPath = decodeURIComponent(encodedPath);
      } catch {
        assert.fail(`${file} contains an invalid encoded link target: ${target}`);
      }
      await assertRepositoryFile(file, localPath, target);
    }
  }
});
