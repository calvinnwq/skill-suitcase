import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validate } from "../src/validator.js";

test("npm package includes the operator skill and install guide", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { files?: string[] };

  assert.ok(packageJson.files?.includes("skills/skill-suitcase/SKILL.md"));
  assert.ok(packageJson.files?.includes("skills/skill-suitcase/agents/openai.yaml"));
  assert.ok(packageJson.files?.includes("INSTALL.md"));
});

test("operator skill has complete frontmatter and conservative live-mutation rules", async () => {
  const skill = await readFile("skills/skill-suitcase/SKILL.md", "utf8");

  assert.match(skill, /^---\nname: skill-suitcase\n/m);
  const description = skill.match(/^description: (.+)$/m)?.[1];
  assert.ok(description);
  for (const trigger of [
    "install",
    "audit",
    "sync",
    "track",
    "reconcile",
    "repair",
    "prune",
    "promote",
    "import-target",
    "apply",
    "rollback",
    "refresh upstream catalog source",
    "explain Skill Suitcase-managed agent skills",
  ]) {
    assert.ok(description.includes(trigger), `operator skill description must include ${trigger}`);
  }
  assert.doesNotMatch(skill, /TODO/);
  assert.match(skill, /read-only command modes as the default path/);
  assert.match(skill, /Mutate a catalog or live skill root only after explicit human approval/);
  assert.match(skill, /## Phases/);
  assert.match(skill, /## Output Format/);
  assert.match(skill, /Source And Target Matrix/);
  assert.match(skill, /Future provider/);
  assert.match(skill, /provider-specific prose/);
  assert.match(skill, /Never force provider-managed Codex skills such as Codex `linear`/);
  assert.match(skill, /pack --output/);
  assert.match(skill, /apply --artifact/);
  assert.match(skill, /\$HOME\/\.skill-suitcase\/skills/);
  assert.doesNotMatch(skill, /(?:~|\$HOME)\/repos\/skills(?:-catalog)?(?=[/"`\s]|$)/);
});

test("operator skill mirrors the public inspect-stage-mutate safety model", async () => {
  const [skill, readme, agentMetadata] = await Promise.all([
    readFile("skills/skill-suitcase/SKILL.md", "utf8"),
    readFile("README.md", "utf8"),
    readFile("skills/skill-suitcase/agents/openai.yaml", "utf8"),
  ]);

  const readOnlyModes = [
    "`import`",
    "`validate`",
    "`targets`",
    "`plan`",
    "`status`",
    "`diff`",
    "`pack --dry-run`",
    "`reconcile --dry-run`",
    "`repair --dry-run`",
    "`prune --dry-run`",
    "`promote --dry-run`",
    "`import-target --dry-run`",
    "`upstream check`",
    "`upstream fetch --dry-run`",
  ];
  for (const mode of readOnlyModes) {
    assert.ok(readme.includes(mode), `README safety model must include ${mode}`);
    assert.ok(skill.includes(mode), `operator skill safety contract must include ${mode}`);
  }

  assert.match(skill, /pack --output/);
  assert.match(skill, /apply --artifact/);
  assert.match(skill, /restart the read-only audit/);
  assert.match(skill, /does not update `skill-suitcase\.yaml` or add target assignment state/);
  assert.match(skill, /separate\s+approval for the exact manifest change/);
  assert.doesNotMatch(skill, /Promotion creates catalog source and target assignment state/);
  assert.doesNotMatch(skill, /Refresh the catalog before inspecting/);
  assert.match(agentMetadata, /audit my catalog and target first/);
  assert.match(agentMetadata, /stage any approved skill changes safely/);
});

test("packaged operator skill passes catalog validation", async (t) => {
  const source = await mkdtemp(path.join(tmpdir(), "skill-suitcase-operator-catalog-"));
  t.after(async () => rm(source, { recursive: true, force: true }));
  const skillDirectory = path.join(source, "skills", "skill-suitcase");
  await mkdir(skillDirectory, { recursive: true });
  await copyFile("skills/skill-suitcase/SKILL.md", path.join(skillDirectory, "SKILL.md"));
  await writeFile(
    path.join(source, "skill-suitcase.yaml"),
    `suitcases:
  operator:
    skills:
      - skill-suitcase

assignments:
  codex:
    suitcases:
      - operator

assignmentPaths:
  codex:
    assignment: codex
`
  );

  const result = await validate({ source });
  assert.equal(result.ok, true);
  assert.equal(result.summary.referencedSkills, 1);
  assert.deepEqual(result.findings.filter((finding) => finding.level === "error"), []);
});

test("agent install guide tells agents how to install and verify the skill", async () => {
  const install = await readFile("INSTALL.md", "utf8");

  assert.match(install, /These instructions are for any coding agent/);
  assert.doesNotMatch(install, /These instructions are for Codex, Claude/);
  const runtimeRootBlock = install.match(
    /active assignment below when you are not installing for Codex:\n\n```bash\n([\s\S]*?)\n```/
  )?.[1];
  assert.ok(runtimeRootBlock, "the install guide must keep a copyable runtime-root block");
  for (const root of [
    "$HOME/.codex/skills",
    "$HOME/.claude/skills",
    "$HOME/.agents/skills",
    "$HOME/.grok/skills",
    "$HOME/.hermes/skills",
    "$HOME/.hermes/profiles/<name>/skills",
  ]) {
    assert.ok(runtimeRootBlock.includes(root), `the runtime-root block must document ${root}`);
  }
  assert.match(runtimeRootBlock, /^AGENT_SKILLS_DIR="\$HOME\/\.codex\/skills"$/m);
  assert.equal(
    runtimeRootBlock.match(/^\s*(?:export\s+)?AGENT_SKILLS_DIR\s*=/gm)?.length ?? 0,
    1,
    "the copyable runtime-root block must leave only one active assignment"
  );
  assert.match(install, /cp -R "\$SKILL_SRC\/\." "\$INSTALL_TMP\/replacement\/"/);
  assert.match(install, /mv "\$TARGET" "\$INSTALL_TMP\/previous"/);
  assert.match(install, /mv "\$INSTALL_TMP\/replacement" "\$TARGET"/);
  assert.match(install, /Skill source not found:[\s\S]*?return 1/);
  assert.match(install, /Restart the agent runtime after installing or replacing a skill/);
  assert.match(install, /Read-Only Audit First/);
  assert.match(install, /Mutate Only After Approval/);
  assert.match(install, /Codex `linear` is\s+provider-managed/);
});
