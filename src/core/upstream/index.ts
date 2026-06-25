import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SKILLS_DIRECTORY, DEFAULT_UPSTREAM_LOCK_FILE } from "../../config/defaults.js";
import { loadCatalog } from "../catalog/index.js";

export const UPSTREAM_LOCK_SCHEMA = "calvinnwq.skills.upstream-lock.v0";
export const SKILLS_SH_PROVIDER = "skills-sh";
export const GIT_PROVIDER = "git";
type UpstreamProvider = typeof SKILLS_SH_PROVIDER | typeof GIT_PROVIDER;

export type UpstreamSkillDeclaration = {
  provider: UpstreamProvider;
  packageName?: string;
  packageVersion: string;
  upstream: {
    repo: string;
    skill: string;
  };
  group?: string;
  /**
   * Provenance for the catalog tree last imported from the pinned upstream source.
   */
  imported?: {
    sha256: string;
    packageVersion?: string;
    at?: string;
    source?: string;
  };
};

export type UpstreamLockDocument = {
  schema: typeof UPSTREAM_LOCK_SCHEMA;
  skills: Record<string, UpstreamSkillDeclaration>;
};

export type UpstreamFinding = {
  code: string;
  message: string;
  path: string | null;
};

export type UpstreamDeclarationEntry = {
  skill: string;
  provider: UpstreamProvider;
  packageName: string;
  packageVersion: string;
  upstreamRepo: string;
  upstreamSkill: string;
  group: string | null;
  importedHash: string | null;
  importedPackageVersion: string | null;
  importedAt: string | null;
  importedSource: string | null;
  catalogHash: string | null;
};

/**
 * Audit-friendly lineage for one upstream-managed catalog skill.
 *
 * `upstream check` leaves `target` as `null`; target-aware reports such as
 * `status` fill that block from the selected target receipt state.
 */
export type UpstreamLineage = {
  upstream: {
    provider: UpstreamProvider;
    packageName: string;
    packageVersion: string;
    repo: string;
    skill: string;
    group: string | null;
  };
  imported: {
    hash: string;
    packageVersion: string | null;
    at: string | null;
    source: string | null;
  } | null;
  catalog: {
    hash: string | null;
    drift: "unknown" | "catalog-hash-drift" | "unchanged";
  };
  target: null;
};

export type UpstreamLoadResult = {
  ok: boolean;
  source: string;
  lockPath: string;
  lock: UpstreamLockDocument | null;
  declarations: UpstreamDeclarationEntry[];
  findings: UpstreamFinding[];
};

export type UpstreamCheckResult = {
  ok: boolean;
  readOnly: true;
  source: string;
  lockPath: string;
  declarations: Array<UpstreamDeclarationEntry & {
    lineage: UpstreamLineage;
    packageAvailable: boolean;
    refresh: UpstreamLineage["catalog"]["drift"];
    errors: UpstreamFinding[];
  }>;
  summary: {
    declared: number;
    packageAvailable: number;
    failures: number;
  };
  errors: UpstreamFinding[];
};

export type UpstreamFileDiff = {
  relativePath: string;
  action: "create" | "update" | "delete" | "unchanged";
  catalogHash: string | null;
  upstreamHash: string | null;
};

export type UpstreamFetchResult = {
  ok: boolean;
  readOnly: true;
  dryRun: true;
  source: string;
  skill: string;
  declaration: UpstreamDeclarationEntry | null;
  fetchedSkillPath: string | null;
  diff: UpstreamFileDiff[];
  summary: {
    create: number;
    update: number;
    delete: number;
    unchanged: number;
  };
  errors: UpstreamFinding[];
};

export type UpstreamImportResult = {
  ok: boolean;
  readOnly: false;
  apply: true;
  source: string;
  skill: string;
  declaration: UpstreamDeclarationEntry | null;
  catalogSkillPath: string | null;
  diff: UpstreamFileDiff[];
  summary: UpstreamFetchResult["summary"] & {
    filesWritten: number;
  };
  metadata: {
    lockPath: string;
    importedHash: string | null;
  };
  errors: UpstreamFinding[];
};

type FetcherInput = {
  workspace: string;
  home: string;
  declaration: UpstreamSkillDeclaration;
};

type FetcherResult = {
  ok: boolean;
  skillPath: string | null;
  errors?: UpstreamFinding[];
};

export type UpstreamFetcher = (input: FetcherInput) => Promise<FetcherResult>;

type UpstreamCommandOptions = {
  fetcher?: UpstreamFetcher;
  now?: () => Date;
};

type UpstreamLoadOptions = {
  /**
   * Limit declaration entry construction and catalog hashing to these skills.
   *
   * Lock parsing and declaration validation still cover the whole document so
   * malformed upstream metadata remains visible.
   */
  skills?: ReadonlySet<string>;
};

