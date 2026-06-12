import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommandRegistry, dispatchCommand, parseCommandArgs, usageText } from "../src/commands/index.js";

const fixtureSource = `${process.cwd()}/tests/fixtures/skills-catalog`;

test("command registry exposes every public command explicitly", () => {
  const registry = createCommandRegistry();
  assert.deepEqual(registry.names(), [
    "plan",
    "diff",
    "pack",
    "validate",
    "targets",
    "status",
    "apply"
  ]);
});

test("parseCommandArgs preserves current flag parsing and unknown argument errors", () => {
  assert.deepEqual(parseCommandArgs([
    "pack",
    "--source",
    fixtureSource,
    "--target",
    "openclaw",
    "--dry-run",
    "--json"
  ]), {
    command: "pack",
    source: fixtureSource,
    target: "openclaw",
    dryRun: true,
    json: true
  });

  assert.throws(
    () => parseCommandArgs(["plan", "--source", fixtureSource, "--target", "openclaw", "--nope"]),
    /Unknown argument: --nope/
  );
});

test("dispatcher routes valid commands and reports usage failures without stdout JSON", async () => {
  const success = await dispatchCommand([
    "validate",
    "--source",
    fixtureSource,
    "--json"
  ]);

  assert.equal(success.type, "result");
  if (success.type !== "result") {
    assert.fail("Expected command result.");
  }
  assert.equal(success.exitCode, 0);
  assert.equal(success.result.ok, true);

  const usage = await dispatchCommand([
    "apply",
    "--source",
    fixtureSource,
    "--target",
    "openclaw",
    "--json"
  ]);

  assert.equal(usage.type, "usage");
  if (usage.type !== "usage") {
    assert.fail("Expected usage result.");
  }
  assert.equal(usage.exitCode, 2);
  assert.equal(usage.message, null);
  assert.equal(usage.usage, usageText());
});
