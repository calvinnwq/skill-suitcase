import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import semver from "semver";
import type { createUpdateIo, updateCli } from "../src/core/cli-update/index.js";

type InstalledCore = { createUpdateIo: typeof createUpdateIo; updateCli: typeof updateCli };
type Fixture = { version: string; tarball: string; bytes: Buffer; entrypoint: string };

const PACKAGE = "skill-suitcase";
const repoRoot = process.cwd();

async function buildFixture(root: string, version: string, options: { entrypoint: string; postinstallMarker?: string }): Promise<Fixture> {
  const directory = join(root, `fixture-${version}`);
  await mkdir(join(directory, "dist", "src"), { recursive: true });
  await cp(join(repoRoot, "dist", "src"), join(directory, "dist", "src"), { recursive: true });
  if (options.entrypoint !== "dist/src/cli.js") {
    await cp(join(directory, "dist", "src", "cli.js"), join(directory, options.entrypoint));
    await rm(join(directory, "dist", "src", "cli.js"));
  }
  for (const dependency of ["yaml", "semver"]) {
    await cp(await realpath(join(repoRoot, "node_modules", dependency)), join(directory, "node_modules", dependency), { recursive: true });
  }
  await writeFile(join(directory, "package.json"), `${JSON.stringify({
    name: PACKAGE,
    version,
    description: "TEST FIXTURE for skill-suitcase self-update integration; not a published release",
    private: false,
    type: "module",
    bin: { [PACKAGE]: options.entrypoint },
    dependencies: { yaml: "*", semver: "*" },
    bundleDependencies: ["yaml", "semver"],
    engines: { node: ">=20" },
    ...(options.postinstallMarker === undefined ? {} : {
      scripts: { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(options.postinstallMarker)}, 'ran')"` }
    })
  }, null, 2)}\n`);
  const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: directory, encoding: "utf8", env: { ...process.env, npm_config_update_notifier: "false" } });
  assert.equal(pack.status, 0, pack.stderr);
  const filename = (JSON.parse(pack.stdout) as Array<{ filename: string }>)[0]?.filename ?? "";
  const tarball = join(root, filename);
  return { version, tarball, bytes: await readFile(tarball), entrypoint: options.entrypoint };
}

function registryVersionDocument(fixture: Fixture, base: string): Record<string, unknown> {
  return {
    name: PACKAGE,
    version: fixture.version,
    engines: { node: ">=20" },
    bin: { [PACKAGE]: fixture.entrypoint },
    dist: {
      tarball: `${base}/${PACKAGE}/-/${PACKAGE}-${fixture.version}.tgz`,
      shasum: createHash("sha1").update(fixture.bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(fixture.bytes).digest("base64")}`
    }
  };
}

async function installGlobal(tarball: string, prefix: string, env: Record<string, string | undefined>): Promise<void> {
  const result = spawnSync("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel", "error", tarball],
    { cwd: prefix, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
}

async function hashTree(directory: string): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of (await readdir(directory, { recursive: true, withFileTypes: true })).sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))) {
    const path = join(entry.parentPath, entry.name);
    hash.update(path.slice(directory.length));
    if (entry.isFile()) hash.update(await readFile(path));
  }
  return hash.digest("hex");
}

async function installedVersion(prefix: string): Promise<string> {
  return (JSON.parse(await readFile(join(prefix, "lib", "node_modules", PACKAGE, "package.json"), "utf8")) as { version: string }).version;
}

