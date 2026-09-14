import os from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import semver from "semver";
import {
  fetchRegistryDocument,
  inspectPath,
  readCacheText,
  readPackageJson,
  readRunningPackage,
  removeCacheFile,
  resolveNpmCli,
  runProcess,
  RUNNING_MODULE_URL,
  writeCacheText
} from "../../adapters/cli-update.js";
import type {
  NpmResolution,
  PathInspection,
  ProcessOptions,
  ProcessResult,
  RegistryFetchOptions,
  RegistryFetchResult,
  RunningPackage
} from "../../adapters/cli-update.js";
import {
  CLI_UPDATE_CACHE_DIRECTORY,
  CLI_UPDATE_CACHE_FAILURE_TTL_MS,
  CLI_UPDATE_CACHE_FILE,
  CLI_UPDATE_CACHE_SUCCESS_TTL_MS,
  CLI_UPDATE_DISCOVERY_TIMEOUT_MS,
  CLI_UPDATE_EXPLICIT_TIMEOUT_MS,
  CLI_UPDATE_INSTALL_TIMEOUT_MS,
  CLI_UPDATE_METADATA_MAX_BYTES,
  CLI_UPDATE_OPT_OUT_ENV,
  CLI_UPDATE_PACKAGE_NAME,
  CLI_UPDATE_PASSIVE_TIMEOUT_MS,
  CLI_UPDATE_PROCESS_OUTPUT_MAX_BYTES,
  CLI_UPDATE_REGISTRY_URL
} from "../../config/cli-update.js";

export type UpdateIo = {
  moduleUrl: string;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  execPath: string;
  nodeVersion: string;
  homeDirectory: string;
  registryUrl: string;
  now(): number;
  readRunningPackage(moduleUrl: string): Promise<RunningPackage | null>;
  fetchRegistryDocument(url: string, options: RegistryFetchOptions): Promise<RegistryFetchResult>;
  readCacheText(filePath: string): Promise<string | null>;
  writeCacheText(filePath: string, text: string): Promise<void>;
  removeCacheFile(filePath: string): Promise<void>;
  resolveNpmCli(resolution: NpmResolution): Promise<string | null>;
  runProcess(file: string, args: string[], options: ProcessOptions): Promise<ProcessResult>;
  inspectPath(target: string): Promise<PathInspection>;
  readPackageJson(filePath: string): Promise<unknown>;
};

export type CliUpdateStatus =
  | "update-available"
  | "up-to-date"
  | "ahead"
  | "updated"
  | "unsupported-installation"
  | "failed";

export type CliUpdateErrorCode =
  | "invalid-current-version"
  | "registry-unreachable"
  | "registry-response-invalid"
  | "unsupported-installation"
  | "node-engine-incompatible"
  | "install-failed"
  | "install-timeout"
  | "verification-failed";

export type CliInstallationReason =
  | "npm-not-found"
  | "npm-query-failed"
  | "source-checkout"
  | "package-metadata-invalid"
  | "outside-global-root"
  | "global-link"
  | "unsupported-platform";

export type CliInstallation = {
  kind: "npm-global" | "unsupported";
  canSelfUpdate: boolean;
  reason: CliInstallationReason | null;
  guidance: string;
};

export type CliUpdateResult = {
  ok: boolean;
  action: "check" | "update";
  status: CliUpdateStatus;
  currentVersion: string | null;
  latestVersion: string | null;
  installedVersion: string | null;
  updateAvailable: boolean | null;
  installation: CliInstallation;
  error: { code: CliUpdateErrorCode; message: string } | null;
};

export type CliUpdateNotice = {
  currentVersion: string;
  latestVersion: string;
  installation: "package" | "source";
};

type Release = { version: string; enginesNode: string | null };
type ReleaseLookup = { ok: true; release: Release } | { ok: false; code: "registry-unreachable" | "registry-response-invalid"; message: string };
type Ownership = { installation: CliInstallation; context: { npmCli: string; prefix: string; globalRoot: string } | null };
type CacheEntry = { version: 1; currentVersion: string; registry: string; checkedAt: number; ok: boolean; latestVersion: string | null };