export async function loadUpstreamLock(source: string, options: UpstreamLoadOptions = {}): Promise<UpstreamLoadResult> {
  const { sourceRoot } = await loadCatalog(source);
  const lockPath = path.join(sourceRoot, DEFAULT_UPSTREAM_LOCK_FILE);
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) {
      return {
        ok: true,
        source: sourceRoot,
        lockPath,
        lock: null,
        declarations: [],
        findings: []
      };
    }
    return {
      ok: false,
      source: sourceRoot,
      lockPath,
      lock: null,
      declarations: [],
      findings: [finding("invalid_upstream_lock_json", `Unable to parse upstream lock ${lockPath}.`, DEFAULT_UPSTREAM_LOCK_FILE)]
    };
  }

  const validation = validateLockDocument(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      source: sourceRoot,
      lockPath,
      lock: null,
      declarations: [],
      findings: validation.findings
    };
  }

  const lock = validation.lock;
  const declarations = await buildDeclarationEntries(sourceRoot, lock, options.skills);
  return {
    ok: true,
    source: sourceRoot,
    lockPath,
    lock,
    declarations,
    findings: []
  };
}

export async function checkUpstream(source: string): Promise<UpstreamCheckResult> {
  const loaded = await loadUpstreamLock(source);
  const errors = [...loaded.findings];
  const declarations = loaded.declarations.map((entry) => {
    const packageAvailable = checkProviderRunnerAvailable(entry.provider);
    const entryErrors = packageAvailable ? [] : [
      finding("upstream_package_runner_missing", `Unable to run ${runnerNameFor(entry.provider)} for pinned ${entry.provider} upstream checks.`, `upstream.skills.${entry.skill}`)
    ];
    const refresh = upstreamCatalogDrift(entry);
    return {
      ...entry,
      lineage: upstreamLineage(entry),
      packageAvailable,
      refresh,
      errors: entryErrors
    };
  });
  for (const entry of declarations) {
    errors.push(...entry.errors);
  }

  return {
    ok: loaded.ok && errors.length === 0,
    readOnly: true,
    source: loaded.source,
    lockPath: loaded.lockPath,
    declarations,
    summary: {
      declared: declarations.length,
      packageAvailable: declarations.filter((entry) => entry.packageAvailable).length,
      failures: errors.length
    },
    errors
  };
}

export async function fetchUpstreamSkillDryRun(
  source: string,
  skill: string,
  options: UpstreamCommandOptions = {}
): Promise<UpstreamFetchResult> {
  const prepared = await prepareFetchedSkill(source, skill, options.fetcher);
  if (!prepared.ok) {
    return {
      ok: false,
      readOnly: true,
      dryRun: true,
      source: prepared.source,
      skill,
      declaration: prepared.declaration,
      fetchedSkillPath: null,
      diff: [],
      summary: emptyDiffSummary(),
      errors: prepared.errors
    };
  }

  try {
    const diff = await diffSkillTrees(prepared.catalogSkillPath, prepared.fetchedSkillPath);
    return {
      ok: true,
      readOnly: true,
      dryRun: true,
      source: prepared.source,
      skill,
      declaration: prepared.declaration,
      fetchedSkillPath: prepared.fetchedSkillPath,
      diff,
      summary: summarizeDiff(diff),
      errors: []
    };
  } finally {
    await prepared.cleanup();
  }
}

export function upstreamCatalogDrift(entry: Pick<UpstreamDeclarationEntry, "importedHash" | "catalogHash">): UpstreamLineage["catalog"]["drift"] {
  if (entry.importedHash !== null && entry.catalogHash !== null && entry.importedHash !== entry.catalogHash) {
    return "catalog-hash-drift";
  }
  if (entry.importedHash !== null && entry.catalogHash !== null) {
    return "unchanged";
  }
  return "unknown";
}

export function upstreamLineage(entry: UpstreamDeclarationEntry): UpstreamLineage {
  return {
    upstream: {
      provider: entry.provider,
      packageName: entry.packageName,
      packageVersion: entry.packageVersion,
      repo: entry.upstreamRepo,
      skill: entry.upstreamSkill,
      group: entry.group
    },
    imported: entry.importedHash === null
      ? null
      : {
          hash: entry.importedHash,
          packageVersion: entry.importedPackageVersion,
          at: entry.importedAt,
          source: entry.importedSource
        },
    catalog: {
      hash: entry.catalogHash,
      drift: upstreamCatalogDrift(entry)
    },
    target: null
  };
}

