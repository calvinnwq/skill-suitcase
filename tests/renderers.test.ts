import assert from "node:assert/strict";
import { test } from "node:test";
import { exitCodeForCommandResult, EXIT_CODE_EXECUTION_FAILURE, EXIT_CODE_SUCCESS, EXIT_CODE_USAGE } from "../src/renderers/exit-codes.js";
import { renderCliError } from "../src/renderers/errors.js";
import { renderJson } from "../src/renderers/json.js";
import { usageText } from "../src/renderers/usage.js";

test("json renderer preserves deterministic pretty JSON with trailing newline", () => {
  assert.equal(renderJson({ ok: true, alpha: [1, 2] }), '{\n  "ok": true,\n  "alpha": [\n    1,\n    2\n  ]\n}\n');
});

test("usage and known CLI error renderers target stderr text", () => {
  assert.equal(usageText().startsWith("Usage:\n  suitcase plan"), true);
  assert.equal(renderCliError({ type: "usage", message: "Unknown argument: --nope" }), `${"Unknown argument: --nope"}\n${usageText()}\n`);
  assert.equal(renderCliError({ type: "usage", message: null }), `${usageText()}\n`);
  assert.equal(renderCliError({ type: "fatal", message: "boom" }), "boom\n");
});

test("exit-code mapping is centralized", () => {
  assert.equal(EXIT_CODE_SUCCESS, 0);
  assert.equal(EXIT_CODE_EXECUTION_FAILURE, 1);
  assert.equal(EXIT_CODE_USAGE, 2);
  assert.equal(exitCodeForCommandResult({ ok: true }), 0);
  assert.equal(exitCodeForCommandResult({ ok: false }), 1);
});
