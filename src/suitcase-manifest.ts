type ManifestSuitcase = { skills: string[] };
type ManifestAssignment = { suitcases: string[] };
type ManifestCompatibility = {
  agents?: string[];
  evidence?: string[];
  blockedAgents?: Record<string, string>;
  variant?: string;
  reason?: string;
};
type ParsedManifest = {
  suitcases: Record<string, ManifestSuitcase>;
  assignments: Record<string, ManifestAssignment>;
  assignmentPaths: Record<string, Record<string, string>>;
  compatibility: Record<string, ManifestCompatibility>;
};

type ParsedSection = "suitcases" | "assignments" | "assignmentPaths" | "compatibility" | null;
type CompatibilityField = "agents" | "evidence" | "blockedAgents" | null;

export function parseSuitcaseManifest(text: string): ParsedManifest {
  const manifest: ParsedManifest = {
    suitcases: {},
    assignments: {},
    assignmentPaths: {},
    compatibility: {}
  };

  const lines = text.split(/\r?\n/);
  let section: ParsedSection = null;
  let currentName: string | null = null;
  let currentField: CompatibilityField = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || trimmed === "---") {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0 && trimmed.endsWith(":")) {
      const sectionValue = trimmed.slice(0, -1);
      section = (
        sectionValue === "suitcases" ||
        sectionValue === "assignments" ||
        sectionValue === "assignmentPaths" ||
        sectionValue === "compatibility"
      )
        ? sectionValue
        : null;
      currentName = null;
      currentField = null;
      continue;
    }

    if (
      section !== "suitcases" &&
      section !== "assignments" &&
      section !== "assignmentPaths" &&
      section !== "compatibility"
    ) {
      continue;
    }

    if (indent === 2 && trimmed.endsWith(":")) {
      currentName = trimmed.slice(0, -1);
      currentField = null;

      if (section === "suitcases") {
        manifest.suitcases[currentName] = { skills: [] };
      } else if (section === "assignments") {
        manifest.assignments[currentName] = { suitcases: [] };
      } else if (section === "assignmentPaths") {
        manifest.assignmentPaths[currentName] = {};
      } else {
        manifest.compatibility[currentName] = {};
      }
      continue;
    }

    if (!currentName) {
      continue;
    }
    const name = currentName;

    if (section === "suitcases") {
      const suitcase = manifest.suitcases[name];
      if (!suitcase) continue;
      parseSuitcaseLine(suitcase, indent, trimmed);
      continue;
    }

    if (section === "assignments") {
      const assignment = manifest.assignments[name];
      if (!assignment) continue;
      parseAssignmentLine(assignment, indent, trimmed);
      continue;
    }

    if (section === "assignmentPaths") {
      const assignmentPath = manifest.assignmentPaths[name];
      if (!assignmentPath) continue;
      parseMappingLine(assignmentPath, indent, trimmed);
      continue;
    }

    if (section === "compatibility") {
      const compatibility = manifest.compatibility[name];
      if (!compatibility) continue;
      currentField = parseCompatibilityLine(
        compatibility,
        indent,
        trimmed,
        currentField
      );
    }
  }

  return manifest;
}

function parseMappingLine(record: Record<string, string>, indent: number, trimmed: string): void {
  if (indent !== 4 || !trimmed.includes(":")) {
    return;
  }

  const separator = trimmed.indexOf(":");
  const key = trimmed.slice(0, separator).trim();
  const value = trimmed.slice(separator + 1).trim();
  record[key] = value;
}

function parseSuitcaseLine(suitcase: ManifestSuitcase, indent: number, trimmed: string): void {
  if (indent === 4 && trimmed === "skills:") {
    return;
  }

  if (indent === 6 && trimmed.startsWith("- ")) {
    suitcase.skills.push(trimmed.slice(2));
  }
}

function parseAssignmentLine(assignment: ManifestAssignment, indent: number, trimmed: string): void {
  if (indent === 4 && trimmed === "suitcases:") {
    return;
  }

  if (indent === 6 && trimmed.startsWith("- ")) {
    assignment.suitcases.push(trimmed.slice(2));
  }
}

function parseCompatibilityLine(
  compatibility: ManifestCompatibility,
  indent: number,
  trimmed: string,
  currentField: CompatibilityField
): CompatibilityField {
  if (indent === 4 && trimmed === "agents:") {
    compatibility.agents = [];
    return "agents";
  }

  if (indent === 4 && trimmed === "evidence:") {
    compatibility.evidence = [];
    return "evidence";
  }

  if (indent === 4 && trimmed === "blockedAgents:") {
    compatibility.blockedAgents = {};
    return "blockedAgents";
  }

  if (indent === 4 && trimmed.startsWith("variant:")) {
    compatibility.variant = valueAfterColon(trimmed);
    return null;
  }

  if (indent === 4 && trimmed.startsWith("reason:")) {
    compatibility.reason = valueAfterColon(trimmed);
    return null;
  }

  if (indent === 6 && trimmed.startsWith("- ") && currentField === "agents") {
    compatibility.agents?.push(trimmed.slice(2));
    return currentField;
  }

  if (indent === 6 && trimmed.startsWith("- ") && currentField === "evidence") {
    compatibility.evidence?.push(trimmed.slice(2));
    return currentField;
  }

  if (indent === 6 && currentField === "blockedAgents") {
    const separator = trimmed.indexOf(":");
    if (separator !== -1) {
      const agent = trimmed.slice(0, separator).trim();
      const reason = trimmed.slice(separator + 1).trim();
      compatibility.blockedAgents = compatibility.blockedAgents ?? {};
      compatibility.blockedAgents[agent] = reason;
    }
    return currentField;
  }

  return currentField;
}

function valueAfterColon(line: string): string {
  return line.slice(line.indexOf(":") + 1).trim();
}
