import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { updateCli } from "../src/core/cli-update/index.js";
import {
  createFakeIo,
  FAKE_GLOBAL_ROOT,
  FAKE_NODE,
  FAKE_NPM_CLI,
  FAKE_PACKAGE_ROOT,
  FAKE_PREFIX,
  registryDocument
} from "./helpers/cli-update-fake-io.js";
import type { FakeIoModel } from "./helpers/cli-update-fake-io.js";

const NPM_GLOBAL = { kind: "npm-global", canSelfUpdate: true, reason: null };

test("check reports a newer stable release without installing", async () => {
  const { io, log } = createFakeIo({ currentVersion: "0.19.0", registry: registryDocument("0.20.0") });
  const result = await updateCli({ check: true, io });
  assert.deepEqual(result, {
    ok: true,
    action: "check",
    status: "update-available",
    currentVersion: "0.19.0",
    latestVersion: "0.20.0",
    installedVersion: null,
    updateAvailable: true,
    installation: { ...NPM_GLOBAL, guidance: result.installation.guidance },
    error: null
  });
  assert.deepEqual(log.fetches, [{ url: "https://registry.npmjs.org/skill-suitcase/latest", timeoutMs: 5000, maxBytes: 262144 }]);
  assert.equal(log.processes.some((entry) => entry.args.includes("install")), false);
  assert.equal(log.cacheWrites.length, 0, "explicit checks never write the passive cache");
  assert.equal(log.cacheReads, 0, "explicit checks bypass the passive cache");
});

test("version ordering is numeric semver and ignores build metadata", async () => {
  const cases: Array<[string, string, string, boolean | null]> = [
    ["0.9.0", "0.10.0", "update-available", true],
    ["0.19.0", "0.19.0", "up-to-date", false],
    ["0.19.0+build.7", "0.19.0", "up-to-date", false],
    ["0.20.0", "0.19.0", "ahead", false],
    ["0.20.0-beta.1", "0.20.0", "update-available", true]
  ];
  for (const [current, latest, status, available] of cases) {
    const { io } = createFakeIo({ currentVersion: current, registry: registryDocument(latest) });
    const result = await updateCli({ check: true, io });
    assert.equal(result.status, status, `${current} vs ${latest}`);
    assert.equal(result.updateAvailable, available);
    assert.equal(result.ok, true);
  }
});

test("invalid current version is an explicit failure", async () => {
  const { io, log } = createFakeIo({ currentVersion: "next", registry: registryDocument("0.20.0") });
  const result = await updateCli({ check: true, io });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "invalid-current-version");
  assert.equal(result.currentVersion, null);
  assert.equal(result.updateAvailable, null);
  assert.equal(log.fetches.length, 0);
});

test("malformed, prerelease, mismatched, oversized, redirected, and failing registry responses do not claim up to date", async () => {
  const cases: Array<[NonNullable<FakeIoModel["registry"]>, string]> = [
    [{ ok: true, body: "{not json" }, "registry-response-invalid"],
    [{ ok: true, body: JSON.stringify({ name: "skill-suitcase", version: "0.20.0-rc.1" }) }, "registry-response-invalid"],
    [{ ok: true, body: JSON.stringify({ name: "other-package", version: "0.20.0" }) }, "registry-response-invalid"],
    [{ ok: true, body: JSON.stringify({ name: "skill-suitcase", version: "latest" }) }, "registry-response-invalid"],
    [{ ok: true, body: JSON.stringify(["0.20.0"]) }, "registry-response-invalid"],
    [{ ok: false, reason: "too-large" }, "registry-response-invalid"],
    [{ ok: false, reason: "redirect" }, "registry-response-invalid"],
    [{ ok: false, reason: "http", status: 503 }, "registry-unreachable"],
    [{ ok: false, reason: "timeout" }, "registry-unreachable"],
    [{ ok: false, reason: "network" }, "registry-unreachable"]
  ];
  for (const [registry, code] of cases) {
    const { io } = createFakeIo({ registry });
    const result = await updateCli({ check: true, io });
    assert.equal(result.ok, false, JSON.stringify(registry));
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, code);
    assert.equal(result.latestVersion, null);
    assert.equal(result.updateAvailable, null);
    assert.deepEqual(result.installation, { ...NPM_GLOBAL, guidance: result.installation.guidance });
  }
});

