import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type ContractItem = {
  id: number;
  name: string;
  ok: boolean;
  evidence: string[];
  missing: string[];
  applicable: boolean;
};

export type ContractReport = {
  skill: string;
  score: number;
  total: number;
  complete: boolean;
  items: ContractItem[];
};

const REQUIRED_SECTIONS = ["## Contract", "## Phases", "## Output Format"] as const;
const NOTE_WRITING_TERMS = ["memory", "wiki", "vault", "obsidian", "notes"] as const;
const LLM_TERMS = ["llm", "model", "prompt", "claude", "codex", "openai", "anthropic", "gemini"] as const;

/**
 * Mirror of `skills/skillify/scripts/check_skillify_contract.py` from the
 * `calvinnwq/skills` catalog. Scores one skill against the strict Skillify-10
 * contract using the same deterministic heuristics so Skill Suitcase can report
 * the same evidence and missing reasons without shelling out to Python.
 */
export async function scoreSkillContract(root: string, skillName: string): Promise<ContractReport> {
  const skillRoot = path.resolve(root);
  const skillDir = path.join(skillRoot, "skills", skillName);
  const skillMd = path.join(skillDir, "SKILL.md");
  const skillText = await loadText(skillMd);
  const testsText = await combinedTestText(skillRoot, skillName);
  const frontmatter = parseFrontmatter(skillText);
  const scripts = await listScripts(path.join(skillDir, "scripts"));
  const testFiles = await existingTestFiles(skillRoot, skillName);

  const rel = (target: string): string => path.relative(skillRoot, target).split(path.sep).join("/");
  const description = frontmatter.description ?? "";
  const items: ContractItem[] = [];

  const skillMdOk = Boolean(
    (await pathExists(skillMd)) &&
      frontmatter.name === skillName &&
      frontmatter.description &&
      REQUIRED_SECTIONS.every((section) => skillText.includes(section))
  );
  items.push(
    contractItem(
      skillMdOk,
      1,
      "SKILL.md with frontmatter, trigger language, contract, phases, output format",
      skillMdOk ? [rel(skillMd)] : [],
      skillMdOk ? [] : ["missing or incomplete SKILL.md/frontmatter/required sections"]
    )
  );

  const codeNa = hasExplicitNa(skillText, "Code") || hasExplicitNa(skillText, "deterministic code");
  const codeOk = scripts.length > 0 || codeNa;
  const codeEvidence = scripts.length > 0
    ? scripts.map(rel)
    : codeNa
      ? ["explicit Code N/A rationale"]
      : [];
  items.push(
    contractItem(
      codeOk,
      2,
      "Deterministic code or explicit not-applicable rationale",
      codeEvidence,
      codeOk ? [] : ["add deterministic script under skill scripts/ or explicit Code N/A rationale"],
      !codeNa
    )
  );

  const unitOk = testFiles.length > 0 && /def test_/.test(testsText);
  items.push(
    contractItem(
      unitOk,
      3,
      "Unit tests for deterministic logic",
      unitOk ? testFiles.map(rel) : [],
      unitOk ? [] : [`add tests/test_${normalizeSkillName(skillName)}.py with unit tests`]
    )
  );

  const integrationOk = /integration|TemporaryDirectory|tempfile|live|real endpoint/i.test(testsText);
  items.push(
    contractItem(
      integrationOk,
      4,
      "Integration tests or realistic local fixture tests",
      integrationOk ? ["integration/local fixture evidence in test file"] : [],
      integrationOk ? [] : ["add integration test using real endpoint or realistic local fixture"]
    )
  );

  const mentionsLlm = LLM_TERMS.some((term) => `${skillText}\n${testsText}`.toLowerCase().includes(term));
  const evalOk = /eval|quality/i.test(testsText) || hasExplicitNa(skillText, "LLM evals");
  items.push(
    contractItem(
      evalOk,
      5,
      "LLM/prompt evals or explicit not-applicable rationale",
      evalOk ? ["eval evidence in tests or explicit LLM evals N/A rationale"] : [],
      evalOk ? [] : ["add happy/edge/adversarial eval tests or explicit LLM evals N/A rationale"],
      mentionsLlm
    )
  );

  const triggerOk = description.toLowerCase().includes("use when") && /Trigger|trigger/.test(skillText);
  items.push(
    contractItem(
      triggerOk,
      6,
      "Resolver trigger language mirrors user wording",
      triggerOk ? ["description contains Use when and trigger section"] : [],
      triggerOk ? [] : ["add Use when trigger language and examples based on real user wording"]
    )
  );

  const routingFixture = path.join(skillRoot, "skills", "check-resolvable-local", "fixtures", "routing-fixtures.json");
  const routingText = await loadText(routingFixture);
  const routingOk = routingText.includes(skillName) && /route_intent|evaluate_routing|routing/i.test(testsText);
  items.push(
    contractItem(
      routingOk,
      7,
      "Resolver trigger eval routes requests to this skill",
      routingOk ? [rel(routingFixture), ...testFiles.map(rel)] : [],
      routingOk ? [] : ["add routing fixture and test/eval through local routing path"]
    )
  );

  const auditOk = /audit_workspace|check_resolvable_local|reachability|overlap|DRY/i.test(`${testsText}\n${skillText}`);
  items.push(
    contractItem(
      auditOk,
      8,
      "Reachability / DRY audit gate",
      auditOk ? ["audit evidence in tests or skill verification commands"] : [],
      auditOk ? [] : ["add check_resolvable_local audit gate and target-skill assertion"]
    )
  );

  const e2eOk = /e2e|end-to-end|route.*generate|user turn|side effect/i.test(testsText);
  items.push(
    contractItem(
      e2eOk,
      9,
      "E2E smoke from user request to outcome/side effect",
      e2eOk ? ["E2E evidence in tests"] : [],
      e2eOk ? [] : ["add E2E smoke from realistic user request through local outcome"]
    )
  );

  const writesNotes =
    NOTE_WRITING_TERMS.some((term) => skillText.toLowerCase().includes(term)) &&
    !hasExplicitNa(skillText, "Filing rules");
  const filingOk =
    hasExplicitNa(skillText, "Filing rules") ||
    /filing rules|router|VAULT_MAP|memory\/wiki\/vault/i.test(skillText);
  items.push(
    contractItem(
      filingOk,
      10,
      "Filing rules for note/memory/wiki/vault outputs, or explicit N/A",
      filingOk ? ["filing rules present or explicit Filing rules N/A"] : [],
      filingOk ? [] : ["add filing/routing rules for generated outputs or explicit Filing rules N/A"],
      writesNotes
    )
  );

  const score = items.filter((item) => item.ok).length;
  const total = items.length;
  return { skill: skillName, score, total, complete: score === total, items };
}

