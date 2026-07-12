import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

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
    "import-target",
    "apply",
    "rollback",
    "refresh upstream catalog source",
    "explain Skill Suitcase-managed agent skills",
  ]) {
    assert.ok(description.includes(trigger), `operator skill description must include ${trigger}`);
  }
  assert.doesNotMatch(skill, /TODO/);
  assert.match(skill, /read-only commands as the default path/);
  assert.match(skill, /Mutate live skill roots only after explicit human approval/);
  assert.match(skill, /Source And Target Matrix/);
  assert.match(skill, /Future provider/);
  assert.match(skill, /provider-specific prose/);
  assert.match(skill, /Never force provider-managed Codex skills such as Codex `linear`/);
  assert.match(skill, /pack --output/);
  assert.match(skill, /apply --artifact/);
  assert.match(skill, /\$HOME\/repos\/skills-catalog/);
  assert.doesNotMatch(skill, /(?:~|\$HOME)\/repos\/skills(?=[/"`\s]|$)/);
});

test("agent install guide tells agents how to install and verify the skill", async () => {
  const install = await readFile("INSTALL.md", "utf8");

  assert.match(install, /These instructions are for any coding agent/);
  assert.doesNotMatch(install, /These instructions are for Codex, Claude/);
  assert.match(install, /AGENT_SKILLS_DIR="\$HOME\/\.codex\/skills"/);
  assert.match(install, /AGENT_SKILLS_DIR="\$HOME\/\.claude\/skills"/);
  assert.match(install, /cp -R "\$SKILL_SRC\/\." "\$INSTALL_TMP\/replacement\/"/);
  assert.match(install, /mv "\$TARGET" "\$INSTALL_TMP\/previous"/);
  assert.match(install, /mv "\$INSTALL_TMP\/replacement" "\$TARGET"/);
  assert.match(install, /Skill source not found:[\s\S]*?return 1/);
  assert.match(install, /Restart the agent runtime after installing or replacing a skill/);
  assert.match(install, /Read-Only Audit First/);
  assert.match(install, /Mutate Only After Approval/);
  assert.match(install, /Codex `linear` is\s+provider-managed/);
});
