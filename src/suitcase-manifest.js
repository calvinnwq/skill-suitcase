export function parseSuitcaseManifest(text) {
  const manifest = {
    suitcases: {},
    assignments: {},
    compatibility: {}
  };

  const lines = text.split(/\r?\n/);
  let section = null;
  let currentName = null;
  let currentField = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || trimmed === "---") {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0 && trimmed.endsWith(":")) {
      section = trimmed.slice(0, -1);
      currentName = null;
      currentField = null;
      continue;
    }

    if (!["suitcases", "assignments", "compatibility"].includes(section)) {
      continue;
    }

    if (indent === 2 && trimmed.endsWith(":")) {
      currentName = trimmed.slice(0, -1);
      currentField = null;

      if (section === "suitcases") {
        manifest.suitcases[currentName] = { skills: [] };
      } else if (section === "assignments") {
        manifest.assignments[currentName] = { suitcases: [] };
      } else {
        manifest.compatibility[currentName] = {};
      }
      continue;
    }

    if (!currentName) {
      continue;
    }

    if (section === "suitcases") {
      parseSuitcaseLine(manifest.suitcases[currentName], indent, trimmed);
      continue;
    }

    if (section === "assignments") {
      parseAssignmentLine(manifest.assignments[currentName], indent, trimmed);
      continue;
    }

    if (section === "compatibility") {
      currentField = parseCompatibilityLine(
        manifest.compatibility[currentName],
        indent,
        trimmed,
        currentField
      );
    }
  }

  return manifest;
}

function parseSuitcaseLine(suitcase, indent, trimmed) {
  if (indent === 4 && trimmed === "skills:") {
    return;
  }

  if (indent === 6 && trimmed.startsWith("- ")) {
    suitcase.skills.push(trimmed.slice(2));
  }
}

function parseAssignmentLine(assignment, indent, trimmed) {
  if (indent === 4 && trimmed === "suitcases:") {
    return;
  }

  if (indent === 6 && trimmed.startsWith("- ")) {
    assignment.suitcases.push(trimmed.slice(2));
  }
}

function parseCompatibilityLine(compatibility, indent, trimmed, currentField) {
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
    compatibility.agents.push(trimmed.slice(2));
    return currentField;
  }

  if (indent === 6 && trimmed.startsWith("- ") && currentField === "evidence") {
    compatibility.evidence.push(trimmed.slice(2));
    return currentField;
  }

  if (indent === 6 && currentField === "blockedAgents") {
    const separator = trimmed.indexOf(":");
    if (separator !== -1) {
      const agent = trimmed.slice(0, separator).trim();
      const reason = trimmed.slice(separator + 1).trim();
      compatibility.blockedAgents[agent] = reason;
    }
    return currentField;
  }

  return currentField;
}

function valueAfterColon(line) {
  return line.slice(line.indexOf(":") + 1).trim();
}