const REINSTALL_HINT = `npm install --global ${CLI_UPDATE_PACKAGE_NAME}`;
const GUIDANCE: Record<CliInstallationReason | "npm-global", string> = {
  "npm-global": "The CLI is installed in npm's global root; update installs the exact latest stable release there.",
  "npm-not-found": `npm was not found beside the running Node.js runtime or on PATH; install npm, then run ${REINSTALL_HINT}.`,
  "npm-query-failed": `npm could not report its global prefix; run npm prefix --global to diagnose, then reinstall with ${REINSTALL_HINT}.`,
  "source-checkout": `The CLI runs from a source checkout; update it with git and rebuild, or install the published package with ${REINSTALL_HINT}.`,
  "package-metadata-invalid": `The running package metadata is unreadable or invalid; reinstall with ${REINSTALL_HINT}.`,
  "outside-global-root": `The CLI is not installed in npm's global root (project-local, ephemeral runner, or another package manager); update it with the tool that installed it, or install globally with ${REINSTALL_HINT}.`,
  "global-link": `The CLI is linked into npm's global root (npm link); update the linked checkout instead, or install the published package with ${REINSTALL_HINT}.`,
  "unsupported-platform": `Self-update is not verified on this platform; run ${REINSTALL_HINT}@<version> manually.`
};

export function createUpdateIo(overrides: Partial<UpdateIo> = {}): UpdateIo {
  return {
    moduleUrl: RUNNING_MODULE_URL,
    env: process.env,
    platform: process.platform,
    execPath: process.execPath,
    nodeVersion: process.version,
    homeDirectory: os.homedir(),
    registryUrl: CLI_UPDATE_REGISTRY_URL,
    now: () => Date.now(),
    readRunningPackage,
    fetchRegistryDocument,
    readCacheText,
    writeCacheText,
    removeCacheFile,
    resolveNpmCli,
    runProcess,
    inspectPath,
    readPackageJson,
    ...overrides
  };
}

export function isCliUpdateResult(value: unknown): value is CliUpdateResult {
  return typeof value === "object" && value !== null && "action" in value && "installation" in value
    && ((value as { action: unknown }).action === "check" || (value as { action: unknown }).action === "update");
}

export async function updateCli(options: { check: boolean; io?: UpdateIo }): Promise<CliUpdateResult> {
  // Rebuilt field by field so the JSON key order on stdout is stable regardless of which branch produced it.
  const result = await resolveUpdate(options);
  return {
    ok: result.ok,
    action: result.action,
    status: result.status,
    currentVersion: result.currentVersion,
    latestVersion: result.latestVersion,
    installedVersion: result.installedVersion,
    updateAvailable: result.updateAvailable,
    installation: result.installation,
    error: result.error
  };
}

async function resolveUpdate(options: { check: boolean; io?: UpdateIo }): Promise<CliUpdateResult> {
  const io = options.io ?? createUpdateIo();
  const action = options.check ? "check" : "update";
  const running = await io.readRunningPackage(io.moduleUrl);
  const currentVersion = running === null ? null : validVersion(running.version);
  const base = {
    action,
    currentVersion,
    latestVersion: null,
    installedVersion: null,
    updateAvailable: null
  } as const;
  const ownership = await classifyInstallation(io, running);
  if (running === null || currentVersion === null) {
    return { ...base, ok: false, status: "failed", installation: ownership.installation,
      error: { code: "invalid-current-version", message: "The running package does not declare a valid version." } };
  }
  if (!options.check && ownership.context === null) {
    return { ...base, ok: false, status: "unsupported-installation", installation: ownership.installation,
      error: { code: "unsupported-installation", message: ownership.installation.guidance } };
  }
  const lookup = await lookupLatestRelease(io, CLI_UPDATE_EXPLICIT_TIMEOUT_MS);
  if (!lookup.ok) {
    return { ...base, ok: false, status: "failed", installation: ownership.installation,
      error: { code: lookup.code, message: lookup.message } };
  }
  const release = lookup.release;
  const status = compareVersions(currentVersion, release.version);
  const checked = { ...base, latestVersion: release.version, updateAvailable: status === "update-available" };
  if (options.check || status !== "update-available" || ownership.context === null) {
    return { ...checked, ok: true, status, installation: ownership.installation, error: null };
  }
  if (release.enginesNode !== null && !semver.satisfies(io.nodeVersion, release.enginesNode)) {
    return { ...checked, ok: false, status: "failed", installation: ownership.installation, error: { code: "node-engine-incompatible",
      message: `${CLI_UPDATE_PACKAGE_NAME}@${release.version} requires Node.js ${release.enginesNode}; upgrade Node.js before updating.` } };
  }
  return performInstall(io, running, ownership.installation, release, checked);
}

