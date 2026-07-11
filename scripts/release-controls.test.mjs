import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readYaml(path) {
  return parse(await readFile(path, "utf8"));
}

function stepByName(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `expected ${name} step`);
  return step;
}

test("CI preserves the required aggregate gate and supported Node runtimes", async () => {
  const workflow = await readYaml(".github/workflows/ci.yml");

  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.env.FORCE_JAVASCRIPT_ACTIONS_TO_NODE24, true);

  assert.equal(stepByName(workflow.jobs.verify, "Set up Node").with["node-version"], 24);
  assert.equal(stepByName(workflow.jobs.verify, "Install dependencies").run, "pnpm install --frozen-lockfile");
  assert.deepEqual(
    ["Test", "Lint", "Check architecture", "Check formatting"].map(
      (name) => stepByName(workflow.jobs.verify, name).run,
    ),
    ["pnpm test", "pnpm run lint", "pnpm run architecture:check", "pnpm run format:check"],
  );

  assert.deepEqual(workflow.jobs["package-smoke"].strategy.matrix["node-version"], [20, 24]);
  assert.equal(
    stepByName(workflow.jobs["package-smoke"], "Install dependencies").run,
    "pnpm install --frozen-lockfile",
  );
  assert.equal(stepByName(workflow.jobs["package-smoke"], "Pack and install smoke").run, "pnpm run package:smoke");

  assert.equal(workflow.jobs.test.name, "test");
  assert.equal(workflow.jobs.test.if, "${{ always() }}");
  assert.deepEqual(workflow.jobs.test.needs, ["verify", "package-smoke"]);
  const aggregateRun = stepByName(workflow.jobs.test, "Confirm required CI gates passed").run;
  assert.match(aggregateRun, /VERIFY_RESULT/);
  assert.match(aggregateRun, /PACKAGE_SMOKE_RESULT/);
});

test("Release Please keeps plain v-prefixed tags and trusted publishing safeguards", async () => {
  const config = await readJson("release-please-config.json");
  const rootPackage = config.packages["."];

  assert.equal(rootPackage["release-type"], "node");
  assert.equal(rootPackage["include-component-in-tag"], false);
  assert.equal(rootPackage["include-v-in-tag"], true);
  assert.equal(rootPackage["include-v-in-release-name"], true);

  const workflow = await readYaml(".github/workflows/release-please.yml");
  assert.equal(workflow.permissions.contents, "write");
  assert.equal(workflow.permissions["id-token"], "write");
  assert.equal(workflow.env.FORCE_JAVASCRIPT_ACTIONS_TO_NODE24, true);

  const job = workflow.jobs["release-please"];
  assert.equal(stepByName(job, "Set up Node").with["node-version"], 24);
  assert.equal(
    stepByName(job, "Set up Node").with["registry-url"],
    "https://registry.npmjs.org",
  );
  assert.match(stepByName(job, "Verify npm supports trusted publishing").run, /require >=11\.5\.1/);

  const publish = stepByName(job, "Publish to npm");
  assert.equal(publish.if, "${{ steps.release.outputs.release_created == 'true' }}");
  assert.equal(publish.run, "npm publish --access public --provenance");
});
