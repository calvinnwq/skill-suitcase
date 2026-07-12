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

test("architecture contract resolves constant dynamic import specifiers", async () => {
  const root = await createFixture({
    "src/core/planning/concatenated.ts": 'export const load = () => import("../../commands/" + "plan.js");',
    "src/core/planning/identifier.ts": [
      'const target = "../../commands/plan.js";',
      "export const load = () => import(target);"
    ].join("\n"),
    "src/core/planning/template.ts": [
      'const directory = "../../commands";',
      "export const load = () => import(`${directory}/plan.js`);"
    ].join("\n"),
    "src/core/planning/options.ts": [
      'const target = "../../commands/plan.js";',
      'export const load = () => import(target, { with: { type: "json" } });'
    ].join("\n")
  });

  assert.deepEqual(await checkArchitecture(root), [
    "src/core/planning/concatenated.ts imports forbidden commands boundary src/commands/plan.ts",
    "src/core/planning/identifier.ts imports forbidden commands boundary src/commands/plan.ts",
    "src/core/planning/options.ts imports forbidden commands boundary src/commands/plan.ts",
    "src/core/planning/template.ts imports forbidden commands boundary src/commands/plan.ts"
  ]);
});

test("architecture contract ignores non-constant dynamic import specifiers", async () => {
  const root = await createFixture({
    "src/core/planning/index.ts": [
      "export const loadParameter = (target) => import(target);",
      'let target = "../../commands/plan.js";',
      "export const loadMutable = () => import(target);"
    ].join("\n")
  });

  assert.deepEqual(await checkArchitecture(root), []);
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
    ["renderer stdout", "src/renderers/json.ts", 'process.stdout.write("result");', "process.stdout"],
    ["destructured stdout", "src/core/planning/index.ts", "const { stdout } = process;", "process.stdout"],
    ["global process stdout", "src/core/planning/index.ts", "globalThis.process.stdout.write('result');", "process.stdout"],
    ["Node global process stdout", "src/core/planning/index.ts", "global.process.stdout.write('result');", "process.stdout"],
    ["imported stderr", "src/core/planning/index.ts", "import { stderr } from 'node:process';", "process.stderr"],
    ["aliased process argv", "src/core/planning/index.ts", "const runtime = process; export const args = runtime.argv;", "process.argv"],
    [
      "import-equals process argv",
      "src/core/planning/index.ts",
      'import runtime = require("node:process"); export const args = runtime.argv;',
      "process.argv"
    ],
    [
      "dynamic-import destructured stdout",
      "src/core/planning/index.ts",
      'const { stdout } = await import("node:process"); stdout.write("result");',
      "process.stdout"
    ],
    [
      "dynamic-import process alias",
      "src/core/planning/index.ts",
      'const moduleName = "node:" + "process"; const runtime = await import(moduleName); runtime.stderr.write("warning");',
      "process.stderr"
    ]
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

test("architecture contract rejects process capability re-export facades", async () => {
  const root = await createFixture({
    "src/core/process-facade.ts": 'export { stdout } from "node:process";',
    "src/core/write.ts": 'import { stdout } from "./process-facade.js";\nstdout.write("result");'
  });

  assert.deepEqual(await checkArchitecture(root), [
    "src/core/process-facade.ts uses process.stdout outside the CLI boundary"
  ]);
});

test("architecture contract ignores members on a locally shadowed process", async () => {
  const root = await createFixture({
    "src/core/planning/index.ts": [
      "const process = { argv: [], stdout: { write() {} }, stderr: { write() {} } };",
      "process.stdout.write('result');",
      "const { stderr } = process;",
      "export { process, stderr };"
    ].join("\n")
  });

  assert.deepEqual(await checkArchitecture(root), []);
});

test("architecture contract ignores locally shadowed process loaders", async () => {
  const root = await createFixture({
    "src/core/planning/index.ts": [
      "const global = { process: { stdout: { write() {} } } };",
      "global.process.stdout.write('local');",
      "function load(require) {",
      '  const runtime = require("node:process");',
      "  return runtime.argv;",
      "}",
      "export { load };"
    ].join("\n")
  });

  assert.deepEqual(await checkArchitecture(root), []);
});

test("architecture contract ignores non-constant process loaders", async () => {
  const root = await createFixture({
    "src/core/planning/index.ts": [
      "export async function write(moduleName) {",
      "  const runtime = await import(moduleName);",
      "  runtime.stdout.write('unknown module');",
      "}"
    ].join("\n")
  });

  assert.deepEqual(await checkArchitecture(root), []);
});

test("architecture contract limits process shadowing to its lexical scope", async () => {
  const root = await createFixture({
    "src/core/planning/index.ts": [
      "function write(process) { process.stdout.write('local'); }",
      "process.stderr.write('global');",
      "export { write };"
    ].join("\n")
  });

  assert.deepEqual(await checkArchitecture(root), [
    "src/core/planning/index.ts uses process.stderr outside the CLI boundary"
  ]);
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

test("architecture contract rejects a CLI that bypasses commands through a core facade", async () => {
  const root = await createFixture({
    "src/cli.ts": 'import { plan } from "./planner.js";\nvoid plan;',
    "src/planner.ts": 'export * from "./core/planning/index.js";'
  });

  assert.deepEqual(await checkArchitecture(root), [
    "src/cli.ts imports forbidden core boundary src/planner.ts"
  ]);
});

test("architecture contract rejects source files outside recognized layers", async () => {
  const root = await createFixture({
    "src/services/bridge.ts": 'import { command } from "../commands/plan.js";\nvoid command;'
  });

  assert.deepEqual(await checkArchitecture(root), [
    "src/services/bridge.ts is outside the recognized architecture layers"
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