test("ownership is proven from npm-reported roots, not the working directory", async () => {
  const eligible = createFakeIo({ registry: registryDocument("0.20.0") });
  const eligibleResult = await updateCli({ check: true, io: eligible.io });
  assert.equal(eligibleResult.installation.canSelfUpdate, true);
  const prefixQuery = eligible.log.processes.find((entry) => entry.args[1] === "prefix");
  assert.deepEqual(prefixQuery?.args, [FAKE_NPM_CLI, "prefix", "--global"]);
  assert.equal(prefixQuery?.file, "/fixtures/node/bin/node");
  assert.equal(prefixQuery?.timeoutMs, 5000);

  const cases: Array<[FakeIoModel, string]> = [
    [{ sourceCheckout: true }, "source-checkout"],
    [{ npmCli: null }, "npm-not-found"],
    [{ slotKind: "symlink", slotRealPath: "/fixtures/checkout" }, "global-link"],
    [{ slotKind: "missing" }, "outside-global-root"],
    [{ packageRoot: "/fixtures/project/node_modules/skill-suitcase", slotRealPath: FAKE_PACKAGE_ROOT }, "outside-global-root"],
    [{ globalRoot: "/fixtures/other-prefix/lib/node_modules", slotKind: "missing" }, "outside-global-root"],
    [{ platform: "win32" }, "unsupported-platform"],
    [{ runningPackage: null }, "package-metadata-invalid"]
  ];
  for (const [model, reason] of cases) {
    const { io, log } = createFakeIo({ ...model, registry: registryDocument("0.20.0") });
    const check = await updateCli({ check: true, io });
    assert.equal(check.installation.kind, "unsupported", reason);
    assert.equal(check.installation.canSelfUpdate, false);
    assert.equal(check.installation.reason, reason);
    assert.equal(typeof check.installation.guidance, "string");
    assert.doesNotMatch(check.installation.guidance, /sudo|\/fixtures/);
    if (reason !== "package-metadata-invalid") {
      assert.equal(check.ok, true, `${reason} check-only still reports availability`);
      assert.equal(check.status, "update-available");
    }

    const update = await updateCli({ check: false, io });
    assert.equal(update.ok, false);
    assert.equal(update.status, reason === "package-metadata-invalid" ? "failed" : "unsupported-installation");
    assert.equal(update.installation.reason, reason);
    assert.equal(update.latestVersion, null, "unsupported update refuses before any network request");
    assert.equal(log.processes.some((entry) => entry.args.includes("install")), false);
  }
});

test("a failing npm query fails closed", async () => {
  const { io } = createFakeIo({ registry: registryDocument("0.20.0") });
  io.runProcess = async () => ({ status: 1, stdout: "", stderr: "boom", timedOut: false, failed: true });
  const result = await updateCli({ check: true, io });
  assert.equal(result.installation.reason, "npm-query-failed");
  assert.equal(result.ok, true);
});

test("engine incompatibility fails before installation", async () => {
  const { io, log } = createFakeIo({ nodeVersion: "v20.0.0", registry: registryDocument("0.20.0", { engines: { node: ">=22" } }) });
  const result = await updateCli({ check: false, io });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "node-engine-incompatible");
  assert.equal(result.latestVersion, "0.20.0");
  assert.equal(log.processes.some((entry) => entry.args.includes("install")), false);

  const compatible = createFakeIo({ nodeVersion: "v22.1.0", registry: registryDocument("0.20.0", { engines: { node: ">=22" } }) });
  assert.equal((await updateCli({ check: false, io: compatible.io })).status, "updated");
});

test("check reports engine incompatibility instead of recommending an update that cannot install", async () => {
  const { io } = createFakeIo({ nodeVersion: "v20.0.0", registry: registryDocument("0.20.0", { engines: { node: ">=22" } }) });
  const result = await updateCli({ check: true, io });
  assert.deepEqual([result.ok, result.status, result.error?.code, result.latestVersion, result.updateAvailable],
    [false, "failed", "node-engine-incompatible", "0.20.0", true], JSON.stringify(result));
});

