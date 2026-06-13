type ManifestSuitcase = { skills: string[] };
type ManifestAssignment = { suitcases: string[] };
type ManifestVariant = {
  source?: string;
  agents?: string[];
  reason?: string;
};
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
  variants: Record<string, Record<string, ManifestVariant>>;
};

type ParsedSection = "suitcases" | "assignments" | "assignmentPaths" | "compatibility" | "variants" | null;
type CompatibilityField = "agents" | "evidence" | "blockedAgents" | null;
type VariantField = "agents" | null;

export function parseSuitcaseManifest(text: string): ParsedManifest {
  const manifest: ParsedManifest = {
    suitcases: {},
    assignments: {},
    assignmentPaths: {},
    compatibility: {},
    variants: {}
  };

  const lines = text.split(/\r?\n/);
  let section: ParsedSection = null;
  let currentName: string | null = null;
  let currentVariantName: string | null = null;
  let currentField: CompatibilityField = null;
  let currentVariantField: VariantField = null;

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
        sectionValue === "compatibility" ||
        sectionValue === "variants"
      )
        ? sectionValue
        : null;
      currentName = null;
      currentVariantName = null;
      currentField = null;
      currentVariantField = null;
      continue;
    }

    if (
      section !== "suitcases" &&
      section !== "assignments" &&
      section !== "assignmentPaths" &&
      section !== "compatibility" &&
      section !== "variants"
    ) {
      continue;
    }

    if (indent === 2 && trimmed.endsWith(":")) {
      currentName = trimmed.slice(0, -1);
      currentVariantName = null;
      currentField = null;
      currentVariantField = null;

      if (section === "suitcases") {
        manifest.suitcases[currentName] = { skills: [] };
      } else if (section === "assignments") {
        manifest.assignments[currentName] = { suitcases: [] };
      } else if (section === "assignmentPaths") {
        manifest.assignmentPaths[currentName] = {};
      } else if (section === "compatibility") {
        manifest.compatibility[currentName] = {};
      } else {
        manifest.variants[currentName] = {};
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
      continue;
    }

    if (section === "variants") {
      const variants = manifest.variants[name];
      if (!variants) continue;
      const parsed = parseVariantLine(
        variants,
        currentVariantName,
        indent,
        trimmed,
        currentVariantField
      );
      currentVariantName = parsed.currentVariantName;
      currentVariantField = parsed.currentVariantField;
    }
  }

  return manifest;
}

function parseVariantLine(
  variants: Record<string, ManifestVariant>,
  currentVariantName: string | null,
  indent: number,
  trimmed: string,
  currentVariantField: VariantField
): { currentVariantName: string | null; currentVariantField: VariantField } {
  if (indent === 4 && trimmed.endsWith(":")) {
    const variantName = trimmed.slice(0, -1);
    variants[variantName] = {};
    return {
      currentVariantName: variantName,
      currentVariantField: null
    };
  }

  if (!currentVariantName) {
    return { currentVariantName, currentVariantField };
  }

  const variant = variants[currentVariantName];
  if (!variant) {
    return { currentVariantName, currentVariantField };
  }

  if (indent === 6 && trimmed.startsWith("source:")) {
    variant.source = valueAfterColon(trimmed);
    return { currentVariantName, currentVariantField: null };
  }

  if (indent === 6 && trimmed.startsWith("reason:")) {
    variant.reason = valueAfterColon(trimmed);
    return { currentVariantName, currentVariantField: null };
  }

  if (indent === 6 && trimmed === "agents:") {
    variant.agents = [];
    return { currentVariantName, currentVariantField: "agents" };
  }

  if (indent === 8 && trimmed.startsWith("- ") && currentVariantField === "agents") {
    variant.agents?.push(trimmed.slice(2));
    return { currentVariantName, currentVariantField };
  }

  return { currentVariantName, currentVariantField };
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
