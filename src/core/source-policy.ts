export type SourcePolicy = {
  exclude?: string[] | undefined;
  deny?: string[] | undefined;
};

export type SourcePolicyDecision = {
  action: "include" | "exclude" | "deny";
  pattern: string | null;
};

const BUILT_IN_DENY_PATTERNS = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".npmrc",
  "**/.npmrc",
  ".pypirc",
  "**/.pypirc",
  "*.pem",
  "**/*.pem",
  "*.key",
  "**/*.key",
  "id_rsa",
  "**/id_rsa",
  "id_dsa",
  "**/id_dsa",
  "id_ed25519",
  "**/id_ed25519"
];

export function sourcePolicyDecision(relativePath: string, policy: SourcePolicy | undefined): SourcePolicyDecision {
  const normalizedPath = normalizePath(relativePath);
  const denyPatterns = [...BUILT_IN_DENY_PATTERNS, ...normalizePatterns(policy?.deny)];
  const excludePatterns = normalizePatterns(policy?.exclude);

  const deniedBy = denyPatterns.find((pattern) => matchesPattern(normalizedPath, pattern));
  if (deniedBy !== undefined) {
    return { action: "deny", pattern: deniedBy };
  }

  const excludedBy = excludePatterns.find((pattern) => matchesPattern(normalizedPath, pattern));
  if (excludedBy !== undefined) {
    return { action: "exclude", pattern: excludedBy };
  }

  return { action: "include", pattern: null };
}

export function sourcePolicyPrunesDirectory(relativePath: string, policy: SourcePolicy | undefined): boolean {
  const normalizedPath = normalizePath(relativePath).replace(/\/+$/, "");
  if (normalizedPath.length === 0) {
    return false;
  }

  return normalizePatterns(policy?.exclude).some((pattern) => {
    if (!pattern.endsWith("/**")) {
      return false;
    }

    return matchesPattern(normalizedPath, pattern.slice(0, -3));
  });
}

export function normalizePatterns(patterns: string[] | undefined): string[] {
  if (!Array.isArray(patterns)) {
    return [];
  }

  return patterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map(normalizePattern);
}

function normalizePattern(pattern: string): string {
  return normalizePath(pattern).replace(/^\/+/, "");
}

function normalizePath(value: string): string {
  return value.split("\\").join("/").replace(/\/+/g, "/");
}

function matchesPattern(relativePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relativePath);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      const afterNext = pattern[index + 2];
      if (afterNext === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(char);
  }

  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
