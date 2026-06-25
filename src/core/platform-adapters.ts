export type PlatformPathField = "path" | "home" | "codexHome" | "skillsPath";

export type PlatformAdapterId = "openclaw" | "codex" | "agents" | "claude" | "opencode" | "pi";

export type PlatformAdapterKind =
  | "openclaw-skills-root"
  | "codex-home"
  | "nested-home-codex"
  | "agents-skills-root"
  | "claude-skills-root"
  | "opencode-skills-root"
  | "pi-skills-root";

export type PlatformAdapter = {
  id: PlatformAdapterId;
  kind: PlatformAdapterKind;
  installRootField: PlatformPathField;
  requiredFields: PlatformPathField[];
  compatibilityNames: string[];
  metadata: {
    workspaceSkillRoot?: boolean;
    nestedHome?: boolean;
    readOnly?: boolean;
    skillsShCompatibility?: boolean;
  };
};

export type PlatformInstallRootResolution = {
  ok: boolean;
  adapter: PlatformAdapter | null;
  installRoot: string | null;
  missingFields: PlatformPathField[];
};

const PLATFORM_ADAPTERS: Record<PlatformAdapterKind, PlatformAdapter> = {
  "openclaw-skills-root": {
    id: "openclaw",
    kind: "openclaw-skills-root",
    installRootField: "path",
    requiredFields: ["path"],
    compatibilityNames: ["openclaw"],
    metadata: {
      workspaceSkillRoot: true
    }
  },
  "codex-home": {
    id: "codex",
    kind: "codex-home",
    installRootField: "skillsPath",
    requiredFields: ["codexHome", "skillsPath"],
    compatibilityNames: ["codex"],
    metadata: {}
  },
  "nested-home-codex": {
    id: "codex",
    kind: "nested-home-codex",
    installRootField: "skillsPath",
    requiredFields: ["home", "codexHome", "skillsPath"],
    compatibilityNames: ["codex"],
    metadata: {
      nestedHome: true
    }
  },
  "agents-skills-root": {
    id: "agents",
    kind: "agents-skills-root",
    installRootField: "path",
    requiredFields: ["path"],
    compatibilityNames: ["agents"],
    metadata: {}
  },
  "claude-skills-root": {
    id: "claude",
    kind: "claude-skills-root",
    installRootField: "path",
    requiredFields: ["path"],
    compatibilityNames: ["claude"],
    metadata: {}
  },
  "opencode-skills-root": {
    id: "opencode",
    kind: "opencode-skills-root",
    installRootField: "path",
    requiredFields: ["path"],
    compatibilityNames: ["opencode"],
    metadata: {
      readOnly: true,
      skillsShCompatibility: true
    }
  },
  "pi-skills-root": {
    id: "pi",
    kind: "pi-skills-root",
    installRootField: "path",
    requiredFields: ["path"],
    compatibilityNames: ["pi"],
    metadata: {
      readOnly: true,
      skillsShCompatibility: true
    }
  }
};

export function resolvePlatformAdapter(kind: string | null): PlatformAdapter | null {
  if (!isPlatformAdapterKind(kind)) {
    return null;
  }
  return PLATFORM_ADAPTERS[kind];
}

export function resolvePlatformInstallRoot({
  kind,
  assignmentPath
}: {
  kind: string | null;
  assignmentPath: Record<string, unknown>;
}): PlatformInstallRootResolution {
  const adapter = resolvePlatformAdapter(kind);
  if (adapter === null) {
    return {
      ok: false,
      adapter,
      installRoot: null,
      missingFields: []
    };
  }

  const missingFields = adapter.requiredFields.filter(
    (field) => normalizeValue(assignmentPath[field]) === null
  );

  return {
    ok: missingFields.length === 0,
    adapter,
    installRoot: normalizeValue(assignmentPath[adapter.installRootField]),
    missingFields
  };
}

export function platformCompatibilityNames({
  assignment,
  kind
}: {
  assignment: string;
  kind: string | null;
}): string[] {
  const names = [assignment];
  const adapter = resolvePlatformAdapter(kind);
  if (adapter === null) {
    return names;
  }

  for (const name of adapter.compatibilityNames) {
    if (!names.includes(name)) {
      names.push(name);
    }
  }

  return names;
}

export function platformPathFields(): PlatformPathField[] {
  return ["path", "home", "codexHome", "skillsPath"];
}

export function isPlatformAdapterKind(kind: string | null): kind is PlatformAdapterKind {
  return kind !== null && Object.hasOwn(PLATFORM_ADAPTERS, kind);
}

function normalizeValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