export async function importUpstreamSkill(
  source: string,
  skill: string,
  options: UpstreamCommandOptions = {}
): Promise<UpstreamImportResult> {
  const loaded = await loadUpstreamLock(source);
  const declaration = declarationForSkill(loaded, skill);
  const entry = loaded.declarations.find((item) => item.skill === skill) ?? null;
  if (!loaded.ok || declaration === null || loaded.lock === null) {
    return failedImport(loaded.source, skill, entry, null, loaded.findings.length > 0
      ? loaded.findings
      : [finding("unknown_upstream_skill", `No upstream declaration found for ${skill}.`, `upstream.skills.${skill}`)]);
  }

  const dirty = checkCatalogCleanForImport(loaded.source, skill);
  if (!dirty.ok) {
    return failedImport(loaded.source, skill, entry, path.join(loaded.source, DEFAULT_SKILLS_DIRECTORY, skill), dirty.errors);
  }

  const prepared = await prepareFetchedSkill(source, skill, options.fetcher);
  if (!prepared.ok) {
    return failedImport(prepared.source, skill, prepared.declaration, null, prepared.errors);
  }

  try {
    const diff = await diffSkillTrees(prepared.catalogSkillPath, prepared.fetchedSkillPath);
    let swap: CatalogSwap | null = null;
    try {
      swap = await swapCatalogSkill(prepared.fetchedSkillPath, prepared.catalogSkillPath);
      const importedHash = await hashDirectory(prepared.catalogSkillPath);
      const filesWritten = (await collectFileHashes(prepared.catalogSkillPath)).length;
      const nextLock = updateImportedMetadata(loaded.lock, skill, declaration, importedHash, options.now?.() ?? new Date());
      await writeJsonAtomic(loaded.lockPath, nextLock);
      await cleanupSwapBackup(swap);
      const summary = summarizeDiff(diff);
      return {
        ok: true,
        readOnly: false,
        apply: true,
        source: loaded.source,
        skill,
        declaration: entry,
        catalogSkillPath: prepared.catalogSkillPath,
        diff,
        summary: {
          ...summary,
          filesWritten
        },
        metadata: {
          lockPath: loaded.lockPath,
          importedHash
        },
        errors: []
      };
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (swap !== null) {
        try {
          await restoreSwap(prepared.catalogSkillPath, swap);
        } catch (rollbackError) {
          rollbackErrors.push(`catalog restore failed: ${errorMessage(rollbackError)}`);
        }
      }
      try {
        await writeJsonAtomic(loaded.lockPath, loaded.lock);
      } catch (rollbackError) {
        rollbackErrors.push(`upstream lock restore failed: ${errorMessage(rollbackError)}`);
      }
      const rollbackSuffix = rollbackErrors.length > 0 ? ` Rollback errors: ${rollbackErrors.join("; ")}` : "";
      return failedImport(loaded.source, skill, entry, prepared.catalogSkillPath, [
        finding(
          "upstream_import_failed",
          `Failed to import upstream skill ${skill}: ${errorMessage(error)}.${rollbackSuffix}`,
          `skills.${skill}`
        )
      ]);
    }
  } finally {
    await prepared.cleanup();
  }
}

type PreparedFetch = {
  ok: true;
  source: string;
  declaration: UpstreamDeclarationEntry;
  fetchedSkillPath: string;
  catalogSkillPath: string;
  cleanup: () => Promise<void>;
} | {
  ok: false;
  source: string;
  declaration: UpstreamDeclarationEntry | null;
  errors: UpstreamFinding[];
};