async function performInstall(
  io: UpdateIo,
  running: RunningPackage,
  installation: CliInstallation,
  release: Release,
  checked: Omit<CliUpdateResult, "ok" | "status" | "installation" | "error">
): Promise<CliUpdateResult> {
  const target = `${CLI_UPDATE_PACKAGE_NAME}@${release.version}`;
  const fail = (code: CliUpdateErrorCode, message: string, installedVersion: string | null = null): CliUpdateResult => ({
    ...checked, ok: false, status: "failed", installedVersion, installation, error: { code, message }
  });
  const recheck = await classifyInstallation(io, running);
  if (recheck.context === null) {
    return { ...checked, ok: false, status: "unsupported-installation", installation: recheck.installation,
      error: { code: "unsupported-installation", message: recheck.installation.guidance } };
  }
  const context = recheck.context;
  // Safeguards that must survive inherited npm configuration; the recovery hint repeats exactly these.
  const safeguards = [
    context.npmCli, "install", "--global", "--prefix", context.prefix, "--registry", io.registryUrl,
    "--ignore-scripts", "--bin-links=true", target
  ];
  const external = new Set([io.execPath, context.npmCli, context.prefix, io.registryUrl]);
  const quoteArgument = (value: string): string => external.has(value) ? `'${value.replaceAll("'", "'\"'\"'")}'` : value;
  const recovery = `The installation may be partially changed; reinstall the verified target with ${[io.execPath, ...safeguards].map(quoteArgument).join(" ")}`;
  const install = await io.runProcess(io.execPath, [
    ...safeguards.slice(0, -1), "--no-audit", "--no-fund", "--loglevel", "error", target
  ], { env: io.env, timeoutMs: CLI_UPDATE_INSTALL_TIMEOUT_MS, maxOutputBytes: CLI_UPDATE_PROCESS_OUTPUT_MAX_BYTES, cwd: context.prefix });
  if (install.timedOut) {
    return fail("install-timeout", `npm install ${target} did not finish within the time limit. ${recovery}`);
  }
  if (install.failed) {
    return fail("install-failed", `npm install ${target} failed (${classifyNpmFailure(install.stderr)}). ${recovery}`);
  }
  const packageRoot = join(context.globalRoot, CLI_UPDATE_PACKAGE_NAME);
  const manifest = await io.readPackageJson(join(packageRoot, "package.json"));
  const installedVersion = isRecord(manifest) ? validVersion(manifest.version) : null;
  const verify = (message: string): CliUpdateResult =>
    fail("verification-failed", `${target} installed but verification failed: ${message} ${recovery}`, installedVersion);
  if (!isRecord(manifest) || installedVersion !== release.version) {
    return verify("the installed package version does not match the selected release.");
  }
  const entrypoint = declaredEntrypoint(packageRoot, manifest.bin);
  const entrypointInspection = entrypoint === null ? null : await io.inspectPath(entrypoint);
  if (entrypoint === null || entrypointInspection === null || entrypointInspection.kind !== "file") {
    return verify("the installed package does not declare a usable entrypoint inside the package.");
  }
  const launcher = join(context.prefix, "bin", CLI_UPDATE_PACKAGE_NAME);
  const launcherInspection = await io.inspectPath(launcher);
  const entrypointReal = entrypointInspection.realPath ?? entrypoint;
  if (launcherInspection.kind === "missing" || launcherInspection.realPath !== entrypointReal) {
    return verify("the global launcher is missing or does not target the installed entrypoint.");
  }
  const smoke = await io.runProcess(launcher, ["--help"], {
    env: { ...io.env, PATH: prependPath(io.env.PATH, io.execPath) },
    timeoutMs: CLI_UPDATE_DISCOVERY_TIMEOUT_MS,
    maxOutputBytes: CLI_UPDATE_PROCESS_OUTPUT_MAX_BYTES
  });
  if (smoke.failed || !smoke.stderr.includes("Usage:")) {
    return verify("the installed launcher did not run help in a fresh process.");
  }
  await io.removeCacheFile(cacheFilePath(io)).catch(() => undefined);
  return { ...checked, ok: true, status: "updated", installedVersion, installation, error: null };
}

