import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { checkArchitecture } from "./check-architecture.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("architecture contract accepts the documented dependency direction", async () => {
  const root = await createFixture({
    "src/cli.ts": [
      'import { command } from "./commands/plan.js";',
      'import { renderJson } from "./renderers/json.js";',
      "void command;",
      "void renderJson;"
    ].join("\n"),
    "src/commands/plan.ts": 'import { plan } from "../core/planning/index.js";\nexport const command = plan;',
    "src/core/planning/index.ts": 'import { readText } from "../../adapters/filesystem.js";\nexport const plan = readText;',
    "src/adapters/filesystem.ts": "export const readText = () => ({ ok: true });",
    "src/renderers/json.ts": "export const renderJson = (value) => JSON.stringify(value);"
  });

  assert.deepEqual(await checkArchitecture(root), []);
});

test("architecture contract rejects forbidden imports across every layer", async (t) => {
  const cases = [
    ["core to commands", "src/core/planning/index.ts", "../../commands/plan.js", "commands"],
    ["core to renderers", "src/core/planning/index.ts", "../../renderers/json.js", "renderers"],
    ["commands to adapters", "src/commands/plan.ts", "../adapters/filesystem.js", "adapters"],
    ["adapters to core", "src/adapters/filesystem.ts", "../core/planning/index.js", "core"],
    ["renderers to core", "src/renderers/json.ts", "../core/planning/index.js", "core"]
  ];

  for (const [name, source, specifier, forbiddenLayer] of cases) {
    await t.test(name, async () => {
      const root = await createFixture({
        [source]: `import ${JSON.stringify(specifier)};`
      });
      const failures = await checkArchitecture(root);
      assert.equal(
        failures.some((failure) => failure.includes(`${source} imports forbidden ${forbiddenLayer} boundary`)),
        true,
        failures.join("\n")
      );
    });
  }
});

test("architecture contract rejects dynamic imports that cross boundaries", async () => {
  const root = await createFixture({
    "src/core/planning/index.ts": 'export const load = () => import("../../commands/plan.js");',
    "src/core/planning/template.ts": "export const load = () => import(`../../commands/plan.js`);"
  });

  assert.deepEqual(await checkArchitecture(root), [
    "src/core/planning/index.ts imports forbidden commands boundary src/commands/plan.ts",
    "src/core/planning/template.ts imports forbidden commands boundary src/commands/plan.ts"
  ]);
});

test("architecture contract ignores import and process examples in comments and strings", async () => {
  const root = await createFixture({
    "src/core/planning/index.ts": [
      '// import "../../commands/plan.js";',
      '// import("../../commands/plan.js");',
      '// process.stdout.write("example");',
      'const examples = ["import(\\"../../commands/plan.js\\")", "process.stderr"];',
      "export { examples };"
    ].join("\n"),
    "src/cli.ts": [
      "// switch (command) {}",
      'const example = "switch (command) {}";',
      "void example;"
    ].join("\n")
  });

  assert.deepEqual(await checkArchitecture(root), []);
});

test("architecture contract keeps argv and process output at the CLI boundary", async (t) => {
  const cases = [
    ["core argv parsing", "src/core/planning/index.ts", "export const args = process.argv;", "process.argv"],
    ["core stdout", "src/core/planning/index.ts", 'process.stdout.write("result");', "process.stdout"],
    ["command stderr", "src/commands/plan.ts", 'process.stderr.write("warning");', "process.stderr"],
    ["renderer stdout", "src/renderers/json.ts", 'process.stdout.write("result");', "process.stdout"]
  ];

  for (const [name, source, contents, processMember] of cases) {
    await t.test(name, async () => {
      const root = await createFixture({ [source]: contents });
      assert.equal(
        (await checkArchitecture(root)).some((failure) => failure.includes(`${source} uses ${processMember} outside the CLI boundary`)),
        true
      );
    });
  }
});

test("architecture contract rejects bloated command behavior modules", async () => {
  const root = await createFixture({
    "src/commands/plan.ts": Array.from({ length: 81 }, (_, index) => `const value${index} = ${index};`).join("\n")
  });

  assert.deepEqual(await checkArchitecture(root), [
    "src/commands/plan.ts has 81 non-empty lines; command behavior modules must stay at or below 80"
  ]);
});

test("architecture contract rejects a CLI that bypasses commands", async () => {
  const root = await createFixture({
    "src/cli.ts": 'import { plan } from "./core/planning/index.js";\nvoid plan;'
  });

  assert.deepEqual(await checkArchitecture(root), [
    "src/cli.ts imports forbidden core boundary src/core/planning/index.ts"
  ]);
});

async function createFixture(overrides) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-architecture-"));
  temporaryRoots.push(root);
  const files = {
    "src/cli.ts": "export {};",
    "src/commands/plan.ts": "export {};",
    "src/core/planning/index.ts": "export {};",
    "src/adapters/filesystem.ts": "export {};",
    "src/renderers/json.ts": "export {};",
    ...overrides
  };

  await Promise.all(Object.entries(files).map(async ([relative, contents]) => {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${contents}\n`, "utf8");
  }));

  return root;
}