test("update forces launcher creation and recovery guidance mirrors the executed install", async () => {
  const { io, log } = createFakeIo({ currentVersion: "0.19.0", registry: registryDocument("0.20.0"), launcherKind: "missing" });
  const result = await updateCli({ check: false, io });
  const install = log.processes.find((entry) => entry.args[1] === "install");
  assert.ok(install);
  assert.ok(install.args.includes("--bin-links=true"), `npm must create the launcher even when user config disables bin links: ${install.args.join(" ")}`);
  assert.equal(result.error?.code, "verification-failed");
  const recovery = (result.error?.message ?? "").split("reinstall the verified target with ")[1] ?? "";
  const unquoted = recovery.replaceAll(/'((?:[^']|'"'"')*)'/g, (_match, inner: string) => inner.replaceAll(`'"'"'`, "'"));
  const expected = [io.execPath, ...install.args.filter((argument, index, all) =>
    !["--no-audit", "--no-fund", "--loglevel"].includes(argument) && all[index - 1] !== "--loglevel")];
  assert.equal(unquoted, expected.join(" "), "recovery guidance repeats the executed arguments minus output noise");
});

test("update installs the exact validated version through npm with narrow arguments and verifies afterward", async () => {
  const { io, log } = createFakeIo({ currentVersion: "0.19.0", registry: registryDocument("0.20.0") });
  const result = await updateCli({ check: false, io });
  assert.equal(result.ok, true);
  assert.equal(result.status, "updated");
  assert.equal(result.installedVersion, "0.20.0");
  assert.equal(result.error, null);
  const install = log.processes.find((entry) => entry.args[1] === "install");
  assert.deepEqual(install?.args, [
    FAKE_NPM_CLI,
    "install",
    "--global",
    "--prefix",
    FAKE_PREFIX,
    "--registry",
    "https://registry.npmjs.org",
    "--ignore-scripts",
    "--bin-links=true",
    "--no-audit",
    "--no-fund",
    "--loglevel",
    "error",
    "skill-suitcase@0.20.0"
  ]);
  assert.equal(install?.file, "/fixtures/node/bin/node");
  assert.equal(install?.timeoutMs, 300_000);
  const ownershipQueries = log.processes.filter((entry) => entry.args[1] === "prefix").length;
  assert.equal(ownershipQueries, 2, "ownership is rechecked immediately before spawning npm");
  const smoke = log.processes.at(-1);
  assert.equal(smoke?.file, join(FAKE_PREFIX, "bin", "skill-suitcase"));
  assert.deepEqual(smoke?.args, ["--help"]);
  assert.equal(log.cacheRemovals, 1, "successful installation removes the passive cache");
});

test("an ownership change between the initial check and the install recheck refuses without spawning npm", async () => {
  const { io, log } = createFakeIo({ currentVersion: "0.19.0", registry: registryDocument("0.20.0") });
  const original = io.inspectPath;
  io.inspectPath = async (target) => {
    const rechecking = log.processes.filter((entry) => entry.args[1] === "prefix").length >= 2;
    if (rechecking && target === FAKE_PACKAGE_ROOT) return { kind: "symlink", realPath: "/fixtures/checkout" };
    return original(target);
  };
  const result = await updateCli({ check: false, io });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unsupported-installation");
  assert.equal(result.installation.reason, "global-link");
  assert.equal(result.latestVersion, "0.20.0", "the release lookup already happened before the recheck");
  assert.equal(log.processes.some((entry) => entry.args.includes("install")), false);
});

test("up-to-date and ahead updates succeed without reinstalling", async () => {
  for (const [current, status] of [["0.20.0", "up-to-date"], ["0.21.0", "ahead"]] as const) {
    const { io, log } = createFakeIo({ currentVersion: current, registry: registryDocument("0.20.0") });
    const result = await updateCli({ check: false, io });
    assert.equal(result.ok, true);
    assert.equal(result.status, status);
    assert.equal(result.action, "update");
    assert.equal(log.processes.some((entry) => entry.args.includes("install")), false);
  }
});

test("install failures are classified distinctly from verification failures", async () => {
  const cases: Array<[FakeIoModel, string, string | null]> = [
    [{ installExit: 1, installStderr: "npm ERR! code EACCES" }, "install-failed", null],
    [{ installTimedOut: true }, "install-timeout", null],
    [{ installedPackageJson: { name: "skill-suitcase", version: "0.19.5", bin: { "skill-suitcase": "dist/src/cli.js" } } }, "verification-failed", "0.19.5"],
    [{ installedPackageJson: { name: "skill-suitcase", version: "0.20.0", bin: { "skill-suitcase": "../outside/cli.js" } } }, "verification-failed", "0.20.0"],
    [{ installedPackageJson: { name: "skill-suitcase", version: "0.20.0", bin: { "skill-suitcase": "dist/src/missing.js" } } }, "verification-failed", "0.20.0"],
    [{ installedPackageJson: null }, "verification-failed", null],
    [{ launcherKind: "missing" }, "verification-failed", "0.20.0"],
    [{ launcherRealPath: join(FAKE_GLOBAL_ROOT, "stale", "cli.js") }, "verification-failed", "0.20.0"],
    [{ smokeExit: 1 }, "verification-failed", "0.20.0"],
    [{ smokeStderr: "" }, "verification-failed", "0.20.0"]
  ];
  for (const [model, code, installedVersion] of cases) {
    const { io } = createFakeIo({ ...model, registry: registryDocument("0.20.0") });
    const result = await updateCli({ check: false, io });
    assert.equal(result.ok, false, code);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, code, JSON.stringify(model));
    assert.equal(result.installedVersion, installedVersion, JSON.stringify(model));
    const message = result.error?.message ?? "";
    assert.match(message, /skill-suitcase@0\.20\.0/);
    assert.doesNotMatch(message, /sudo|npm ERR/);
    assert.ok(
      message.includes(`'${FAKE_NODE}' '${FAKE_NPM_CLI}' install --global --prefix '${FAKE_PREFIX}' --registry 'https://registry.npmjs.org' --ignore-scripts --bin-links=true skill-suitcase@0.20.0`),
      `recovery guidance names the verified npm and prefix: ${message}`
    );
  }
  const classifications: Array<[string, RegExp]> = [
    ["npm ERR! code EACCES\nnpm ERR! syscall mkdir", /\(permission denied\)/],
    ["npm ERR! code ENOTFOUND\nnpm ERR! network request failed", /\(registry or network error\)/],
    ["npm ERR! code E404\nnpm ERR! 404 Not Found", /\(registry or network error\)/],
    ["npm ERR! code EINTEGRITY\nnpm ERR! sha512 mismatch", /\(integrity check failed\)/],
    ["npm ERR! something unexpected", /\(npm exited with an error\)/]
  ];
  for (const [stderr, expected] of classifications) {
    const { io } = createFakeIo({ installExit: 1, installStderr: stderr, registry: registryDocument("0.20.0") });
    const result = await updateCli({ check: false, io });
    assert.equal(result.error?.code, "install-failed");
    assert.match(result.error?.message ?? "", expected, stderr);
  }
});

test("recovery commands preserve literal paths and registry through shell parsing", async () => {
  const special = "space 'quote\" $channel $(printf expanded) `printf expanded` \\path";
  const prefix = join("/fixtures", special, "prefix");
  const globalRoot = join(prefix, "lib", "node_modules");
  const npmCli = join("/fixtures", special, "npm-cli.js");
  const { io } = createFakeIo({
    prefix,
    globalRoot,
    packageRoot: join(globalRoot, "skill-suitcase"),
    npmCli,
    installExit: 1,
    registry: registryDocument("0.20.0")
  });
  io.execPath = join("/fixtures", special, "node");
  io.registryUrl = "https://registry.example.invalid/?channel='$channel&value=$(printf expanded)";
  const result = await updateCli({ check: false, io });
  assert.ok(result.error);
  assert.equal(result.error?.code, "install-failed");
  const command = result.error.message.split("reinstall the verified target with ")[1];
  assert.ok(command);
  const parsed = spawnSync("/bin/sh", ["-c", `set -- ${command}\nprintf '%s\\0' "$@"`], {
    encoding: "utf8",
    env: { channel: "expanded" }
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(parsed.stdout.split("\0"), [
    io.execPath, npmCli, "install", "--global", "--prefix", prefix,
    "--registry", io.registryUrl, "--ignore-scripts", "--bin-links=true", "skill-suitcase@0.20.0", ""
  ]);
});
