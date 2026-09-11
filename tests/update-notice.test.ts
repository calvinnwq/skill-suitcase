import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dispatchCommand } from "../src/commands/index.js";
import { cacheFilePath, passiveUpdateNotice } from "../src/core/cli-update/index.js";
import { createFakeIo, registryDocument } from "./helpers/cli-update-fake-io.js";
import type { FakeIoModel } from "./helpers/cli-update-fake-io.js";

const NOW = 1_800_000_000_000;
const REGISTRY = "https://registry.npmjs.org";

function cacheEntry(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ version: 1, currentVersion: "0.19.0", registry: REGISTRY, checkedAt: NOW - 60_000, ok: true, latestVersion: "0.20.0", ...overrides })}\n`;
}

async function notice(model: FakeIoModel, interactive = true) {
  const { io, log } = createFakeIo({ currentVersion: "0.19.0", now: NOW, ...model });
  const result = await passiveUpdateNotice({ interactive, io });
  return { result, log };
}

test("passive notice is skipped with zero work when ineligible", async () => {
  const cases: Array<[FakeIoModel, boolean, string]> = [
    [{ registry: registryDocument("0.20.0") }, false, "non-interactive stderr"],
    [{ registry: registryDocument("0.20.0"), env: { CI: "true" } }, true, "CI"],
    [{ registry: registryDocument("0.20.0"), env: { CI: "1" } }, true, "CI=1"],
    [{ registry: registryDocument("0.20.0"), env: { SKILL_SUITCASE_NO_UPDATE_CHECK: "1" } }, true, "opt-out"],
    [{ registry: registryDocument("0.20.0"), currentVersion: "next" }, true, "invalid current version"],
    [{ registry: registryDocument("0.20.0"), runningPackage: null }, true, "unreadable package"]
  ];
  for (const [model, interactive, label] of cases) {
    const { result, log } = await notice(model, interactive);
    assert.equal(result, null, label);
    assert.equal(log.fetches.length, 0, label);
    assert.equal(log.cacheReads, 0, label);
    assert.equal(log.cacheWrites.length, 0, label);
    assert.equal(log.processes.length, 0, label);
  }
  for (const value of ["0", "false", ""]) {
    const { result } = await notice({ env: { CI: value }, cache: cacheEntry() });
    assert.equal(result?.latestVersion, "0.20.0", `CI=${JSON.stringify(value)} is not CI`);
  }
});

test("passive notice uses a fresh cache without fetching and refreshes stale or mismatched entries", async () => {
  const cached = await notice({ cache: cacheEntry() });
  assert.deepEqual(cached.result, { currentVersion: "0.19.0", latestVersion: "0.20.0", installation: "package" });
  assert.equal(cached.log.fetches.length, 0);
  assert.equal(cached.log.cacheWrites.length, 0);

  const source = await notice({ cache: cacheEntry(), sourceCheckout: true });
  assert.equal(source.result?.installation, "source");

  const staleCases: Array<[string, string]> = [
    [cacheEntry({ checkedAt: NOW - 25 * 60 * 60 * 1000 }), "expired success"],
    [cacheEntry({ currentVersion: "0.18.0" }), "different current version"],
    [cacheEntry({ registry: "https://example.invalid" }), "different registry"],
    [cacheEntry({ checkedAt: NOW + 5000 }), "future timestamp"],
    [cacheEntry({ latestVersion: "0.20.0-rc.1" }), "prerelease cache value"],
    [cacheEntry({ latestVersion: 20 }), "non-string version"],
    ["{corrupt", "corrupt JSON"],
    [cacheEntry({ version: 2 }), "unknown format version"],
    [cacheEntry({ ok: false, latestVersion: null, checkedAt: NOW - 2 * 60 * 60 * 1000 }), "expired failure"]
  ];
  for (const [cache, label] of staleCases) {
    const { result, log } = await notice({ cache, registry: registryDocument("0.21.0") });
    assert.equal(log.fetches.length, 1, label);
    assert.equal(log.fetches[0]?.timeoutMs, 750, label);
    assert.equal(result?.latestVersion, "0.21.0", label);
    assert.equal(log.cacheWrites.length, 1, label);
    assert.deepEqual(JSON.parse(log.cacheWrites[0] ?? ""), {
      version: 1, currentVersion: "0.19.0", registry: REGISTRY, checkedAt: NOW, ok: true, latestVersion: "0.21.0"
    });
  }
});

test("passive failures back off, stay silent, and never notify about downgrades", async () => {
  const offline = await notice({ registry: { ok: false, reason: "timeout" } });
  assert.equal(offline.result, null);
  assert.deepEqual(JSON.parse(offline.log.cacheWrites[0] ?? ""), {
    version: 1, currentVersion: "0.19.0", registry: REGISTRY, checkedAt: NOW, ok: false, latestVersion: null
  });

  const backoff = await notice({ cache: cacheEntry({ ok: false, latestVersion: null, checkedAt: NOW - 30 * 60 * 1000 }), registry: registryDocument("0.20.0") });
  assert.equal(backoff.result, null);
  assert.equal(backoff.log.fetches.length, 0, "recent failure suppresses another fetch");

  const unreadable = await notice({ cacheReadThrows: true, cacheWriteThrows: true, registry: registryDocument("0.20.0") });
  assert.deepEqual(unreadable.result, { currentVersion: "0.19.0", latestVersion: "0.20.0", installation: "package" });

  for (const latest of ["0.19.0", "0.18.0"]) {
    const { result } = await notice({ registry: registryDocument(latest) });
    assert.equal(result, null, latest);
  }
  const malformed = await notice({ registry: { ok: true, body: "[]" } });
  assert.equal(malformed.result, null);
  assert.equal(JSON.parse(malformed.log.cacheWrites[0] ?? "").ok, false);
});

test("cache path prefers an absolute XDG_CACHE_HOME and falls back to the home cache directory", () => {
  assert.equal(cacheFilePath({ env: { XDG_CACHE_HOME: "/cache root" }, homeDirectory: "/home/user" }),
    join("/cache root", "skill-suitcase", "update-check.json"));
  for (const xdg of [undefined, "", "relative/cache"]) {
    assert.equal(cacheFilePath({ env: { XDG_CACHE_HOME: xdg }, homeDirectory: "/home/user" }),
      join("/home/user", ".cache", "skill-suitcase", "update-check.json"));
  }
});

async function seededCacheHome(t: { after(fn: () => Promise<void>): void }, latestVersion: string): Promise<string> {
  const cacheHome = await mkdtemp(join(os.tmpdir(), "skill-suitcase-update-notice-"));
  t.after(() => rm(cacheHome, { recursive: true, force: true }));
  const { version } = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
  await mkdir(join(cacheHome, "skill-suitcase"), { recursive: true });
  await writeFile(join(cacheHome, "skill-suitcase", "update-check.json"), cacheEntry({ currentVersion: version, latestVersion, checkedAt: Date.now() - 1000 }));
  return cacheHome;
}

test("dispatch requests a notice only for successful interactive ordinary commands", async (t) => {
  const cacheHome = await seededCacheHome(t, "999.0.0");
  const previous = { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, CI: process.env.CI, SKILL_SUITCASE_NO_UPDATE_CHECK: process.env.SKILL_SUITCASE_NO_UPDATE_CHECK };
  process.env.XDG_CACHE_HOME = cacheHome;
  delete process.env.CI;
  delete process.env.SKILL_SUITCASE_NO_UPDATE_CHECK;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const catalog = join(process.cwd(), "tests", "fixtures", "skills-catalog");

  const interactive = await dispatchCommand(["validate", "--source", catalog, "--json"], { interactiveStderr: true });
  assert.equal(interactive.type, "result");
  if (interactive.type !== "result") return;
  assert.deepEqual(await interactive.notice, { currentVersion: JSON.parse(await readFile("package.json", "utf8")).version, latestVersion: "999.0.0", installation: "source" });

  const quiet = await dispatchCommand(["validate", "--source", catalog, "--json"], { interactiveStderr: false });
  assert.equal(quiet.type === "result" ? await quiet.notice : "missing", null);
  const implicit = await dispatchCommand(["validate", "--source", catalog, "--json"]);
  assert.equal(implicit.type === "result" ? await implicit.notice : "missing", null);
  assert.deepEqual(
    JSON.stringify(quiet.type === "result" ? quiet.result : null),
    JSON.stringify(interactive.result),
    "the JSON result is unchanged by the notice"
  );

  const failed = await dispatchCommand(["apply", "--source", cacheHome, "--target", "openclaw", "--lock", join(cacheHome, "missing.json"), "--json"],
    { interactiveStderr: true });
  assert.equal(failed.type === "result" ? failed.result.ok : true, false);
  assert.equal(failed.type === "result" ? await failed.notice : "missing", null);

  const usage = await dispatchCommand(["validate", "--nope"], { interactiveStderr: true });
  assert.equal(usage.type, "usage");
  const help = await dispatchCommand(["validate", "--help"], { interactiveStderr: true });
  assert.equal(help.type, "usage");

  const update = await dispatchCommand(["update", "--json"], { interactiveStderr: true });
  assert.equal(update.type === "result" ? await update.notice : "missing", null, "the update command never shows a passive notice");
  const summary = await dispatchCommand(["update"], { interactiveStderr: true });
  assert.equal(summary.type, "summary");

  process.env.SKILL_SUITCASE_NO_UPDATE_CHECK = "1";
  const optedOut = await dispatchCommand(["validate", "--source", catalog, "--json"], { interactiveStderr: true });
  assert.equal(optedOut.type === "result" ? await optedOut.notice : "missing", null);
});

test("interactive stderr shows the reminder while piped stdout bytes and exit code stay unchanged", async (t) => {
  const scriptBinary = spawnSync("script", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const hasScript = process.platform !== "win32" && !scriptBinary.error;
  if (!hasScript) {
    t.skip("no script(1) available to allocate a pseudo terminal");
    return;
  }
  const cacheHome = await seededCacheHome(t, "999.0.0");
  const catalog = join(process.cwd(), "tests", "fixtures", "skills-catalog");
  const cli = join(process.cwd(), "dist", "src", "cli.js");
  const stdoutFile = join(cacheHome, "stdout.json");
  const env: Record<string, string | undefined> = { ...process.env, XDG_CACHE_HOME: cacheHome, HOME: cacheHome, TERM: "dumb" };
  delete env.CI;
  delete env.SKILL_SUITCASE_NO_UPDATE_CHECK;
  const inner = `${process.execPath} ${cli} validate --source ${catalog} --json > ${stdoutFile}; printf 'exit=%s' "$?" >&2`;
  const args = process.platform === "darwin" ? ["-q", "/dev/null", "sh", "-c", inner] : ["-q", "-c", `sh -c '${inner.replace(/'/g, "'\\''")}'`, "/dev/null"];
  const pty = spawnSync("script", args, { encoding: "utf8", env, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(pty.status, 0, `${pty.stdout}\n${pty.stderr}`);
  const terminal = pty.stdout.replace(/\r/g, "");
  assert.match(terminal, /A newer skill-suitcase is available: \d+\.\d+\.\d+ -> 999\.0\.0\./);
  assert.match(terminal, /exit=0/);

  const piped = spawnSync(process.execPath, [cli, "validate", "--source", catalog, "--json"], { encoding: "utf8", env });
  assert.equal(piped.status, 0);
  assert.equal(piped.stderr, "", "non-interactive stderr suppresses the reminder entirely");
  assert.equal(await readFile(stdoutFile, "utf8"), piped.stdout, "stdout bytes are identical with and without the reminder");
});

test("a symlinked cache file is never followed or replaced", async (t) => {
  const cacheHome = await mkdtemp(join(os.tmpdir(), "skill-suitcase-update-notice-symlink-"));
  t.after(() => rm(cacheHome, { recursive: true, force: true }));
  const victim = join(cacheHome, "victim");
  await writeFile(victim, cacheEntry({ latestVersion: "999.0.0" }));
  await mkdir(join(cacheHome, "skill-suitcase"));
  await symlink(victim, join(cacheHome, "skill-suitcase", "update-check.json"));
  const { io } = createFakeIo({ currentVersion: "0.19.0", now: NOW, env: { XDG_CACHE_HOME: cacheHome }, registry: { ok: false, reason: "network" } });
  const realIo = await import("../src/adapters/cli-update.js");
  io.readCacheText = realIo.readCacheText;
  io.writeCacheText = realIo.writeCacheText;
  assert.equal(await passiveUpdateNotice({ interactive: true, io }), null);
  assert.equal(await readFile(victim, "utf8"), cacheEntry({ latestVersion: "999.0.0" }));
});
