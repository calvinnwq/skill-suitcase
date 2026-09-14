import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_UPDATE_PACKAGE_NAME } from "../config/cli-update.js";

export type RunningPackage = {
  root: string;
  name: string;
  version: unknown;
  bin: unknown;
  sourceCheckout: boolean;
};

export type RegistryFetchResult =
  | { ok: true; body: string }
  | { ok: false; reason: "timeout" | "redirect" | "http" | "network" | "too-large"; status?: number };

export type RegistryFetchOptions = {
  timeoutMs: number;
  maxBytes: number;
};

export type ProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  failed: boolean;
};

export type ProcessOptions = {
  env: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
  maxOutputBytes: number;
  cwd?: string;
};

export type PathInspection = {
  kind: "directory" | "file" | "symlink" | "missing";
  realPath: string | null;
};

export type NpmResolution = {
  execPath: string;
  platform: NodeJS.Platform;
  pathEnv: string | undefined;
};

const PACKAGE_ROOT_LAYOUTS = ["../../..", "../.."];

export const RUNNING_MODULE_URL = import.meta.url;

export async function readRunningPackage(moduleUrl: string = RUNNING_MODULE_URL): Promise<RunningPackage | null> {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  for (const layout of PACKAGE_ROOT_LAYOUTS) {
    const root = resolve(moduleDirectory, layout);
    const manifest = await readPackageJson(join(root, "package.json"));
    if (!isRecord(manifest) || manifest.name !== CLI_UPDATE_PACKAGE_NAME) {
      continue;
    }
    const sourceCheckout = (await inspectPath(join(root, ".git"))).kind !== "missing"
      || (await inspectPath(join(root, "src", "cli.ts"))).kind !== "missing";
    return { root, name: manifest.name, version: manifest.version, bin: manifest.bin, sourceCheckout };
  }
  return null;
}

export async function readPackageJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export async function inspectPath(target: string): Promise<PathInspection> {
  try {
    const link = await lstat(target);
    if (link.isSymbolicLink()) {
      return { kind: "symlink", realPath: await realpath(target).catch(() => null) };
    }
    return {
      kind: link.isDirectory() ? "directory" : "file",
      realPath: await realpath(target).catch(() => null)
    };
  } catch {
    return { kind: "missing", realPath: null };
  }
}

export async function fetchRegistryDocument(url: string, options: RegistryFetchOptions): Promise<RegistryFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref();
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "redirect", status: response.status };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "http", status: response.status };
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "too-large" };
    }
    return await readBoundedBody(response, options.maxBytes);
  } catch (error) {
    return { ok: false, reason: controller.signal.aborted || isAbortError(error) ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<RegistryFetchResult> {
  if (response.body === null) {
    return { ok: true, body: "" };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too-large" };
    }
    chunks.push(value);
  }
  return { ok: true, body: Buffer.concat(chunks).toString("utf8") };
}

export async function readCacheText(filePath: string): Promise<string | null> {
  const link = await lstat(filePath);
  if (link.isSymbolicLink() || !link.isFile()) {
    return null;
  }
  return readFile(filePath, "utf8");
}

export async function writeCacheText(filePath: string, text: string): Promise<void> {
  if (await isSymbolicLink(filePath)) {
    return;
  }
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`);
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

export async function removeCacheFile(filePath: string): Promise<void> {
  if (!(await isSymbolicLink(filePath))) {
    await rm(filePath, { force: true });
  }
}

async function isSymbolicLink(filePath: string): Promise<boolean> {
  const existing = await lstat(filePath).catch(() => null);
  return existing !== null && existing.isSymbolicLink();
}

export async function resolveNpmCli(resolution: NpmResolution): Promise<string | null> {
  const executableDirectory = dirname(resolution.execPath);
  const candidates = resolution.platform === "win32"
    ? [join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js")]
    : [join(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const directories = (resolution.pathEnv ?? "").split(delimiter).filter((entry) => entry.length > 0);
  const launchers = await Promise.all(directories.map((directory) => inspectPath(join(directory, "npm"))));
  for (const launcher of launchers) {
    if (launcher.realPath === null || launcher.kind === "directory") continue;
    if (basename(launcher.realPath) === "npm-cli.js") {
      candidates.push(launcher.realPath);
    } else if (basename(launcher.realPath) === "npm") {
      candidates.push(join(dirname(launcher.realPath), "npm-cli.js"));
    }
  }
  for (const candidate of candidates) {
    const entry = await inspectPath(candidate);
    if (entry.kind !== "file" || entry.realPath === null) continue;
    const manifest = await readPackageJson(join(dirname(dirname(entry.realPath)), "package.json"));
    if (isRecord(manifest) && manifest.name === "npm") {
      return entry.realPath;
    }
  }
  return null;
}

export function runProcess(file: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (status: number | null, failed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A grandchild may still hold the inherited pipes; release them so the caller and the event loop do not wait on it.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveResult({ status, stdout, stderr, timedOut, failed });
    };
    const child = spawn(file, args, {
      env: { ...options.env } as NodeJS.ProcessEnv,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd })
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const append = (current: string, chunk: Buffer): string =>
      current.length >= options.maxOutputBytes ? current : (current + chunk.toString("utf8")).slice(0, options.maxOutputBytes);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", () => finish(null, true));
    // After a timeout the child was killed; do not wait for "close", which needs every pipe holder to exit.
    child.on("exit", (status) => { if (timedOut) finish(status, true); });
    child.on("close", (status) => finish(status, timedOut || status !== 0));
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
