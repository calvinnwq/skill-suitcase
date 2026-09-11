import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createCommandRegistry } from "../src/commands/index.js";

function runHelp(args: string[]) {
  return spawnSync(process.execPath, ["dist/src/cli.js", ...args], { encoding: "utf8" });
}

test("root help is a compact command index with successful help aliases", () => {
  const expected = runHelp(["--help"]);
  assert.equal(expected.status, 0);
  assert.equal(expected.stdout, "");
  assert.match(expected.stderr, /Available Commands:/);
  assert.ok(expected.stderr.split("\n").length <= 35);
  assert.doesNotMatch(expected.stderr, /--target-skill|--codex-home|--plan-id/);
  for (const name of createCommandRegistry().names()) {
    assert.match(expected.stderr, new RegExp(`^  ${name} +\\S`, "m"));
  }
  for (const args of [[], ["-h"], ["help"], ["--help", "--json"]]) {
    const actual = runHelp(args);
    assert.equal(actual.status, 0);
    assert.equal(actual.stdout, "");
    assert.equal(actual.stderr, expected.stderr);
  }
});

test("every command supports focused help without executing its workflow", () => {
  for (const name of createCommandRegistry().names()) {
    const expected = runHelp([name, "--help"]);
    assert.equal(expected.status, 0, name);
    assert.equal(expected.stdout, "");
    assert.match(expected.stderr, new RegExp(`Usage:\\n  skill-suitcase ${name} `));
    assert.doesNotMatch(expected.stderr, /skill-suitcase plan --source/);
    for (const args of [[name, "-h"], ["help", name], [name, "--json", "--help"]]) {
      const actual = runHelp(args);
      assert.equal(actual.status, 0, args.join(" "));
      assert.equal(actual.stdout, "");
      assert.equal(actual.stderr, expected.stderr);
    }
  }
});

test("upstream help drills down to the selected action", () => {
  for (const action of ["check", "fetch", "import"]) {
    const expected = runHelp(["upstream", action, "--help"]);
    assert.equal(expected.status, 0);
    assert.equal(expected.stdout, "");
    assert.match(expected.stderr, new RegExp(`skill-suitcase upstream ${action} `));
    assert.equal(runHelp(["help", "upstream", action]).stderr, expected.stderr);
    if (action === "check") assert.doesNotMatch(expected.stderr, /--apply|--dry-run|--skill/);
  }
});

test("usage errors retain exit 2 and show only the relevant help", () => {
  for (const args of [["plan"], ["plan", "--unknown"], ["apply", "--source", "--help"],
    ["apply", "--source", "-h"], ["track", "--skill", "-h"]]) {
    const result = runHelp(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`Usage:\\n  skill-suitcase ${args[0]} `));
    assert.doesNotMatch(result.stderr, /Available Commands:/);
  }
  for (const args of [["typo", "--help"], ["help", "typo"], ["upstream", "typo", "--help"], ["--unknown"]]) {
    assert.equal(runHelp(args).status, 2, args.join(" "));
  }
});

test("command help retains approval requirements and scopes target overrides", () => {
  assert.match(runHelp(["prune", "--help"]).stderr, /--plan-id/);
  assert.match(runHelp(["apply", "--help"]).stderr, /--lock/);
  assert.match(runHelp(["apply", "--help"]).stderr, /--artifact/);
  assert.match(runHelp(["rollback", "--help"]).stderr, /together/);
  assert.match(runHelp(["diff", "--help"]).stderr, /--hermes-skills/);
  assert.doesNotMatch(runHelp(["plan", "--help"]).stderr, /--hermes-skills/);
});

test("help takes precedence over otherwise executable mutation arguments", () => {
  const result = runHelp(["apply", "--source", "/nonexistent/catalog", "--target", "codex",
    "--artifact", "/nonexistent/artifact", "--json", "--help"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, runHelp(["apply", "--help"]).stderr);
});
