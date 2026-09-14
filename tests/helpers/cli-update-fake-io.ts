import { join } from "node:path";
import type {
  PathInspection,
  ProcessResult,
  RegistryFetchResult,
  RunningPackage
} from "../../src/adapters/cli-update.js";
import type { UpdateIo } from "../../src/core/cli-update/index.js";

export type FakeIoModel = {
  currentVersion?: string;
  sourceCheckout?: boolean;
  packageRoot?: string;
  runningPackage?: RunningPackage | null;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  env?: Record<string, string | undefined>;
  now?: number;
  npmCli?: string | null;
  prefix?: string;
  globalRoot?: string;
  slotKind?: PathInspection["kind"];
  slotRealPath?: string | null;
  registry?: RegistryFetchResult | (() => RegistryFetchResult);
  installedPackageJson?: unknown;
  installExit?: number;
  installTimedOut?: boolean;
  installStderr?: string;
  launcherKind?: PathInspection["kind"];
  launcherRealPath?: string | null;
  smokeExit?: number;
  smokeStderr?: string;
  cache?: string | null;
  cacheReadThrows?: boolean;
  cacheWriteThrows?: boolean;
  homeDirectory?: string;
  registryUrl?: string;
};

export type FakeIoLog = {
  fetches: Array<{ url: string; timeoutMs: number; maxBytes: number }>;
  processes: Array<{ file: string; args: string[]; timeoutMs: number; env: Record<string, string | undefined> }>;
  cacheWrites: string[];
  cacheReads: number;
  cacheRemovals: number;
  cache: string | null;
};

export const FAKE_PREFIX = "/fixtures/prefix with space";
export const FAKE_GLOBAL_ROOT = join(FAKE_PREFIX, "lib", "node_modules");
export const FAKE_PACKAGE_ROOT = join(FAKE_GLOBAL_ROOT, "skill-suitcase");
export const FAKE_NODE = "/fixtures/node/bin/node";
export const FAKE_NPM_CLI = "/fixtures/node/lib/node_modules/npm/bin/npm-cli.js";

export function registryDocument(version: string, extra: Record<string, unknown> = {}): RegistryFetchResult {
  return { ok: true, body: JSON.stringify({ name: "skill-suitcase", version, ...extra }) };
}

export function createFakeIo(model: FakeIoModel = {}): { io: UpdateIo; log: FakeIoLog } {
  const packageRoot = model.packageRoot ?? FAKE_PACKAGE_ROOT;
  const prefix = model.prefix ?? FAKE_PREFIX;
  const globalRoot = model.globalRoot ?? FAKE_GLOBAL_ROOT;
  const entrypoint = join(packageRoot, "dist", "src", "cli.js");
  const launcher = join(prefix, "bin", "skill-suitcase");
  const log: FakeIoLog = {
    fetches: [],
    processes: [],
    cacheWrites: [],
    cacheReads: 0,
    cacheRemovals: 0,
    cache: model.cache ?? null
  };
  const runningPackage: RunningPackage | null = model.runningPackage !== undefined
    ? model.runningPackage
    : {
      root: packageRoot,
      name: "skill-suitcase",
      version: model.currentVersion ?? "0.19.0",
      bin: { "skill-suitcase": "dist/src/cli.js" },
      sourceCheckout: model.sourceCheckout ?? false
    };
  let installed = false;
  const io: UpdateIo = {
    moduleUrl: "file:///fixtures/module.js",
    env: model.env ?? {},
    platform: model.platform ?? "darwin",
    execPath: FAKE_NODE,
    nodeVersion: model.nodeVersion ?? "v22.0.0",
    homeDirectory: model.homeDirectory ?? "/fixtures/home",
    registryUrl: model.registryUrl ?? "https://registry.npmjs.org",
    now: () => model.now ?? 1_800_000_000_000,
    readRunningPackage: async () => runningPackage,
    fetchRegistryDocument: async (url, options) => {
      log.fetches.push({ url, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes });
      const registry = model.registry ?? { ok: false, reason: "network" };
      return typeof registry === "function" ? registry() : registry;
    },
    readCacheText: async () => {
      log.cacheReads += 1;
      if (model.cacheReadThrows === true) throw new Error("EACCES");
      return log.cache;
    },
    writeCacheText: async (_path, text) => {
      if (model.cacheWriteThrows === true) throw new Error("EROFS");
      log.cacheWrites.push(text);
      log.cache = text;
    },
    removeCacheFile: async () => {
      log.cacheRemovals += 1;
      log.cache = null;
    },
    resolveNpmCli: async () => (model.npmCli === undefined ? FAKE_NPM_CLI : model.npmCli),
    runProcess: async (file, args, options) => {
      log.processes.push({ file, args, timeoutMs: options.timeoutMs, env: options.env });
      const ok: ProcessResult = { status: 0, stdout: "", stderr: "", timedOut: false, failed: false };
      if (args[1] === "prefix") return { ...ok, stdout: `${prefix}\n` };
      if (args[1] === "root") return { ...ok, stdout: `${globalRoot}\n` };
      if (args[1] === "install") {
        installed = true;
        if (model.installTimedOut === true) return { ...ok, status: null, timedOut: true, failed: true };
        const status = model.installExit ?? 0;
        return { ...ok, status, failed: status !== 0, stderr: model.installStderr ?? "" };
      }
      if (file === launcher) {
        const status = model.smokeExit ?? 0;
        return { ...ok, status, failed: status !== 0, stderr: model.smokeStderr ?? "Usage:\n  skill-suitcase <command>" };
      }
      return { ...ok, status: 1, failed: true, stderr: `unexpected process ${file}` };
    },
    inspectPath: async (target) => {
      if (target === join(globalRoot, "skill-suitcase")) {
        const kind = model.slotKind ?? "directory";
        const realPath = model.slotRealPath === undefined ? packageRoot : model.slotRealPath;
        return { kind, realPath: kind === "missing" ? null : realPath };
      }
      if (target === entrypoint) return { kind: "file", realPath: entrypoint };
      if (target === launcher) {
        const kind = model.launcherKind ?? "symlink";
        const realPath = model.launcherRealPath === undefined ? entrypoint : model.launcherRealPath;
        return { kind, realPath: kind === "missing" ? null : realPath };
      }
      return { kind: "missing", realPath: null };
    },
    readPackageJson: async (target) => {
      if (target !== join(packageRoot, "package.json") || !installed) return null;
      if (model.installedPackageJson !== undefined) return model.installedPackageJson;
      const registry = model.registry ?? { ok: false, reason: "network" };
      const resolved = typeof registry === "function" ? registry() : registry;
      const version = resolved.ok ? (JSON.parse(resolved.body) as { version: string }).version : "0.0.0";
      return { name: "skill-suitcase", version, bin: { "skill-suitcase": "dist/src/cli.js" } };
    }
  };
  return { io, log };
}
