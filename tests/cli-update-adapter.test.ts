import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  fetchRegistryDocument,
  inspectPath,
  readCacheText,
  readRunningPackage,
  removeCacheFile,
  resolveNpmCli,
  runProcess,
  writeCacheText
} from "../src/adapters/cli-update.js";

async function temporaryRoot(t: { after(fn: () => Promise<void>): void }, label: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(os.tmpdir(), `skill-suitcase-update-adapter-${label}-`)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`);
}

test("running package metadata resolves from the module location in packed and source layouts", async (t) => {
  const root = await temporaryRoot(t, "layouts");
  const packed = join(root, "packed", "skill-suitcase");
  await writeJson(join(packed, "package.json"), { name: "skill-suitcase", version: "1.2.3", bin: { "skill-suitcase": "dist/src/cli.js" } });
  await mkdir(join(packed, "dist", "src", "adapters"), { recursive: true });
  const packedModule = pathToFileURL(join(packed, "dist", "src", "adapters", "cli-update.js")).href;
  assert.deepEqual(await readRunningPackage(packedModule), {
    root: packed, name: "skill-suitcase", version: "1.2.3", bin: { "skill-suitcase": "dist/src/cli.js" }, sourceCheckout: false
  });

  const source = join(root, "source");
  await writeJson(join(source, "package.json"), { name: "skill-suitcase", version: "0.0.0-dev" });
  await mkdir(join(source, "src", "adapters"), { recursive: true });
  await writeFile(join(source, "src", "cli.ts"), "");
  const sourceModule = pathToFileURL(join(source, "src", "adapters", "cli-update.ts")).href;
  assert.equal((await readRunningPackage(sourceModule))?.sourceCheckout, true);

  const gitCheckout = join(root, "git", "skill-suitcase");
  await writeJson(join(gitCheckout, "package.json"), { name: "skill-suitcase", version: "1.2.3" });
  await writeFile(join(gitCheckout, ".git"), "gitdir: elsewhere\n");
  await mkdir(join(gitCheckout, "dist", "src", "adapters"), { recursive: true });
  assert.equal((await readRunningPackage(pathToFileURL(join(gitCheckout, "dist", "src", "adapters", "x.js")).href))?.sourceCheckout, true);

  const other = join(root, "other");
  await writeJson(join(other, "package.json"), { name: "some-other-package", version: "1.0.0" });
  await mkdir(join(other, "dist", "src", "adapters"), { recursive: true });
  assert.equal(await readRunningPackage(pathToFileURL(join(other, "dist", "src", "adapters", "x.js")).href), null);
  assert.equal((await readRunningPackage())?.name, "skill-suitcase", "the default module URL is this package");
});

test("registry fetch is bounded by time, size, and redirects", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/ok") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name: "skill-suitcase", version: "9.9.9" }));
    } else if (request.url === "/redirect") {
      response.writeHead(302, { location: "/ok" });
      response.end();
    } else if (request.url === "/large") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"pad":"${"x".repeat(4096)}"}`);
    } else if (request.url === "/stream") {
      response.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      for (let index = 0; index < 8; index += 1) response.write("x".repeat(512));
      response.end();
    } else if (request.url === "/slow") {
      setTimeout(() => response.end("{}"), 2000).unref();
    } else {
      response.writeHead(503);
      response.end("down");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  assert.deepEqual(await fetchRegistryDocument(`${base}/ok`, { timeoutMs: 2000, maxBytes: 4096 }),
    { ok: true, body: JSON.stringify({ name: "skill-suitcase", version: "9.9.9" }) });
  assert.deepEqual(await fetchRegistryDocument(`${base}/redirect`, { timeoutMs: 2000, maxBytes: 4096 }),
    { ok: false, reason: "redirect", status: 302 });
  assert.deepEqual(await fetchRegistryDocument(`${base}/large`, { timeoutMs: 2000, maxBytes: 1024 }),
    { ok: false, reason: "too-large" });
  assert.deepEqual(await fetchRegistryDocument(`${base}/stream`, { timeoutMs: 2000, maxBytes: 1024 }),
    { ok: false, reason: "too-large" }, "the streaming guard rejects a chunked body with no declared length");
  assert.deepEqual(await fetchRegistryDocument(`${base}/down`, { timeoutMs: 2000, maxBytes: 4096 }),
    { ok: false, reason: "http", status: 503 });
  const started = Date.now();
  assert.deepEqual(await fetchRegistryDocument(`${base}/slow`, { timeoutMs: 150, maxBytes: 4096 }),
    { ok: false, reason: "timeout" });
  assert.ok(Date.now() - started < 1500, "timeout aborts the slow request");
  assert.equal((await fetchRegistryDocument("http://127.0.0.1:1/unreachable", { timeoutMs: 2000, maxBytes: 4096 })).ok, false);
});