async function prepareFetchedSkill(
  source: string,
  skill: string,
  fetcher: UpstreamFetcher | undefined
): Promise<PreparedFetch> {
  const loaded = await loadUpstreamLock(source);
  const declaration = declarationForSkill(loaded, skill);
  const entry = loaded.declarations.find((item) => item.skill === skill) ?? null;
  if (!loaded.ok || declaration === null) {
    return {
      ok: false,
      source: loaded.source,
      declaration: entry,
      errors: loaded.findings.length > 0
        ? loaded.findings
        : [finding("unknown_upstream_skill", `No upstream declaration found for ${skill}.`, `upstream.skills.${skill}`)]
    };
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upstream-"));
  const workspace = path.join(tempRoot, "workspace");
  const home = path.join(tempRoot, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });

  const result = await (fetcher ?? defaultUpstreamFetcher)({ workspace, home, declaration });
  if (!result.ok || result.skillPath === null) {
    await rm(tempRoot, { recursive: true, force: true });
    return {
      ok: false,
      source: loaded.source,
      declaration: entry,
      errors: result.errors ?? [
        finding("upstream_fetch_failed", `Failed to fetch upstream skill ${skill}.`, `upstream.skills.${skill}`)
      ]
    };
  }

  const fetchedRealPath = await realpathSafe(result.skillPath);
  const tempRealPath = await realpathSafe(tempRoot);
  if (
    fetchedRealPath === null ||
    tempRealPath === null ||
    !isSameOrInsidePath(fetchedRealPath, tempRealPath)
  ) {
    await rm(tempRoot, { recursive: true, force: true });
    return {
      ok: false,
      source: loaded.source,
      declaration: entry,
      errors: [
        finding(
          "upstream_fetch_outside_sandbox",
          `Fetched skill ${skill} resolved outside the isolated temp workspace.`,
          `upstream.skills.${skill}`
        )
      ]
    };
  }
  if (!(await isFile(path.join(fetchedRealPath, "SKILL.md")))) {
    await rm(tempRoot, { recursive: true, force: true });
    return {
      ok: false,
      source: loaded.source,
      declaration: entry,
      errors: [
        finding(
          "upstream_fetch_missing_skill_file",
          `Fetched skill ${skill} did not contain SKILL.md.`,
          `upstream.skills.${skill}`
        )
      ]
    };
  }

  return {
    ok: true,
    source: loaded.source,
    declaration: entry ?? await declarationEntryForSkill(loaded.source, skill, declaration),
    fetchedSkillPath: fetchedRealPath,
    catalogSkillPath: path.join(loaded.source, DEFAULT_SKILLS_DIRECTORY, skill),
    cleanup: () => rm(tempRoot, { recursive: true, force: true })
  };
}

async function defaultUpstreamFetcher(input: FetcherInput): Promise<FetcherResult> {
  if (input.declaration.provider === GIT_PROVIDER) {
    return defaultGitFetcher(input);
  }
  return defaultSkillsFetcher(input);
}

async function defaultSkillsFetcher({ workspace, home, declaration }: FetcherInput): Promise<FetcherResult> {
  const packageSpec = `${packageNameFor(declaration)}@${declaration.packageVersion}`;
  const result = spawnSync(
    "npm",
    [
      "exec",
      "--yes",
      packageSpec,
      "--",
      "add",
      declaration.upstream.repo,
      "--skill",
      declaration.upstream.skill,
      "--agent",
      "claude-code",
      "--copy",
      "--yes"
    ],
    {
      cwd: workspace,
      env: sandboxedSkillsEnv(home),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  if (result.status !== 0) {
    return {
      ok: false,
      skillPath: null,
      errors: [
        finding(
          "upstream_fetch_failed",
          `Pinned skills-sh fetch failed for ${declaration.upstream.skill}: ${(result.stderr || result.stdout || "unknown error").trim()}`,
          `upstream.skills.${declaration.upstream.skill}`
        )
      ]
    };
  }

  const candidates = [
    path.join(workspace, ".claude", "skills", declaration.upstream.skill),
    path.join(home, ".claude", "skills", declaration.upstream.skill),
    path.join(workspace, ".agents", "skills", declaration.upstream.skill)
  ];
  const candidate = await firstDirectory(candidates);
  if (candidate === null) {
    return {
      ok: false,
      skillPath: null,
      errors: [
        finding("upstream_fetch_missing_skill", `Pinned skills-sh fetch did not produce ${candidates.join(" or ")}.`, null)
      ]
    };
  }

  return {
    ok: true,
    skillPath: candidate
  };
}

async function defaultGitFetcher({ workspace, declaration }: FetcherInput): Promise<FetcherResult> {
  const repoUrl = gitRepoUrlFor(declaration.upstream.repo);
  if (repoUrl === null) {
    return {
      ok: false,
      skillPath: null,
      errors: [
        finding(
          "invalid_upstream_identity",
          `Git upstream repo ${declaration.upstream.repo} must be a GitHub owner/repo or HTTPS GitHub URL.`,
          `upstream.skills.${declaration.upstream.skill}`
        )
      ]
    };
  }

  const repoPath = path.join(workspace, "repo");
  const commands: Array<[string, string[]]> = [
    ["git", ["init", repoPath]],
    ["git", ["-C", repoPath, "remote", "add", "origin", repoUrl]],
    ["git", ["-C", repoPath, "fetch", "--depth", "1", "origin", declaration.packageVersion]],
    ["git", ["-C", repoPath, "checkout", "--detach", "FETCH_HEAD"]]
  ];

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.status !== 0) {
      return {
        ok: false,
        skillPath: null,
        errors: [
          finding(
            "upstream_fetch_failed",
            `Pinned git fetch failed for ${declaration.upstream.repo}@${declaration.packageVersion}: ${(result.stderr || result.stdout || "unknown error").trim()}`,
            `upstream.skills.${declaration.upstream.skill}`
          )
        ]
      };
    }
  }

  await rm(path.join(repoPath, ".git"), { recursive: true, force: true });
  return {
    ok: true,
    skillPath: declaration.upstream.skill === "." ? repoPath : path.join(repoPath, declaration.upstream.skill)
  };
}