export async function passiveUpdateNotice(options: { interactive: boolean; io?: UpdateIo }): Promise<CliUpdateNotice | null> {
  if (!options.interactive) return null;
  const io = options.io ?? createUpdateIo();
  if (isTruthyEnv(io.env[CLI_UPDATE_OPT_OUT_ENV]) || isTruthyEnv(io.env.CI)) return null;
  const running = await io.readRunningPackage(io.moduleUrl);
  const currentVersion = running === null ? null : validVersion(running.version);
  if (running === null || currentVersion === null) return null;
  const cachePath = cacheFilePath(io);
  const now = io.now();
  let entry = readCacheEntry(await io.readCacheText(cachePath).catch(() => null), currentVersion, io.registryUrl, now);
  if (entry === null) {
    const lookup = await lookupLatestRelease(io, CLI_UPDATE_PASSIVE_TIMEOUT_MS);
    entry = { version: 1, currentVersion, registry: io.registryUrl, checkedAt: now, ok: lookup.ok,
      latestVersion: lookup.ok ? lookup.release.version : null };
    await io.writeCacheText(cachePath, `${JSON.stringify(entry)}\n`).catch(() => undefined);
  }
  if (!entry.ok || entry.latestVersion === null || compareVersions(currentVersion, entry.latestVersion) !== "update-available") {
    return null;
  }
  return { currentVersion, latestVersion: entry.latestVersion, installation: running.sourceCheckout ? "source" : "package" };
}

export function cacheFilePath(io: Pick<UpdateIo, "env" | "homeDirectory">): string {
  const xdg = io.env.XDG_CACHE_HOME;
  const base = xdg !== undefined && xdg.length > 0 && isAbsolute(xdg) ? xdg : join(io.homeDirectory, ".cache");
  return join(base, CLI_UPDATE_CACHE_DIRECTORY, CLI_UPDATE_CACHE_FILE);
}

function readCacheEntry(text: string | null, currentVersion: string, registry: string, now: number): CacheEntry | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.currentVersion !== currentVersion || parsed.registry !== registry
    || typeof parsed.checkedAt !== "number" || !Number.isFinite(parsed.checkedAt) || parsed.checkedAt > now
    || typeof parsed.ok !== "boolean") {
    return null;
  }
  const latestVersion = parsed.latestVersion === null ? null : validVersion(parsed.latestVersion);
  if (parsed.ok && (latestVersion === null || semver.prerelease(latestVersion) !== null)) return null;
  const ttl = parsed.ok ? CLI_UPDATE_CACHE_SUCCESS_TTL_MS : CLI_UPDATE_CACHE_FAILURE_TTL_MS;
  if (now - parsed.checkedAt > ttl) return null;
  return { version: 1, currentVersion, registry, checkedAt: parsed.checkedAt, ok: parsed.ok, latestVersion };
}

