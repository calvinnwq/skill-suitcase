import { stat } from "node:fs/promises";
import { loadCatalog, type Catalog, type TargetOverrides } from "./index.js";
import {
  platformPathFields,
  resolvePlatformAdapter
} from "../platform-adapters.js";

type TargetPathField = "path" | "home" | "codexHome" | "skillsPath";
type TargetSafetyClassification = "invalid" | "missing" | "live-install-root";
type TargetFindingLevel = "error" | "warning";

type TargetFinding = {
  level: TargetFindingLevel;
  code: string;
  message: string;
  path: string | null;
};

type TargetPlatform = {
  adapter: string;
  installRoot: string | null;
  compatibility: string[];
  metadata: Record<string, boolean>;
};

type Target = {
  id: string;
  name: string;
  assignment: string | null;
  kind: string | null;
  path: string | null;
  home: string | null;
  codexHome: string | null;
  skillsPath: string | null;
  platform: TargetPlatform | null;
  exists: Record<TargetPathField, boolean>;
  safety: {
    classification: TargetSafetyClassification;
    reason: string | null;
  };
};

type TargetResult = {
  ok: boolean;
  source: string;
  manifestPath: string;
  targets: Target[];
  findings: TargetFinding[];
};

type TargetInput = {
  source: string;
  targetOverrides?: TargetOverrides | undefined;
};

const PATH_FIELDS = platformPathFields();

export async function targets({ source, targetOverrides }: TargetInput): Promise<TargetResult> {
  if (!source) {
    throw new Error("source is required");
  }

  const { sourceRoot, manifestPath, manifest } = await loadCatalog(source, { targetOverrides });
  const findings: TargetFinding[] = [];
  const discovered: Target[] = [];

  const assignmentPaths = manifest.assignmentPaths ?? {};

  if (!isRecord(assignmentPaths)) {
    findings.push(
      error(
        "invalid_assignment_paths",
        "Manifest assignmentPaths is not a valid mapping."
      )
    );
    return {
      ok: false,
      source: sourceRoot,
      manifestPath,
      targets: [],
      findings
    };
  }

  for (const [targetId, assignmentPath] of Object.entries(assignmentPaths)) {
    discovered.push(await describeTarget(targetId, assignmentPath, manifest, findings));
  }

  return {
    ok: findings.every((finding) => finding.level !== "error"),
    source: sourceRoot,
    manifestPath,
    targets: discovered,
    findings
  };
}

async function describeTarget(
  targetId: string,
  assignmentPath: unknown,
  manifest: Catalog,
  findings: TargetFinding[]
): Promise<Target> {
  const target: Target = {
    id: targetId,
    name: targetId,
    assignment: null,
    kind: null,
    path: null,
    home: null,
    codexHome: null,
    skillsPath: null,
    platform: null,
    exists: {
      path: false,
      home: false,
      codexHome: false,
      skillsPath: false
    },
    safety: {
      classification: "invalid",
      reason: null
    }
  };

  if (!isRecord(assignmentPath)) {
    findings.push(
      error(
        "invalid_assignment_path",
        `Assignment path ${targetId} must be an object mapping of target details.`,
        `assignmentPaths.${targetId}`
      )
    );
    target.safety.reason = "assignment path entry is malformed";
    return target;
  }

  const assignment = normalizeValue(assignmentPath.assignment);
  const rawKind = normalizeValue(assignmentPath.kind);
  const kind = rawKind;
  target.assignment = assignment;
  target.kind = rawKind;

  if (!assignment) {
    findings.push(
      error(
        "invalid_assignment_path",
        `Assignment path ${targetId} is missing assignment.`,
        `assignmentPaths.${targetId}.assignment`
      )
    );
  } else if (!manifest.assignments[assignment]) {
    findings.push(
      error(
        "unknown_assignment_path_target",
        `Assignment path ${targetId} points at unknown assignment ${assignment}.`,
        `assignmentPaths.${targetId}.assignment`
      )
    );
  }

  if (!kind) {
    findings.push(
      error(
        "invalid_assignment_path",
        `Assignment path ${targetId} is missing kind.`,
        `assignmentPaths.${targetId}.kind`
      )
    );
  } else if (resolvePlatformAdapter(kind) === null) {
    findings.push(
      error(
        "invalid_assignment_path",
        `Assignment path ${targetId} has unsupported kind ${kind}.`,
        `assignmentPaths.${targetId}.kind`
      )
    );
  }

  for (const field of PATH_FIELDS) {
    const candidate = assignmentPath[field];
    if (candidate !== undefined) {
      const value = normalizeValue(candidate);
      target[field] = value;
      target.exists[field] = await existsDirectory(value);
    }
  }

  target.path ??= target.codexHome ?? target.home;
  target.exists.path ||= await existsDirectory(target.path);

  const adapter = resolvePlatformAdapter(kind);
  if (adapter !== null) {
    target.platform = {
      adapter: adapter.id,
      installRoot: normalizeValue(assignmentPath[adapter.installRootField]),
      compatibility: [...adapter.compatibilityNames],
      metadata: { ...adapter.metadata }
    };
  }
  const hasKnownKind = adapter !== null;
  let hasMissingPath = false;

  if (adapter !== null) {
    for (const field of adapter.requiredFields) {
      const value = normalizeValue(assignmentPath[field]);
      if (!value) {
        findings.push(
          error(
            "invalid_assignment_path",
            `Assignment path ${targetId} is missing required field ${field}.`,
            `assignmentPaths.${targetId}.${field}`
          )
        );
        continue;
      }

      if (!hasMissingPath) {
        hasMissingPath = !(await existsDirectory(value));
      }
    }
  }

  const requiredErrors = findings.some(
    (finding) =>
      finding.level === "error" &&
      typeof finding.path === "string" &&
      finding.path.startsWith(`assignmentPaths.${targetId}`)
  );

  if (requiredErrors) {
    target.safety.classification = "invalid";
    target.safety.reason = "malformed or inconsistent assignment path data";
  } else if (!hasKnownKind) {
    target.safety.classification = "invalid";
    target.safety.reason = "unknown or unsupported target kind";
  } else if (hasMissingPath) {
    target.safety.classification = "missing";
    target.safety.reason = "declared path does not exist";
  } else {
    target.safety.classification = "live-install-root";
    target.safety.reason = "declared live install root";
  }

  return target;
}

async function existsDirectory(value: string | null): Promise<boolean> {
  if (!value) {
    return false;
  }

  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

function normalizeValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function error(code: string, message: string, pathName: string | null = null): TargetFinding {
  return finding("error", code, message, pathName);
}

function finding(
  level: TargetFindingLevel,
  code: string,
  message: string,
  pathName: string | null
): TargetFinding {
  return {
    level,
    code,
    message,
    path: pathName
  };
}