function validateLockDocument(value: unknown): { ok: true; lock: UpstreamLockDocument } | { ok: false; findings: UpstreamFinding[] } {
  const findings: UpstreamFinding[] = [];
  if (!isRecord(value)) {
    return { ok: false, findings: [finding("invalid_upstream_lock_schema", "Upstream lock must be a JSON object.", DEFAULT_UPSTREAM_LOCK_FILE)] };
  }
  if (value.schema !== UPSTREAM_LOCK_SCHEMA) {
    findings.push(finding("invalid_upstream_lock_schema", `Upstream lock schema must be ${UPSTREAM_LOCK_SCHEMA}.`, "schema"));
  }
  if (!isRecord(value.skills)) {
    findings.push(finding("invalid_upstream_lock_schema", "Upstream lock must define a skills object.", "skills"));
    return { ok: false, findings };
  }

  const skills: Record<string, UpstreamSkillDeclaration> = {};
  for (const [skill, rawDeclaration] of Object.entries(value.skills)) {
    if (!isPlainSegment(skill)) {
      findings.push(finding("invalid_upstream_skill_name", `Upstream skill key ${skill} must be a plain skill directory name.`, `skills.${skill}`));
      continue;
    }
    const parsed = parseDeclaration(skill, rawDeclaration);
    if (parsed.ok) {
      skills[skill] = parsed.declaration;
    } else {
      findings.push(...parsed.findings);
    }
  }

  if (findings.length > 0) {
    return { ok: false, findings };
  }
  return {
    ok: true,
    lock: {
      schema: UPSTREAM_LOCK_SCHEMA,
      skills
    }
  };
}

function parseDeclaration(skill: string, value: unknown): { ok: true; declaration: UpstreamSkillDeclaration } | { ok: false; findings: UpstreamFinding[] } {
  const findings: UpstreamFinding[] = [];
  if (!isRecord(value)) {
    return { ok: false, findings: [finding("invalid_upstream_declaration", `Upstream declaration for ${skill} must be an object.`, `skills.${skill}`)] };
  }
  const provider = value.provider;
  if (provider !== SKILLS_SH_PROVIDER && provider !== GIT_PROVIDER) {
    findings.push(finding("unsupported_upstream_provider", `Upstream declaration for ${skill} must use provider ${SKILLS_SH_PROVIDER} or ${GIT_PROVIDER}.`, `skills.${skill}.provider`));
  }
  if (provider === GIT_PROVIDER && !isPinnedGitRef(value.packageVersion)) {
    findings.push(finding("invalid_upstream_package_version", `Git upstream declaration for ${skill} must pin packageVersion to a version tag or full commit SHA.`, `skills.${skill}.packageVersion`));
  } else if (provider !== GIT_PROVIDER && !isExactPackageVersion(value.packageVersion)) {
    findings.push(finding("invalid_upstream_package_version", `Upstream declaration for ${skill} must pin packageVersion to an exact package version.`, `skills.${skill}.packageVersion`));
  }
  const packageName = value.packageName;
  if (packageName !== undefined && !isNonBlankString(packageName)) {
    findings.push(finding("invalid_upstream_package_name", `Upstream declaration for ${skill} packageName must be a non-empty string.`, `skills.${skill}.packageName`));
  }
  if (!isRecord(value.upstream)) {
    findings.push(finding("invalid_upstream_identity", `Upstream declaration for ${skill} must include upstream repo and skill.`, `skills.${skill}.upstream`));
  } else {
    if (!isNonBlankString(value.upstream.repo)) {
      findings.push(finding("invalid_upstream_identity", `Upstream declaration for ${skill} must include upstream.repo.`, `skills.${skill}.upstream.repo`));
    }
    if (!isNonBlankString(value.upstream.skill)) {
      findings.push(finding("invalid_upstream_identity", `Upstream declaration for ${skill} must include upstream.skill.`, `skills.${skill}.upstream.skill`));
    }
  }
  const group = value.group;
  if (group !== undefined && !isNonBlankString(group)) {
    findings.push(finding("invalid_upstream_group", `Upstream declaration for ${skill} group must be a non-empty string.`, `skills.${skill}.group`));
  }
  const imported = value.imported;
  if (imported !== undefined) {
    if (!isRecord(imported)) {
      findings.push(finding("invalid_upstream_imported", `Upstream declaration for ${skill} imported must be an object.`, `skills.${skill}.imported`));
    } else {
      if (!isNonBlankString(imported.sha256)) {
        findings.push(finding("invalid_upstream_imported", `Upstream declaration for ${skill} imported.sha256 must be a non-empty string.`, `skills.${skill}.imported.sha256`));
      }
      if (
        imported.packageVersion !== undefined
        && (provider === GIT_PROVIDER ? !isPinnedGitRef(imported.packageVersion) : !isExactPackageVersion(imported.packageVersion))
      ) {
        findings.push(finding("invalid_upstream_imported", `Upstream declaration for ${skill} imported.packageVersion must be an exact package version.`, `skills.${skill}.imported.packageVersion`));
      }
      if (imported.at !== undefined && !isIsoDateString(imported.at)) {
        findings.push(finding("invalid_upstream_imported", `Upstream declaration for ${skill} imported.at must be an ISO timestamp.`, `skills.${skill}.imported.at`));
      }
      if (imported.source !== undefined && !isNonBlankString(imported.source)) {
        findings.push(finding("invalid_upstream_imported", `Upstream declaration for ${skill} imported.source must be a non-empty string.`, `skills.${skill}.imported.source`));
      }
    }
  }

  if (findings.length > 0 || !isRecord(value.upstream)) {
    return { ok: false, findings };
  }

  const declaration: UpstreamSkillDeclaration = {
    provider: provider === GIT_PROVIDER ? GIT_PROVIDER : SKILLS_SH_PROVIDER,
    packageVersion: String(value.packageVersion),
    upstream: {
      repo: String(value.upstream.repo),
      skill: String(value.upstream.skill)
    }
  };
  if (isNonBlankString(packageName)) {
    declaration.packageName = packageName;
  }
  if (isNonBlankString(group)) {
    declaration.group = group;
  }
  if (isRecord(imported) && isNonBlankString(imported.sha256)) {
    declaration.imported = { sha256: imported.sha256 };
    if (isNonBlankString(imported.packageVersion)) {
      declaration.imported.packageVersion = imported.packageVersion;
    }
    if (isNonBlankString(imported.at)) {
      declaration.imported.at = imported.at;
    }
    if (isNonBlankString(imported.source)) {
      declaration.imported.source = imported.source;
    }
  }
  return { ok: true, declaration };
}

