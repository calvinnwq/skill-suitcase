import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommandRegistry, dispatchCommand, parseCommandArgs } from "../src/commands/index.js";
import { usageText } from "../src/renderers/usage.js";

const fixtureSource = `${process.cwd()}/tests/fixtures/skills-catalog`;

test("command registry exposes every public command explicitly", () => {
  const registry = createCommandRegistry();
  assert.deepEqual(registry.names(), [
    "plan",
    "diff",
    "pack",
    "import",
    "validate",
    "targets",
    "status",
    "apply",
    "rollback",
    "track"
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

test("parseCommandArgs preserves repeated track skill filters", () => {
  assert.deepEqual(parseCommandArgs([
    "track",
    "--source",
    fixtureSource,
    "--target",
    "openclaw",
    "--skill",
    "office-hours",
    "--skill",
    "gnhf-postflight",
    "--json"
  ]), {
    command: "track",
    source: fixtureSource,
    target: "openclaw",
    skill: ["office-hours", "gnhf-postflight"],
    dryRun: false,
    json: true
  });
});

test("parseCommandArgs rejects blank track skill filters", () => {
  assert.throws(
    () => parseCommandArgs([
      "track",
      "--source",
      fixtureSource,
      "--target",
      "openclaw",
      "--skill",
      "   ",
      "--json"
    ]),
    /--skill requires a non-blank value/
  );
});

test("parseCommandArgs rejects unsupported known flags before command dispatch", () => {
  assert.throws(
    () => parseCommandArgs([
      "track",
      "--source",
      fixtureSource,
      "--target",
      "openclaw",
      "--skill",
      "office-hours",
      "--json",
      "--dry-run"
    ]),
    /Unknown argument: --dry-run/
  );

  assert.throws(
    () => parseCommandArgs([
      "validate",
      "--source",
      fixtureSource,
      "--json",
      "--target",
      "openclaw"
    ]),
    /Unknown argument: --target/
  );
});

test("dispatcher routes import and rejects invalid import argument shapes", async () => {
  const success = await dispatchCommand([
    "import",
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

  const missingJson = await dispatchCommand([
    "import",
    "--source",
    fixtureSource
  ]);
  assert.equal(missingJson.type, "usage");
  assert.equal(missingJson.exitCode, 2);

  const invalidTarget = await dispatchCommand([
    "import",
    "--source",
    fixtureSource,
    "--target",
    "codex",
    "--json"
  ]);
  assert.equal(invalidTarget.type, "usage");
  assert.equal(invalidTarget.exitCode, 2);
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