function contractItem(
  ok: boolean,
  id: number,
  name: string,
  evidence: string[],
  missing: string[],
  applicable = true
): ContractItem {
  return { id, name, ok, evidence, missing, applicable };
}

function normalizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function loadText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listScripts(scriptsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(scriptsDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith("."))
    .map((name) => path.join(scriptsDir, name))
    .sort();
}

function testFileCandidates(root: string, skillName: string): string[] {
  const slug = normalizeSkillName(skillName);
  const dashed = skillName.replace(/-/g, "_");
  const candidates = [
    path.join(root, "tests", `test_${slug}.py`),
    path.join(root, "tests", `test_${dashed}.py`)
  ];
  return [...new Set(candidates)];
}

async function existingTestFiles(root: string, skillName: string): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of testFileCandidates(root, skillName)) {
    if (await pathExists(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

async function combinedTestText(root: string, skillName: string): Promise<string> {
  const files = await existingTestFiles(root, skillName);
  const texts = await Promise.all(files.map((file) => loadText(file)));
  return texts.join("\n");
}

function hasExplicitNa(text: string, item: string): boolean {
  const pattern = new RegExp(`${escapeRegExp(item)}[^\\n]*(?:not applicable|n/a|not needed)`, "i");
  return pattern.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseFrontmatter(content: string): Record<string, string> {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n") || !normalized.includes("\n---\n")) {
    return {};
  }

  const raw = normalized.split("\n---\n")[0]!.slice(4);
  const result: Record<string, string> = {};
  let currentKey: string | null = null;
  let collected: string[] = [];

  for (const line of raw.split("\n")) {
    if (currentKey && (line.startsWith(" ") || line.trim() === "")) {
      collected.push(line.trim());
      continue;
    }
    if (currentKey) {
      result[currentKey] = collected.join("\n").trim();
      currentKey = null;
      collected = [];
    }
    if (!line.includes(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (isBlockScalarHeader(value)) {
      currentKey = key;
      collected = [];
    } else {
      result[key] = stripQuotes(value);
    }
  }

  if (currentKey) {
    result[currentKey] = collected.join("\n").trim();
  }

  return result;
}

function isBlockScalarHeader(value: string): boolean {
  return /^[|>][0-9]*[+-]?$/.test(value);
}

function stripQuotes(value: string): string {
  return value.replace(/^["']+/, "").replace(/["']+$/, "");
}
