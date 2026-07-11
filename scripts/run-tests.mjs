import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

async function findTestFiles(root, extension) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        files.push(path);
      }
    }
  }

  await visit(root);
  return files.sort();
}

const sourceTests = await findTestFiles("tests", ".test.ts");
const compiledTests = await findTestFiles("dist/tests", ".test.js");
const expectedCompiledTests = sourceTests.map((path) =>
  join("dist", path).replace(/\.test\.ts$/, ".test.js"),
);

assert.deepEqual(
  compiledTests.map((path) => relative(".", path)),
  expectedCompiledTests,
  "compiled test inventory must match tests/**/*.test.ts",
);

const scriptTests = await findTestFiles("scripts", ".test.mjs");
const result = spawnSync(process.execPath, ["--test", ...compiledTests, ...scriptTests], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
