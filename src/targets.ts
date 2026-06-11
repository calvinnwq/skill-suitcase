import { stat } from "node:fs/promises";
import { loadCatalog } from "./catalog.js";

const KIND_PATH_RULES = {
  "openclaw-skills-root": ["path"],
  "claude-skills-root": ["path"],
  "codex-home": ["codexHome", "skillsPath"],
  "nested-home-codex": ["home", "codexHome", "skillsPath"]
};

const PATH_FIELDS = ["path", "home", "codexHome", "skillsPath"];
const SUPPORTED_KINDS = new Set(Object.keys(KIND_PATH_RULES));

export async function targets({ source }) {
  if (!source) {
    throw new Error("source is required");
  }

  const { sourceRoot, manifestPath, manifest } = await loadCatalog(source);
  const findings = [];
  const discovered = [];

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

async function describeTarget(targetId, assignmentPath, manifest, findings) {
  const target = {
    id: targetId,
    name: targetId,
    assignment: null,
    kind: null,
    path: null,
    home: null,
    codexHome: null,
    skillsPath: null,
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
  const kind = normalizeValue(assignmentPath.kind);
  target.assignment = assignment;
  target.kind = kind;

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
  } else if (!SUPPORTED_KINDS.has(kind)) {
    findings.push(
      error(
        "invalid_assignment_path",
        `Assignment path ${targetId} has unsupported kind ${kind}.`,
        `assignmentPaths.${targetId}.kind`
      )
    );
  }

  for (const field of PATH_FIELDS) {
    if (assignmentPath[field] !== undefined) {
      target[field] = normalizeValue(assignmentPath[field]);
      target.exists[field] = await existsDirectory(target[field]);
    }
  }

  target.path ??= target.codexHome ?? target.home;
  target.exists.path ||= await existsDirectory(target.path);

  const hasKnownKind = target.kind && SUPPORTED_KINDS.has(target.kind);
  let hasMissingPath = false;

  if (hasKnownKind) {
    for (const field of KIND_PATH_RULES[target.kind]) {
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

      const pathExists = await existsDirectory(value);
      if (value && !pathExists) {
        hasMissingPath = true;
      }
    }
  }

  const requiredErrors = findings.some(
    (finding) =>
      finding.level === "error" &&
      finding.path &&
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

async function existsDirectory(value) {
  if (!value) {
    return false;
  }

  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

function normalizeValue(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function error(code, message, pathName = null) {
  return finding("error", code, message, pathName);
}

function finding(level, code, message, pathName) {
  return {
    level,
    code,
    message,
    path: pathName
  };
}