async function buildDeclarationEntries(
  sourceRoot: string,
  lock: UpstreamLockDocument,
  selectedSkills?: ReadonlySet<string>
): Promise<UpstreamDeclarationEntry[]> {
  const entries: UpstreamDeclarationEntry[] = [];
  for (const [skill, declaration] of Object.entries(lock.skills).sort(([left], [right]) => left.localeCompare(right))) {
    if (selectedSkills !== undefined && !selectedSkills.has(skill)) {
      continue;
    }
    entries.push(await declarationEntryForSkill(sourceRoot, skill, declaration));
  }
  return entries;
}

async function declarationEntryForSkill(
  sourceRoot: string,
  skill: string,
  declaration: UpstreamSkillDeclaration
): Promise<UpstreamDeclarationEntry> {
  const catalogSkillPath = path.join(sourceRoot, DEFAULT_SKILLS_DIRECTORY, skill);
  const catalogHash = await hashDirectoryOrNull(catalogSkillPath);
  return {
    skill,
    provider: declaration.provider,
    packageName: packageNameFor(declaration),
    packageVersion: declaration.packageVersion,
    upstreamRepo: declaration.upstream.repo,
    upstreamSkill: declaration.upstream.skill,
    group: declaration.group ?? null,
    importedHash: declaration.imported?.sha256 ?? null,
    importedPackageVersion: declaration.imported?.packageVersion ?? null,
    importedAt: declaration.imported?.at ?? null,
    importedSource: declaration.imported?.source ?? null,
    catalogHash
  };
}

function declarationForSkill(loaded: UpstreamLoadResult, skill: string): UpstreamSkillDeclaration | null {
  return loaded.lock?.skills[skill] ?? null;
}

function packageNameFor(declaration: UpstreamSkillDeclaration): string {
  return declaration.packageName ?? (declaration.provider === GIT_PROVIDER ? "git" : "skills");
}

function gitRepoUrlFor(repo: string): string | null {
  const ownerRepo = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo);
  if (ownerRepo !== null) {
    return `https://github.com/${ownerRepo[1]}/${ownerRepo[2]}.git`;
  }
  const githubHttps = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(repo);
  if (githubHttps !== null) {
    return `https://github.com/${githubHttps[1]}/${githubHttps[2]}.git`;
  }
  return null;
}