test("cache IO writes atomically and ignores symlinked cache files", async (t) => {
  const root = await temporaryRoot(t, "cache");
  const cacheFile = join(root, "nested", "update-check.json");
  await writeCacheText(cacheFile, "{\"a\":1}\n");
  assert.equal(await readCacheText(cacheFile), "{\"a\":1}\n");
  assert.deepEqual(await readdir(join(root, "nested")), ["update-check.json"], "no temporary sibling remains");
  await removeCacheFile(cacheFile);
  await assert.rejects(readCacheText(cacheFile), /ENOENT/);

  const victim = join(root, "victim.json");
  await writeFile(victim, "keep\n");
  const linked = join(root, "linked.json");
  await symlink(victim, linked);
  assert.equal(await readCacheText(linked), null);
  await writeCacheText(linked, "replaced\n");
  await removeCacheFile(linked);
  assert.equal(await readFile(victim, "utf8"), "keep\n");
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
});

test("npm resolution accepts bundled and PATH layouts and rejects unfamiliar wrappers", async (t) => {
  const root = await temporaryRoot(t, "npm");
  const makeNpm = async (npmRoot: string): Promise<string> => {
    await writeJson(join(npmRoot, "package.json"), { name: "npm", version: "10.0.0" });
    await mkdir(join(npmRoot, "bin"), { recursive: true });
    await writeFile(join(npmRoot, "bin", "npm-cli.js"), "#!/usr/bin/env node\n");
    await writeFile(join(npmRoot, "bin", "npm"), "#!/bin/sh\n");
    return join(npmRoot, "bin", "npm-cli.js");
  };

  const unixNode = join(root, "unix node", "bin", "node");
  await mkdir(join(root, "unix node", "bin"), { recursive: true });
  const bundled = await makeNpm(join(root, "unix node", "lib", "node_modules", "npm"));
  assert.equal(await resolveNpmCli({ execPath: unixNode, platform: "darwin", pathEnv: undefined }), bundled);
  assert.equal(await resolveNpmCli({ execPath: unixNode, platform: "linux", pathEnv: "" }), bundled);

  const windowsNode = join(root, "win", "node.exe");
  await mkdir(join(root, "win"), { recursive: true });
  const windowsNpm = await makeNpm(join(root, "win", "node_modules", "npm"));
  assert.equal(await resolveNpmCli({ execPath: windowsNode, platform: "win32", pathEnv: undefined }), windowsNpm);

  const bareNode = join(root, "bare", "bin", "node");
  await mkdir(join(root, "bare", "bin"), { recursive: true });
  const pathNpm = await makeNpm(join(root, "path-npm", "lib", "node_modules", "npm"));
  await mkdir(join(root, "path-bin"), { recursive: true });
  await symlink(pathNpm, join(root, "path-bin", "npm"));
  assert.equal(await resolveNpmCli({ execPath: bareNode, platform: "darwin", pathEnv: `${join(root, "missing")}:${join(root, "path-bin")}` }), pathNpm);

  assert.equal(await resolveNpmCli({ execPath: unixNode, platform: "darwin", pathEnv: join(root, "path-bin") }), bundled,
    "the npm beside the running runtime wins over a PATH npm");

  await mkdir(join(root, "script-bin"), { recursive: true });
  await symlink(join(root, "path-npm", "lib", "node_modules", "npm", "bin", "npm"), join(root, "script-bin", "npm"));
  assert.equal(await resolveNpmCli({ execPath: bareNode, platform: "linux", pathEnv: join(root, "script-bin") }), pathNpm);

  await mkdir(join(root, "wrapper-bin"), { recursive: true });
  await writeFile(join(root, "wrapper-bin", "npm"), "#!/bin/sh\nexec volta run npm \"$@\"\n");
  assert.equal(await resolveNpmCli({ execPath: bareNode, platform: "linux", pathEnv: join(root, "wrapper-bin") }), null);
  assert.equal(await resolveNpmCli({ execPath: bareNode, platform: "linux", pathEnv: undefined }), null);

  const impostorRoot = join(root, "impostor", "lib", "node_modules", "npm");
  await mkdir(join(impostorRoot, "bin"), { recursive: true });
  await writeJson(join(impostorRoot, "package.json"), { name: "not-npm" });
  await writeFile(join(impostorRoot, "bin", "npm-cli.js"), "");
  assert.equal(await resolveNpmCli({ execPath: join(root, "impostor", "bin", "node"), platform: "linux", pathEnv: undefined }), null);
});

