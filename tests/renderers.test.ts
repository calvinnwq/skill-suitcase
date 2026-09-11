import assert from "node:assert/strict";
import { test } from "node:test";
import { exitCodeForCommandResult, EXIT_CODE_EXECUTION_FAILURE, EXIT_CODE_SUCCESS, EXIT_CODE_USAGE } from "../src/renderers/exit-codes.js";
import { renderCliError } from "../src/renderers/errors.js";
import { renderJson } from "../src/renderers/json.js";
import { usageText } from "../src/renderers/usage.js";
import { renderUpdateNotice, renderUpdateSummary } from "../src/renderers/update.js";

test("json renderer preserves deterministic pretty JSON with trailing newline", () => {
  assert.equal(renderJson({ ok: true, alpha: [1, 2] }), '{\n  "ok": true,\n  "alpha": [\n    1,\n    2\n  ]\n}\n');
});

test("usage and known CLI error renderers target stderr text", () => {
  const usage = usageText();
  assert.match(usage, /Usage:\n  skill-suitcase <command> \[flags\]/);
  const targetHelp = usageText("diff");
  assert.equal((targetHelp.match(/--agents-skills/g) ?? []).length, 1);
  assert.equal((targetHelp.match(/--grok-skills/g) ?? []).length, 1);
  assert.equal((targetHelp.match(/--hermes-skills/g) ?? []).length, 1);
  assert.equal(renderCliError({ type: "usage", message: null, usage: targetHelp }), `${targetHelp}\n`);
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

test("update summary renderer covers every status without paths or logs", () => {
  const base = {
    action: "update" as const,
    currentVersion: "0.19.0",
    latestVersion: "0.20.0",
    installedVersion: null,
    installation: { canSelfUpdate: true, guidance: "The CLI is installed in npm's global root." },
    error: null
  };
  assert.equal(
    renderUpdateSummary({ ...base, status: "updated", installedVersion: "0.20.0" }),
    "Updated skill-suitcase 0.19.0 -> 0.20.0 and verified the new launcher.\n"
  );
  assert.equal(
    renderUpdateSummary({ ...base, action: "check", status: "update-available" }),
    "skill-suitcase 0.19.0 is installed; 0.20.0 is available.\nRun \"skill-suitcase update\" to install it.\n"
  );
  assert.equal(
    renderUpdateSummary({ ...base, action: "check", status: "update-available",
      installation: { canSelfUpdate: false, guidance: "Use git." } }),
    "skill-suitcase 0.19.0 is installed; 0.20.0 is available.\nUse git.\n"
  );
  assert.equal(renderUpdateSummary({ ...base, status: "up-to-date", latestVersion: "0.19.0" }), "skill-suitcase 0.19.0 is up to date.\n");
  assert.equal(
    renderUpdateSummary({ ...base, status: "ahead", currentVersion: "0.21.0" }),
    "skill-suitcase 0.21.0 is newer than the published 0.20.0; nothing to do.\n"
  );
  assert.equal(
    renderUpdateSummary({ ...base, status: "unsupported-installation", latestVersion: null,
      installation: { canSelfUpdate: false, guidance: "Use git." } }),
    "Cannot self-update skill-suitcase 0.19.0: Use git.\n"
  );
  assert.equal(
    renderUpdateSummary({ ...base, action: "check", status: "failed", latestVersion: null,
      error: { code: "registry-unreachable", message: "The registry could not be reached (timeout)." } }),
    "Update check failed (registry-unreachable): The registry could not be reached (timeout).\n"
  );
  assert.equal(
    renderUpdateSummary({ ...base, status: "failed", error: { code: "install-failed", message: "npm failed." } }),
    "Update failed (install-failed): npm failed.\n"
  );
});

test("update notice renderer distinguishes package installs from source launches", () => {
  const packageNotice = renderUpdateNotice({ currentVersion: "0.19.0", latestVersion: "0.20.0", installation: "package" });
  assert.equal(
    packageNotice,
    "A newer skill-suitcase is available: 0.19.0 -> 0.20.0. Update with the tool that installed this CLI.\n"
      + "Set SKILL_SUITCASE_NO_UPDATE_CHECK=1 to silence this notice.\n"
  );
  const sourceNotice = renderUpdateNotice({ currentVersion: "0.19.0", latestVersion: "0.20.0", installation: "source" });
  assert.match(sourceNotice, /does not self-update; install the published package with npm install --global skill-suitcase/);
  assert.doesNotMatch(sourceNotice, /"skill-suitcase update"/);
});