async function diffSkillTrees(catalogSkillPath: string, fetchedSkillPath: string): Promise<UpstreamFileDiff[]> {
  const catalog = await collectFileHashes(catalogSkillPath);
  const fetched = await collectFileHashes(fetchedSkillPath);
  const catalogByPath = new Map(catalog.map((file) => [file.relativePath, file.sha256]));
  const fetchedByPath = new Map(fetched.map((file) => [file.relativePath, file.sha256]));
  const paths = [...new Set([...catalogByPath.keys(), ...fetchedByPath.keys()])].sort();
  return paths.map((relativePath) => {
    const catalogHash = catalogByPath.get(relativePath) ?? null;
    const upstreamHash = fetchedByPath.get(relativePath) ?? null;
    return {
      relativePath,
      action: catalogHash === null
        ? "create"
        : upstreamHash === null
          ? "delete"
          : catalogHash === upstreamHash
            ? "unchanged"
            : "update",
      catalogHash,
      upstreamHash
    };
  });
}

async function collectFileHashes(root: string): Promise<Array<{ relativePath: string; sha256: string; bytes: number }>> {
  if (!(await isDirectory(root))) {
    return [];
  }
  const files: Array<{ relativePath: string; sha256: string; bytes: number }> = [];
  await walkFiles(root, root, files);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function walkFiles(
  root: string,
  current: string,
  files: Array<{ relativePath: string; sha256: string; bytes: number }>
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort(compareDirent)) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const buffer = await readFile(absolutePath);
    files.push({
      relativePath: normalizeRelative(path.relative(root, absolutePath)),
      sha256: sha256(buffer),
      bytes: buffer.byteLength
    });
  }
}

async function hashDirectoryOrNull(root: string): Promise<string | null> {
  if (!(await isDirectory(root))) {
    return null;
  }
  return hashDirectory(root);
}

async function hashDirectory(root: string): Promise<string> {
  const files = await collectFileHashes(root);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function summarizeDiff(diff: UpstreamFileDiff[]): UpstreamFetchResult["summary"] {
  return {
    create: diff.filter((item) => item.action === "create").length,
    update: diff.filter((item) => item.action === "update").length,
    delete: diff.filter((item) => item.action === "delete").length,
    unchanged: diff.filter((item) => item.action === "unchanged").length
  };
}

function emptyDiffSummary(): UpstreamFetchResult["summary"] {
  return { create: 0, update: 0, delete: 0, unchanged: 0 };
}

function checkProviderRunnerAvailable(provider: UpstreamProvider): boolean {
  const result = spawnSync(runnerNameFor(provider), ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0;
}

function runnerNameFor(provider: UpstreamProvider): "git" | "npm" {
  return provider === GIT_PROVIDER ? "git" : "npm";
}

function checkCatalogCleanForImport(sourceRoot: string, skill: string): { ok: true } | { ok: false; errors: UpstreamFinding[] } {
  const gitRoot = resolveGitRoot(sourceRoot);
  if (gitRoot === null) {
    return {
      ok: false,
      errors: [
        finding(
          "source_hygiene_requires_git",
          `Refusing upstream import for ${skill}: source catalog is not inside a Git worktree, so local edits cannot be verified before import.`,
          `skills.${skill}`
        )
      ]
    };
  }
  const canonicalSourceRoot = realpathSyncOrResolve(sourceRoot);
  const skillPath = normalizeRelative(path.relative(gitRoot, path.join(canonicalSourceRoot, DEFAULT_SKILLS_DIRECTORY, skill)));
  const lockPath = normalizeRelative(path.relative(gitRoot, path.join(canonicalSourceRoot, DEFAULT_UPSTREAM_LOCK_FILE)));
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--", skillPath, lockPath], {
    cwd: gitRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return {
      ok: false,
      errors: [finding("source_hygiene_failed", `Unable to inspect git status before upstream import for ${skill}.`, `skills.${skill}`)]
    };
  }
  if (result.stdout.length === 0) {
    return { ok: true };
  }
  const paths = result.stdout.split("\0").filter(Boolean).map((line) => line.slice(3)).sort();
  return {
    ok: false,
    errors: [
      finding(
        "dirty_catalog_source",
        `Refusing upstream import for ${skill}: selected catalog source has uncommitted changes (${paths.join(", ")}). Commit, stash, or remove them before importing.`,
        `skills.${skill}`
      )
    ]
  };
}

async function copyDirectory(from: string, to: string): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const fromPath = path.join(from, entry.name);
    const toPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(toPath, { recursive: true });
      await copyDirectory(fromPath, toPath);
    } else if (entry.isFile()) {
      await copyFile(fromPath, toPath);
    }
  }
}

type CatalogSwap = {
  stagingPath: string;
  backupPath: string | null;
};