test("process execution is shell-free, output-bounded, and time-bounded", async () => {
  const echo = await runProcess(process.execPath, ["-e", "process.stdout.write('a $HOME b'); process.stderr.write('x'.repeat(100))"], {
    env: { PATH: process.env.PATH }, timeoutMs: 5000, maxOutputBytes: 16
  });
  assert.deepEqual(echo, { status: 0, stdout: "a $HOME b", stderr: "x".repeat(16), timedOut: false, failed: false });

  const failing = await runProcess(process.execPath, ["-e", "process.exit(3)"], { env: {}, timeoutMs: 5000, maxOutputBytes: 1024 });
  assert.equal(failing.status, 3);
  assert.equal(failing.failed, true);

  const slow = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { env: {}, timeoutMs: 200, maxOutputBytes: 1024 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.failed, true);

  const missing = await runProcess(join(os.tmpdir(), "definitely-missing-executable"), [], { env: {}, timeoutMs: 1000, maxOutputBytes: 1024 });
  assert.equal(missing.failed, true);
  assert.equal(missing.status, null);
});

test("a timed-out process settles even when a grandchild keeps the output pipes open", async () => {
  // The direct child inherits its pipes to a grandchild that outlives the SIGKILL, so "close" would wait for the grandchild.
  const script = "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'inherit' }); setTimeout(() => {}, 30000)";
  const started = Date.now();
  const result = await runProcess(process.execPath, ["-e", script], { env: { PATH: process.env.PATH }, timeoutMs: 200, maxOutputBytes: 1024 });
  assert.equal(result.timedOut, true);
  assert.equal(result.failed, true);
  assert.ok(Date.now() - started < 2000, "the promise settles when the child exits, not when the grandchild releases the pipes");
});

test("path inspection distinguishes directories, files, symlinks, and missing entries", async (t) => {
  const root = await temporaryRoot(t, "inspect");
  await mkdir(join(root, "dir"));
  await writeFile(join(root, "file"), "");
  await symlink(join(root, "dir"), join(root, "link"));
  assert.deepEqual(await inspectPath(join(root, "dir")), { kind: "directory", realPath: (await inspectPath(join(root, "dir"))).realPath });
  assert.equal((await inspectPath(join(root, "file"))).kind, "file");
  const link = await inspectPath(join(root, "link"));
  assert.equal(link.kind, "symlink");
  assert.equal(link.realPath, (await inspectPath(join(root, "dir"))).realPath);
  assert.deepEqual(await inspectPath(join(root, "missing")), { kind: "missing", realPath: null });
  await symlink(join(root, "gone"), join(root, "dangling"));
  assert.deepEqual(await inspectPath(join(root, "dangling")), { kind: "symlink", realPath: null });
});