async function lookupLatestRelease(io: UpdateIo, timeoutMs: number): Promise<ReleaseLookup> {
  const fetched = await io.fetchRegistryDocument(`${io.registryUrl}/${CLI_UPDATE_PACKAGE_NAME}/latest`, {
    timeoutMs, maxBytes: CLI_UPDATE_METADATA_MAX_BYTES
  });
  if (!fetched.ok) {
    return fetched.reason === "redirect" || fetched.reason === "too-large"
      ? { ok: false, code: "registry-response-invalid", message: `The registry response was rejected (${fetched.reason}).` }
      : { ok: false, code: "registry-unreachable", message: `The registry could not be reached (${fetched.reason}).` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fetched.body);
  } catch {
    return { ok: false, code: "registry-response-invalid", message: "The registry response was not valid JSON." };
  }
  const version = isRecord(parsed) && parsed.name === CLI_UPDATE_PACKAGE_NAME ? validVersion(parsed.version) : null;
  if (!isRecord(parsed) || version === null || semver.prerelease(version) !== null) {
    return { ok: false, code: "registry-response-invalid", message: "The registry response did not describe a stable release." };
  }
  const engines = isRecord(parsed.engines) && typeof parsed.engines.node === "string" ? parsed.engines.node : null;
  if (engines !== null && semver.validRange(engines) === null) {
    return { ok: false, code: "registry-response-invalid", message: "The registry response declared an invalid Node.js engine range." };
  }
  return { ok: true, release: { version, enginesNode: engines } };
}

async function classifyInstallation(io: UpdateIo, running: RunningPackage | null): Promise<Ownership> {
  const unsupported = (reason: CliInstallationReason): Ownership => ({
    installation: { kind: "unsupported", canSelfUpdate: false, reason, guidance: GUIDANCE[reason] }, context: null
  });
  if (running === null) return unsupported("package-metadata-invalid");
  if (io.platform === "win32") return unsupported("unsupported-platform");
  if (running.sourceCheckout) return unsupported("source-checkout");
  const npmCli = await io.resolveNpmCli({ execPath: io.execPath, platform: io.platform, pathEnv: io.env.PATH });
  if (npmCli === null) return unsupported("npm-not-found");
  const [prefix, globalRoot] = await Promise.all([queryNpm(io, npmCli, "prefix"), queryNpm(io, npmCli, "root")]);
  if (prefix === null || globalRoot === null) return unsupported("npm-query-failed");
  const slot = await io.inspectPath(join(globalRoot, CLI_UPDATE_PACKAGE_NAME));
  if (slot.kind === "symlink") return unsupported("global-link");
  const runningRoot = (await io.inspectPath(running.root)).realPath ?? running.root;
  if (slot.kind !== "directory" || slot.realPath !== runningRoot) return unsupported("outside-global-root");
  return {
    installation: { kind: "npm-global", canSelfUpdate: true, reason: null, guidance: GUIDANCE["npm-global"] },
    context: { npmCli, prefix, globalRoot }
  };
}

async function queryNpm(io: UpdateIo, npmCli: string, query: "prefix" | "root"): Promise<string | null> {
  const result = await io.runProcess(io.execPath, [npmCli, query, "--global"], {
    env: io.env, timeoutMs: CLI_UPDATE_DISCOVERY_TIMEOUT_MS, maxOutputBytes: CLI_UPDATE_PROCESS_OUTPUT_MAX_BYTES
  });
  const value = result.stdout.trim();
  return result.failed || value.length === 0 || !isAbsolute(value) ? null : value;
}

function declaredEntrypoint(packageRoot: string, bin: unknown): string | null {
  const declared = typeof bin === "string" ? bin : isRecord(bin) ? bin[CLI_UPDATE_PACKAGE_NAME] : undefined;
  if (typeof declared !== "string" || declared.length === 0) return null;
  const entrypoint = resolve(packageRoot, declared);
  const relativePath = relative(packageRoot, entrypoint);
  return relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath) ? null : entrypoint;
}

function compareVersions(current: string, latest: string): "update-available" | "up-to-date" | "ahead" {
  const order = semver.compare(latest, current);
  return order > 0 ? "update-available" : order < 0 ? "ahead" : "up-to-date";
}

function classifyNpmFailure(stderr: string): string {
  if (/EACCES|EPERM/.test(stderr)) return "permission denied";
  if (/E404|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|FETCH_ERROR/.test(stderr)) return "registry or network error";
  if (/EINTEGRITY/.test(stderr)) return "integrity check failed";
  return "npm exited with an error";
}

function validVersion(value: unknown): string | null {
  return typeof value === "string" ? semver.valid(value) : null;
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function prependPath(current: string | undefined, execPath: string): string {
  const directory = resolve(execPath, "..");
  return current === undefined || current.length === 0 ? directory : `${directory}${delimiter}${current}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
