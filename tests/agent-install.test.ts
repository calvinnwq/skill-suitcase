import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("npm package includes the operator skill and install guide", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { files?: string[] };

  assert.ok(packageJson.files?.includes("skills/skill-suitcase"));
  assert.ok(packageJson.files?.includes("INSTALL.md"));
});

test("operator skill has complete frontmatter and conservative live-mutation rules", async () => {
  const skill = await readFile("skills/skill-suitcase/SKILL.md", "utf8");

  assert.match(skill, /^---\nname: skill-suitcase\n/m);
  assert.match(skill, /description: Use when asked to install, audit, sync, track, reconcile, apply, rollback, or explain Skill Suitcase-managed agent skills/);
  assert.doesNotMatch(skill, /TODO/);
  assert.match(skill, /read-only commands as the default path/);
  assert.match(skill, /Mutate live skill roots only after explicit human approval/);
  assert.match(skill, /Never force provider-managed Codex skills such as Codex `linear`/);
  assert.match(skill, /pack --output/);
  assert.match(skill, /apply --artifact/);
});

test("agent install guide tells agents how to install and verify the skill", async () => {
  const install = await readFile("INSTALL.md", "utf8");

  assert.match(install, /cp -R "\$SKILL_SRC" "\$HOME\/\.codex\/skills\/"/);
  assert.match(install, /cp -R "\$SKILL_SRC" "\$HOME\/\.claude\/skills\/"/);
  assert.match(install, /Restart the agent runtime after installing or replacing a skill/);
  assert.match(install, /Read-Only Audit First/);
  assert.match(install, /Mutate Only After Approval/);
  assert.match(install, /Codex `linear` is\s+provider-managed/);
});