async function swapCatalogSkill(from: string, to: string): Promise<CatalogSwap> {
  const parent = path.dirname(to);
  const base = path.basename(to);
  await mkdir(parent, { recursive: true });
  const suffix = `${process.pid}-${Date.now()}`;
  const stagingPath = path.join(parent, `.${base}.upstream-staging-${suffix}`);
  const backupPath = path.join(parent, `.${base}.upstream-backup-${suffix}`);
  await rm(stagingPath, { recursive: true, force: true });
  await rm(backupPath, { recursive: true, force: true });
  await mkdir(stagingPath, { recursive: true });
  await copyDirectory(from, stagingPath);

  const targetExists = await exists(to);
  try {
    if (targetExists) {
      await rename(to, backupPath);
    }
    await rename(stagingPath, to);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    if (targetExists && !(await exists(to)) && await exists(backupPath)) {
      await rename(backupPath, to);
    }
    throw error;
  }

  return {
    stagingPath,
    backupPath: targetExists ? backupPath : null
  };
}

async function restoreSwap(catalogSkillPath: string, swap: CatalogSwap): Promise<void> {
  await rm(swap.stagingPath, { recursive: true, force: true });
  await rm(catalogSkillPath, { recursive: true, force: true });
  if (swap.backupPath !== null && await exists(swap.backupPath)) {
    await rename(swap.backupPath, catalogSkillPath);
  }
}

async function cleanupSwapBackup(swap: CatalogSwap): Promise<void> {
  await rm(swap.stagingPath, { recursive: true, force: true });
  if (swap.backupPath !== null) {
    await rm(swap.backupPath, { recursive: true, force: true });
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function updateImportedMetadata(
  lock: UpstreamLockDocument,
  skill: string,
  declaration: UpstreamSkillDeclaration,
  importedHash: string,
  now: Date
): UpstreamLockDocument {
  return {
    schema: UPSTREAM_LOCK_SCHEMA,
    skills: Object.fromEntries(
      Object.entries({
        ...lock.skills,
        [skill]: {
          ...declaration,
          imported: {
            sha256: importedHash,
            packageVersion: declaration.packageVersion,
            at: now.toISOString(),
            source: importedSourceFor(declaration)
          }
        }
      }).sort(([left], [right]) => left.localeCompare(right))
    ) as Record<string, UpstreamSkillDeclaration>
  };
}

function importedSourceFor(declaration: UpstreamSkillDeclaration): string {
  if (declaration.provider === GIT_PROVIDER) {
    return `${GIT_PROVIDER}:${declaration.upstream.repo}:${declaration.packageVersion}:${declaration.upstream.skill}`;
  }
  return `${SKILLS_SH_PROVIDER}:${declaration.upstream.repo}:${declaration.upstream.skill}`;
}

function failedImport(
  source: string,
  skill: string,
  declaration: UpstreamDeclarationEntry | null,
  catalogSkillPath: string | null,
  errors: UpstreamFinding[]
): UpstreamImportResult {
  return {
    ok: false,
    readOnly: false,
    apply: true,
    source,
    skill,
    declaration,
    catalogSkillPath,
    diff: [],
    summary: {
      ...emptyDiffSummary(),
      filesWritten: 0
    },
    metadata: {
      lockPath: path.join(source, DEFAULT_UPSTREAM_LOCK_FILE),
      importedHash: null
    },
    errors
  };
}

function resolveGitRoot(sourceRoot: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  const gitRoot = result.stdout.trim();
  return gitRoot.length > 0 ? realpathSyncOrResolve(gitRoot) : null;
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

function sandboxedSkillsEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "COMSPEC", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.XDG_CACHE_HOME = path.join(home, ".cache");
  env.npm_config_cache = path.join(home, ".npm-cache");
  env.npm_config_userconfig = path.join(home, ".npmrc");
  env.npm_config_globalconfig = path.join(home, ".npm-global-npmrc");
  env.npm_config_prefix = path.join(home, ".npm-global");
  env.SKILLS_HOME = path.join(home, ".skills");
  env.AGENTS_HOME = path.join(home, ".agents");
  return env;
}

function realpathSyncOrResolve(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function firstDirectory(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function realpathSafe(targetPath: string): Promise<string | null> {
  try {
    return await realpath(targetPath);
  } catch {
    return null;
  }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainSegment(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

function isExactPackageVersion(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function isPinnedGitRef(value: unknown): value is string {
  return typeof value === "string" && (
    /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) ||
    /^[0-9a-f]{40}$/i.test(value)
  );
}

function isIsoDateString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isSameOrInsidePath(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/");
}

function compareDirent(left: Dirent, right: Dirent): number {
  return left.name.localeCompare(right.name);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function finding(code: string, message: string, pathName: string | null): UpstreamFinding {
  return { code, message, path: pathName };
}