test("self-update replaces a disposable global installation and verifies every boundary", { timeout: 240_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("self-update is reported unsupported on Windows; real npm replacement is verified on macOS and Linux");
    return;
  }
  const root = await realpath(await mkdtemp(join(os.tmpdir(), "skill-suitcase-self-update-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const prefix = join(root, "prefix with space");
  const otherPrefix = join(root, "other-prefix");
  const marker = join(root, "postinstall-marker");
  await mkdir(home, { recursive: true });
  await mkdir(prefix, { recursive: true });
  await mkdir(otherPrefix, { recursive: true });

  const repoVersion = (JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
  const versionA = semver.inc(repoVersion, "patch") ?? "0.0.1";
  const versionB = semver.inc(versionA, "patch") ?? "0.0.2";
  const versionC = semver.inc(versionB, "patch") ?? "0.0.3";
  const fixtureA = await buildFixture(root, versionA, { entrypoint: "dist/src/cli.js" });
  const fixtureB = await buildFixture(root, versionB, { entrypoint: "dist/src/cli.js", postinstallMarker: marker });
  const fixtureC = await buildFixture(root, versionC, { entrypoint: "dist/src/main.js", postinstallMarker: marker });

  let latest = fixtureB;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    requests.push(url);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fixtures = [fixtureA, fixtureB, fixtureC];
    const tarballMatch = url.match(new RegExp(`^/${PACKAGE}/-/${PACKAGE}-(.+)\\.tgz$`));
    const served = tarballMatch === null ? undefined : fixtures.find((fixture) => fixture.version === tarballMatch[1]);
    if (served !== undefined) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(served.bytes);
    } else if (url === `/${PACKAGE}/latest`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(registryVersionDocument(latest, base)));
    } else if (url === `/${PACKAGE}`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        name: PACKAGE,
        "dist-tags": { latest: latest.version },
        versions: Object.fromEntries(fixtures.map((fixture) => [fixture.version, registryVersionDocument(fixture, base)]))
      }));
    } else {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const registryUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    npm_config_prefix: prefix,
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_globalconfig: join(home, "npmrc-global"),
    npm_config_update_notifier: "false"
  };
  await installGlobal(fixtureA.tarball, prefix, env);
  await installGlobal(fixtureA.tarball, otherPrefix, { ...env, npm_config_prefix: otherPrefix });
  const copiedSkill = join(home, "copied-operator-skill");
  await cp(join(repoRoot, "skills", PACKAGE), copiedSkill, { recursive: true });
  const copiedSkillHash = await hashTree(copiedSkill);
  const otherPrefixHash = await hashTree(otherPrefix);
  await writeFile(join(home, ".cache", PACKAGE, "update-check.json"), "{}\n").catch(async () => {
    await mkdir(join(home, ".cache", PACKAGE), { recursive: true });
    await writeFile(join(home, ".cache", PACKAGE, "update-check.json"), "{}\n");
  });

  const installedPackage = join(prefix, "lib", "node_modules", PACKAGE);
  const core = await import(pathToFileURL(join(installedPackage, "dist", "src", "core", "cli-update", "index.js")).href) as InstalledCore;
  const io = core.createUpdateIo({ registryUrl, env });

  const check = await core.updateCli({ check: true, io });
  assert.equal(check.currentVersion, versionA, "installed metadata resolves from the installed module, not the repository cwd");
  assert.deepEqual([check.ok, check.status, check.latestVersion, check.installation.kind, check.installation.canSelfUpdate],
    [true, "update-available", versionB, "npm-global", true]);
  assert.equal(await installedVersion(prefix), versionA, "check-only does not install");

  const updated = await core.updateCli({ check: false, io });
  assert.deepEqual([updated.ok, updated.status, updated.installedVersion, updated.error], [true, "updated", versionB, null], JSON.stringify(updated));
  assert.equal(await installedVersion(prefix), versionB);
  assert.equal(await readlink(join(prefix, "bin", PACKAGE)).then((target) => join(prefix, "bin", target)), join(installedPackage, "dist", "src", "cli.js"));
  await assert.rejects(stat(marker), /ENOENT/, "lifecycle scripts do not run");
  await assert.rejects(stat(join(prefix, "package.json")), /ENOENT/, "no prefix-level package file is created");
  await assert.rejects(stat(join(prefix, "package-lock.json")), /ENOENT/, "no prefix-level lock file is created");
  await assert.rejects(stat(join(home, ".cache", PACKAGE, "update-check.json")), /ENOENT/, "successful update removes the passive cache");
  assert.equal(await hashTree(otherPrefix), otherPrefixHash, "a different prefix remains untouched");
  assert.equal(await installedVersion(otherPrefix), versionA);
  assert.equal(await hashTree(copiedSkill), copiedSkillHash, "the copied operator skill remains unchanged");
  assert.ok(requests.includes(`/${PACKAGE}/-/${PACKAGE}-${versionB}.tgz`), "npm fetched the exact selected version from the explicit registry");
  const freshHelp = spawnSync(join(prefix, "bin", PACKAGE), ["update", "--help"], { encoding: "utf8", env });
  assert.equal(freshHelp.status, 0);
  assert.equal(freshHelp.stdout, "");
  assert.match(freshHelp.stderr, /Usage:\n  skill-suitcase update/);

  const again = await core.updateCli({ check: false, io });
  assert.deepEqual([again.ok, again.status, again.installedVersion], [true, "up-to-date", null]);
  assert.equal(await installedVersion(prefix), versionB);

  latest = fixtureC;
  const unlinked = await core.updateCli({ check: false, io: core.createUpdateIo({ registryUrl, env: { ...env, npm_config_bin_links: "false" } }) });
  assert.deepEqual([unlinked.ok, unlinked.status, unlinked.error?.code, unlinked.installedVersion],
    [false, "failed", "verification-failed", versionC], JSON.stringify(unlinked));
  const unlinkedMessage = unlinked.error?.message ?? "";
  assert.match(unlinkedMessage, /launcher/);
  assert.ok(unlinkedMessage.includes(`${PACKAGE}@${versionC}`), `recovery guidance names the exact target: ${unlinkedMessage}`);
  const recoveryCommand = unlinkedMessage.split("reinstall the verified target with ")[1];
  assert.ok(recoveryCommand);
  const parsedRecovery = spawnSync("/bin/sh", ["-c", `set -- ${recoveryCommand}\nprintf '%s\\0' "$@"`], { encoding: "utf8" });
  assert.equal(parsedRecovery.status, 0, parsedRecovery.stderr);
  const recoveryArgs = parsedRecovery.stdout.split("\0").slice(0, -1);
  assert.equal(recoveryArgs[0], process.execPath, "recovery guidance names the verified Node.js executable");
  assert.deepEqual(recoveryArgs.slice(2), ["install", "--global", "--prefix", prefix,
    "--registry", registryUrl, "--ignore-scripts", `${PACKAGE}@${versionC}`]);
  assert.doesNotMatch(unlinkedMessage, /sudo/);

  // Model a missing package after an interrupted install so recovery must fetch it again.
  await rm(installedPackage, { recursive: true });
  requests.length = 0;
  const recovered = await io.runProcess(process.execPath, recoveryArgs.slice(1), {
    env: { ...env, npm_config_registry: "http://127.0.0.1:1", npm_config_ignore_scripts: "false", npm_config_bin_links: "true",
      npm_config_cache: join(root, "recovery-cache") },
    cwd: prefix,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024
  });
  assert.equal(recovered.failed, false, recovered.stderr);
  assert.ok(requests.includes(`/${PACKAGE}/-/${PACKAGE}-${versionC}.tgz`), "recovery fetches from the selected registry, not inherited configuration");
  assert.equal(await installedVersion(prefix), versionC);
  await assert.rejects(stat(marker), /ENOENT/, "recovery still disables lifecycle scripts despite inherited npm settings");
  const recoveredHelp = spawnSync(join(prefix, "bin", PACKAGE), ["--help"], { encoding: "utf8", env });
  assert.equal(recoveredHelp.status, 0, recoveredHelp.error?.message ?? recoveredHelp.stderr);
});
