import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readSkillVersion(skillPath: string): Promise<string | null> {
  const sourceSkill = await readFile(path.join(skillPath, "SKILL.md"), "utf8");
  return parseFrontmatterVersion(sourceSkill);
}

export function parseFrontmatterVersion(text: string): string | null {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    return null;
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "---") {
      break;
    }
    if (trimmed.startsWith("version:")) {
      return trimmed.slice("version:".length).trim();
    }
  }

  return null;
}
