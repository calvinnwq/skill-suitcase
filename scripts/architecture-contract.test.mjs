import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { checkArchitecture } from "./check-architecture.mjs";

const temporaryRoots = [];
const CHECKER = path.resolve("scripts/check-architecture.mjs");

const LAYER_FILES = {
  cli: "src/cli.ts",
  commands: "src/commands/plan.ts",
  core: "src/core/planning/index.ts",
  adapters: "src/adapters/filesystem.ts",
  renderers: "src/renderers/json.ts",
  config: "src/config/defaults.ts",
  shared: "src/shared/types.ts"
};

const ALLOWED_LAYERS = {
  cli: ["commands", "config", "renderers", "shared"],
  commands: ["commands", "core", "config", "renderers", "shared"],
  core: ["core", "adapters", "config", "shared"],
  adapters: ["adapters", "config", "shared"],
  renderers: ["renderers", "config", "shared"],
  config: ["config", "shared"],
  shared: ["config", "shared"]
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("architecture contract accepts every documented dependency direction", async (t) => {
  for (const [sourceLayer, targetLayers] of Object.entries(ALLOWED_LAYERS)) {
    for (const targetLayer of targetLayers) {
      await t.test(`${sourceLayer} to ${targetLayer}`, async () => {
        const source = LAYER_FILES[sourceLayer];
        const target = LAYER_FILES[targetLayer];
        const root = await createFixture({
          [source]: `import ${JSON.stringify(relativeSpecifier(source, target))};`
        });
        assert.deepEqual(await checkArchitecture(root), []);
      });
    }
  }
});

test("architecture contract rejects every forbidden dependency direction", async (t) => {
  const layers = Object.keys(LAYER_FILES);
  for (const [sourceLayer, allowedTargets] of Object.entries(ALLOWED_LAYERS)) {
    for (const targetLayer of layers.filter((candidate) => !allowedTargets.includes(candidate))) {
      await t.test(`${sourceLayer} to ${targetLayer}`, async () => {
        const source = LAYER_FILES[sourceLayer];
        const target = LAYER_FILES[targetLayer];
        const root = await createFixture({
          [source]: `import ${JSON.stringify(relativeSpecifier(source, target))};`
        });
        assert.equal(
          (await checkArchitecture(root)).includes(`${source} imports forbidden ${targetLayer} boundary ${target}`),
          true
        );
      });
    }
  }
});

test("architecture contract recognizes supported TypeScript and ESM dependency syntax", async () => {
  const root = await createFixture({
    "src/core/static-import.ts": 'import "../commands/plan.js";',
    "src/core/static-export.ts": 'export * from "../commands/plan.js";',
    "src/core/import-equals.ts": 'import command = require("../commands/plan.js");\nvoid command;',
    "src/core/dynamic-import.ts": 'export const load = () => import("../commands/plan.js");',
    "src/core/commonjs-require.ts": 'const command = require("../commands/plan.js");\nvoid command;',
    "src/core/parenthesized.ts": [
      'import(("../commands/plan.js"));',
      'require(("../commands/plan.js"));'
    ].join("\n")
  });

  assert.deepEqual(await checkArchitecture(root), [
    "src/core/commonjs-require.ts imports forbidden commands boundary src/commands/plan.ts",
    "src/core/dynamic-import.ts imports forbidden commands boundary src/commands/plan.ts",
    "src/core/import-equals.ts imports forbidden commands boundary src/commands/plan.ts",
    "src/core/parenthesized.ts imports forbidden commands boundary src/commands/plan.ts",
    "src/core/static-export.ts imports forbidden commands boundary src/commands/plan.ts",
    "src/core/static-import.ts imports forbidden commands boundary src/commands/plan.ts"
  ]);
});

test("architecture contract intentionally ignores non-literal dynamic dependencies", async () => {
  const root = await createFixture({
    "src/core/dynamic.ts": [
      "export const load = (target) => import(target);",
      "export const requireTarget = (target) => require(target);"
    ].join("\n")
  });
  assert.deepEqual(await checkArchitecture(root), []);
});

test("architecture contract ignores type-only process references", async () => {
  const root = await createFixture({
    "src/core/process-types.ts": [
      'import type { stdout } from "node:process";',
      "type Output = typeof process.stdout;",
      "export type { Output, stdout };"
    ].join("\n")
  });
  assert.deepEqual(await checkArchitecture(root), []);
});

test("architecture contract keeps direct process and console output at the CLI boundary", async (t) => {
  const cases = [
    ["core argv", "src/core/planning/index.ts", "export const args = process.argv;", "process.argv"],
    ["core stdout", "src/core/planning/index.ts", 'process.stdout.write("result");', "process.stdout"],
    ["command stderr", "src/commands/plan.ts", 'process.stderr.write("warning");', "process.stderr"],
    ["renderer stdout", "src/renderers/json.ts", 'process.stdout.write("result");', "process.stdout"],
    ["global process", "src/core/planning/index.ts", 'globalThis.process.stdout.write("result");', "process.stdout"],
    ["destructured stderr", "src/core/planning/index.ts", "const { stderr } = process;", "process.stderr"],
    ["named process import", "src/core/planning/index.ts", 'import { stdout } from "node:process";', "process.stdout"],
    [
      "process namespace default",
      "src/core/planning/index.ts",
      'import * as runtime from "node:process";\nruntime.default.stdout.write("result");',
      "process.stdout"
    ],
    ["console log", "src/core/planning/index.ts", 'console.log("result");', "console.log"],
    ["console error", "src/renderers/json.ts", 'console.error("warning");', "console.error"],
    ["computed console", "src/core/planning/index.ts", 'console["log"]("result");', "console.log"],
    ["console trace", "src/core/planning/index.ts", 'console.trace("result");', "console.trace"],
    ["global console", "src/core/planning/index.ts", 'globalThis.console.log("result");', "console.log"],
    ["computed global console", "src/core/planning/index.ts", 'global["console"].warn("result");', "console.warn"]
  ];

  for (const [name, source, contents, evidence] of cases) {
    await t.test(name, async () => {
      const failures = await checkArchitecture(await createFixture({ [source]: contents }));
      assert.equal(failures.some((failure) => failure.includes(evidence)), true, failures.join("\n"));
    });
  }
});

test("architecture contract rejects runtime process capability re-exports", async () => {
  const root = await createFixture({
    "src/core/process-facade.ts": 'export { stdout, stderr as errors } from "node:process";'
  });
  assert.deepEqual(await checkArchitecture(root), [
    "src/core/process-facade.ts uses process.stderr outside the CLI boundary",
    "src/core/process-facade.ts uses process.stdout outside the CLI boundary"
  ]);
});

test("architecture contract requires renderer-mediated CLI writes", async () => {
  const root = await createFixture({
    "src/cli.ts": [
      'import { renderCliError } from "./renderers/errors.js";',
      'process.stdout.write(JSON.stringify({ ok: true }));',
      'process.stderr.write(renderCliError({ type: "fatal", message: "failure" }));'
    ].join("\n"),
    "src/renderers/errors.ts": "export const renderCliError = (value) => String(value);"
  });

  assert.deepEqual(await checkArchitecture(root), [
    "src/cli.ts writes process.stdout without a renderer helper"
  ]);
});

test("architecture contract rejects computed raw CLI writes", async () => {
  const root = await createFixture({
    "src/cli.ts": 'process.stdout["write"](JSON.stringify({ ok: true }));'
  });
  assert.deepEqual(await checkArchitecture(root), [
    "src/cli.ts writes process.stdout without a renderer helper"
  ]);
});

test("architecture contract rejects parenthesized direct output calls", async () => {
  const root = await createFixture({
    "src/cli.ts": [
      '(process.stdout.write)("raw");',
      'process.stdout[("write")]("raw");'
    ].join("\n"),
    "src/core/console.ts": '(console.log)("raw");'
  });
  assert.deepEqual(await checkArchitecture(root), [
    "src/cli.ts writes process.stdout without a renderer helper",
    "src/core/console.ts uses console.log; output must use renderer helpers at the CLI boundary"
  ]);
});

test("architecture contract rejects raw CLI writes through direct stream bindings", async (t) => {
  await t.test("named import", async () => {
    const root = await createFixture({
      "src/cli.ts": 'import { stdout } from "node:process";\nstdout.write("raw");'
    });
    assert.deepEqual(await checkArchitecture(root), [
      "src/cli.ts writes process.stdout without a renderer helper"
    ]);
  });

  await t.test("destructured stream", async () => {
    const root = await createFixture({
      "src/cli.ts": 'const { stderr: errors } = process;\nerrors.write("raw");'
    });
    assert.deepEqual(await checkArchitecture(root), [
      "src/cli.ts writes process.stderr without a renderer helper"
    ]);
  });

  await t.test("destructuring assignment", async () => {
    const root = await createFixture({
      "src/cli.ts": 'let output;\n({ stdout: output } = process);\noutput.write("raw");'
    });
    assert.deepEqual(await checkArchitecture(root), [
      "src/cli.ts writes process.stdout without a renderer helper"
    ]);
  });

  await t.test("shorthand destructuring assignment", async () => {
    const root = await createFixture({
      "src/cli.ts": 'let stdout;\n({ stdout } = process);\nstdout.write("raw");'
    });
    assert.deepEqual(await checkArchitecture(root), [
      "src/cli.ts writes process.stdout without a renderer helper"
    ]);
  });

  await t.test("direct stream variable", async () => {
    const root = await createFixture({
      "src/cli.ts": 'const output = process.stdout;\noutput.write("raw");'
    });
    assert.deepEqual(await checkArchitecture(root), [
      "src/cli.ts writes process.stdout without a renderer helper"
    ]);
  });
});

test("architecture contract rejects renderer-shaped external imports", async () => {
  const root = await createFixture({
    "src/cli.ts": [
      'import { renderJson } from "some-package/renderers/json.js";',
      'process.stdout.write(renderJson({ ok: true }));'
    ].join("\n")
  });
  assert.deepEqual(await checkArchitecture(root), [
    "src/cli.ts writes process.stdout without a renderer helper"
  ]);
});

test("architecture contract accepts JSON and error renderer calls at the CLI write boundary", async () => {
  const root = await createFixture({
    "src/cli.ts": [
      'import { renderCliError } from "./renderers/errors.js";',
      'import { renderJson } from "./renderers/json.js";',
      'process.stdout.write(renderJson({ ok: true }));',
      'process.stderr.write(renderCliError({ type: "fatal", message: "failure" }));'
    ].join("\n"),
    "src/renderers/errors.ts": "export const renderCliError = (value) => String(value);",
    "src/renderers/json.ts": "export const renderJson = (value) => JSON.stringify(value);"
  });

  assert.deepEqual(await checkArchitecture(root), []);
});

test("architecture contract rejects shadowed renderer bindings", async () => {
  const root = await createFixture({
    "src/cli.ts": [
      'import { renderJson } from "./renderers/json.js";',
      "{",
      "  const renderJson = String;",
      "  process.stdout.write(renderJson({ ok: true }));",
      "}"
    ].join("\n"),
    "src/renderers/json.ts": "export const renderJson = (value) => JSON.stringify(value);"
  });
  assert.deepEqual(await checkArchitecture(root), [
    "src/cli.ts writes process.stdout without a renderer helper"
  ]);
});

test("architecture contract respects shadowed stream binding names", async () => {
  const root = await createFixture({
    "src/cli.ts": [
      "const output = process.stdout;",
      'function writeLocal(output) { output.write("local"); }',
      "void output;",
      "void writeLocal;"
    ].join("\n")
  });
  assert.deepEqual(await checkArchitecture(root), []);
});

test("architecture contract rejects bloated command behavior modules", async () => {
  const root = await createFixture({
    "src/commands/plan.ts": Array.from({ length: 81 }, (_, index) => `const value${index} = ${index};`).join("\n")
  });
  assert.deepEqual(await checkArchitecture(root), [
    "src/commands/plan.ts has 81 non-empty lines; command behavior modules must stay at or below 80"
  ]);
});

test("architecture contract preserves thin CLI ownership", async (t) => {
  await t.test("direct core import", async () => {
    const root = await createFixture({
      "src/cli.ts": 'import { plan } from "./core/planning/index.js";\nvoid plan;'
    });
    assert.deepEqual(await checkArchitecture(root), [
      "src/cli.ts imports forbidden core boundary src/core/planning/index.ts"
    ]);
  });

  await t.test("switch dispatch", async () => {
    const root = await createFixture({ "src/cli.ts": "switch (command) { default: break; }" });
    assert.deepEqual(await checkArchitecture(root), [
      "src/cli.ts contains a switch statement; command dispatch belongs in src/commands/"
    ]);
  });

  await t.test("line limit", async () => {
    const root = await createFixture({
      "src/cli.ts": Array.from({ length: 61 }, (_, index) => `const value${index} = ${index};`).join("\n")
    });
    assert.deepEqual(await checkArchitecture(root), [
      "src/cli.ts has 61 non-empty lines; keep it as a thin entrypoint"
    ]);
  });
});

test("architecture contract rejects unknown nested source layers and treats root shims as core", async () => {
  const root = await createFixture({
    "src/services/bridge.ts": "export {};",
    "src/planner.ts": 'export * from "./commands/plan.js";'
  });
  assert.deepEqual(await checkArchitecture(root), [
    "src/planner.ts imports forbidden commands boundary src/commands/plan.ts",
    "src/services/bridge.ts is outside the recognized architecture layers"
  ]);
});

test("architecture checker executable fails deterministically on stderr", async () => {
  const root = await createFixture({
    "src/core/z-last.ts": 'import "../commands/plan.js";',
    "src/core/a-first.ts": 'console.log("leak");'
  });
  const first = runChecker(root);
  const second = runChecker(root);

  assert.equal(first.status, 1);
  assert.equal(first.stdout, "");
  assert.equal(first.stderr, [
    "Architecture guardrail failed: src/core/a-first.ts uses console.log; output must use renderer helpers at the CLI boundary",
    "Architecture guardrail failed: src/core/z-last.ts imports forbidden commands boundary src/commands/plan.ts",
    ""
  ].join("\n"));
  assert.deepEqual(second, first);
});

test("architecture checker executable reports success on stdout", async () => {
  const result = runChecker(await createFixture());
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "Architecture guardrails passed.\n");
  assert.equal(result.stderr, "");
});

function runChecker(root) {
  const result = spawnSync(process.execPath, [CHECKER, "--root", root], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function relativeSpecifier(source, target) {
  const relative = path.posix.relative(path.posix.dirname(source), target).replace(/\.ts$/, ".js");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

async function createFixture(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-architecture-"));
  temporaryRoots.push(root);
  const files = {
    "src/cli.ts": "export {};",
    "src/commands/plan.ts": "export {};",
    "src/core/planning/index.ts": "export {};",
    "src/adapters/filesystem.ts": "export {};",
    "src/renderers/json.ts": "export {};",
    "src/config/defaults.ts": "export {};",
    "src/shared/types.ts": "export {};",
    ...overrides
  };

  await Promise.all(Object.entries(files).map(async ([relative, contents]) => {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${contents}\n`, "utf8");
  }));
  return root;
}
