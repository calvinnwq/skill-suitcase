import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validate } from "../src/validator.js";

test("npm package includes the operator skill and install guide", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { files?: string[] };

  assert.ok(packageJson.files?.includes("skills/skill-suitcase/SKILL.md"));
  assert.ok(packageJson.files?.includes("skills/skill-suitcase/agents/openai.yaml"));
  assert.ok(packageJson.files?.includes("skills/skill-suitcase/evals/prompt-fixtures.json"));
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

test("packaged operator skill passes strict catalog validation", async (t) => {
  const source = await mkdtemp(path.join(tmpdir(), "skill-suitcase-operator-catalog-"));
  t.after(async () => rm(source, { recursive: true, force: true }));
  const skillDirectory = path.join(source, "skills", "skill-suitcase");
  const resolverDirectory = path.join(
    source,
    "skills",
    "check-resolvable-local",
    "scripts"
  );
  const routingFixtureDirectory = path.join(
    source,
    "skills",
    "check-resolvable-local",
    "fixtures"
  );
  const testsDirectory = path.join(source, "tests");
  const promptEvalDirectory = path.join(skillDirectory, "evals");
  const competingSkillDirectories = [
    path.join(source, "skills", "catalog-auditor"),
    path.join(source, "skills", "project-recovery"),
    path.join(source, "skills", "release-promoter"),
  ];
  await Promise.all([
    mkdir(skillDirectory, { recursive: true }),
    mkdir(resolverDirectory, { recursive: true }),
    mkdir(routingFixtureDirectory, { recursive: true }),
    mkdir(testsDirectory, { recursive: true }),
    mkdir(promptEvalDirectory, { recursive: true }),
    ...competingSkillDirectories.map((directory) => mkdir(directory, { recursive: true })),
  ]);
  await Promise.all([
    copyFile("skills/skill-suitcase/SKILL.md", path.join(skillDirectory, "SKILL.md")),
    copyFile(
      "skills/skill-suitcase/evals/prompt-fixtures.json",
      path.join(promptEvalDirectory, "prompt-fixtures.json")
    ),
  ]);
  await Promise.all([
    writeFile(
      path.join(source, "skill-suitcase.yaml"),
      `suitcases:
  operator:
    skills:
      - skill-suitcase

assignments:
  agents:
    suitcases:
      - operator

assignmentPaths:
  agents:
    kind: agents-skills-root
    assignment: agents
    path: /path/to/disposable/agent-skills

compatibility:
  skill-suitcase:
    agents:
      - agents
    variant: canonical
`
    ),
    writeFile(
      path.join(routingFixtureDirectory, "routing-fixtures.json"),
      `${JSON.stringify({
        fixtures: [
          {
            utterance: "Install agent skills from the approved catalog.",
            expected: ["skill-suitcase"],
            forbidden: [],
          },
          {
            utterance: "Audit agent skill installs without changing the target.",
            expected: ["skill-suitcase"],
            forbidden: [],
          },
          {
            utterance: "Sync managed agent skills safely.",
            expected: ["skill-suitcase"],
            forbidden: [],
          },
          {
            utterance: "Recover a broken agent skill installation.",
            expected: ["skill-suitcase"],
            forbidden: [],
          },
          {
            utterance: "Promote this target-created agent skill into the catalog.",
            expected: ["skill-suitcase"],
            forbidden: [],
          },
          {
            utterance: "Refresh an upstream skill source in the catalog.",
            expected: ["skill-suitcase"],
            forbidden: [],
          },
          {
            utterance: "Banana quantum zebra",
            expected: [],
            forbidden: ["skill-suitcase"],
          },
          {
            utterance: "Audit the package catalog for dependency licenses.",
            expected: ["catalog-auditor"],
            forbidden: ["skill-suitcase"],
          },
          {
            utterance: "Recover deleted project files from Git history.",
            expected: ["project-recovery"],
            forbidden: ["skill-suitcase"],
          },
          {
            utterance: "Promote the release candidate to production.",
            expected: ["release-promoter"],
            forbidden: ["skill-suitcase"],
          },
        ],
      }, null, 2)}\n`
    ),
    writeFile(
      path.join(competingSkillDirectories[0]!, "SKILL.md"),
      `---
name: catalog-auditor
description: Use when asked to audit a package catalog for dependency licenses.
---

# Catalog Auditor
`
    ),
    writeFile(
      path.join(competingSkillDirectories[1]!, "SKILL.md"),
      `---
name: project-recovery
description: Use when asked to recover deleted project files from Git history.
---

# Project Recovery
`
    ),
    writeFile(
      path.join(competingSkillDirectories[2]!, "SKILL.md"),
      `---
name: release-promoter
description: Use when asked to promote a release candidate to production.
---

# Release Promoter
`
    ),
    writeFile(
      path.join(resolverDirectory, "check_resolvable_local.py"),
      `#!/usr/bin/env python3
import argparse
import json
import re
from pathlib import Path


def tokens(value):
    return set(re.findall(r"[a-z0-9]+", value.lower()))


def skill_description(skill_file):
    text = skill_file.read_text(encoding="utf-8")
    match = re.search(r"^description:\\s*(.+)$", text, re.MULTILINE)
    return match.group(1) if match else ""


def route_intent(root, utterance):
    utterance_tokens = tokens(utterance)
    ranked = []
    for skill_file in sorted((root / "skills").glob("*/SKILL.md")):
        skill_name = skill_file.parent.name
        score = len(utterance_tokens & tokens(skill_description(skill_file)))
        if skill_name.lower() in utterance.lower():
            score += 100
        ranked.append({"name": skill_name, "score": score})
    return sorted(
        (item for item in ranked if item["score"] > 0),
        key=lambda item: (-item["score"], item["name"]),
    )


def evaluate_routing(root, fixtures_path):
    fixtures = json.loads(fixtures_path.read_text(encoding="utf-8"))["fixtures"]
    cases = []
    for fixture in fixtures:
        predicted = [item["name"] for item in route_intent(root, fixture["utterance"])[:1]]
        ok = all(name in predicted for name in fixture["expected"])
        ok = ok and all(name not in predicted for name in fixture.get("forbidden", []))
        cases.append({"utterance": fixture["utterance"], "predicted": predicted, "ok": ok})
    return {"ok": all(case["ok"] for case in cases), "cases": cases}


parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("command", choices=["routing-eval"])
parser.add_argument("--fixtures", type=Path, required=True)
args = parser.parse_args()
print(json.dumps(evaluate_routing(args.root, args.fixtures), sort_keys=True))
`
    ),
    writeFile(
      path.join(testsDirectory, "test_skill_suitcase.py"),
      `import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]
CLI = Path(os.environ["SKILL_SUITCASE_CLI"])
NODE = os.environ["SKILL_SUITCASE_NODE"]
RESOLVER = ROOT / "skills" / "check-resolvable-local" / "scripts" / "check_resolvable_local.py"
ROUTING_FIXTURES = ROOT / "skills" / "check-resolvable-local" / "fixtures" / "routing-fixtures.json"
PROMPT_EVAL_FIXTURES = ROOT / "skills" / "skill-suitcase" / "evals" / "prompt-fixtures.json"


def run_cli(*args):
    result = subprocess.run(
        [NODE, str(CLI), *args, "--json"],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


class SkillSuitcaseCatalogContractTests(unittest.TestCase):
    def test_operator_skill_contract_unit(self):
        skill = (ROOT / "skills" / "skill-suitcase" / "SKILL.md").read_text(encoding="utf-8")
        contract = skill.split("## Contract", 1)[1].split("## Phases", 1)[0]
        self.assertIn("read-only command modes as the default path", contract)
        self.assertIn("Mutate a catalog or live skill root only after explicit human approval", contract)
        self.assertIn("Never run it directly against live Codex, Claude, OpenClaw, or other agent homes", contract)

    def test_operator_skill_integration_uses_strict_catalog_release_gate(self):
        result = run_cli("validate", "--source", str(ROOT), "--strict")
        self.assertTrue(result["ok"])
        self.assertEqual(1, result["summary"]["contractsComplete"])
        self.assertEqual(10, result["contracts"][0]["score"])

    def test_operator_prompt_eval_enforces_approval_boundary(self):
        skill = (ROOT / "skills" / "skill-suitcase" / "SKILL.md").read_text(encoding="utf-8")
        fixtures = json.loads(PROMPT_EVAL_FIXTURES.read_text(encoding="utf-8"))["cases"]
        self.assertEqual({"happy", "edge", "adversarial"}, {case["kind"] for case in fixtures})
        inspect_phase = skill.index("2. Inspect catalog and target state")
        approval_phase = skill.index("4. Request approval")
        mutation_phase = skill.index("5. Run only the approved mutation")
        self.assertLess(inspect_phase, approval_phase)
        self.assertLess(approval_phase, mutation_phase)
        for case in fixtures:
            expected = case["expected"]
            response = case["referenceResponse"].lower()
            self.assertEqual("audit", expected["firstAction"])
            self.assertFalse(expected["mutationAllowed"])
            for phrase in expected["responseMustInclude"]:
                self.assertIn(phrase.lower(), response)
            for phrase in expected["responseMustNotInclude"]:
                self.assertNotIn(phrase.lower(), response)

    def test_check_resolvable_local_routing_eval(self):
        result = subprocess.run(
            [
                sys.executable,
                str(RESOLVER),
                "--root",
                str(ROOT),
                "routing-eval",
                "--fixtures",
                str(ROUTING_FIXTURES),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        report = json.loads(result.stdout)
        self.assertTrue(report["ok"])
        by_utterance = {case["utterance"]: case for case in report["cases"]}
        self.assertEqual(10, len(by_utterance))
        for case in report["cases"][:6]:
            self.assertEqual(["skill-suitcase"], case["predicted"])
        self.assertEqual([], report["cases"][6]["predicted"])
        self.assertEqual(["catalog-auditor"], report["cases"][7]["predicted"])
        self.assertEqual(["project-recovery"], report["cases"][8]["predicted"])
        self.assertEqual(["release-promoter"], report["cases"][9]["predicted"])

    def test_routing_eval_fails_without_trigger_language(self):
        with TemporaryDirectory() as stripped_root:
            stripped_root = Path(stripped_root)
            shutil.copytree(ROOT / "skills", stripped_root / "skills")
            skill_file = stripped_root / "skills" / "skill-suitcase" / "SKILL.md"
            skill = skill_file.read_text(encoding="utf-8")
            skill = skill.replace(
                next(line for line in skill.splitlines() if line.startswith("description:")),
                "description: Use when asked to organize a physical suitcase.",
            )
            skill_file.write_text(skill, encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(RESOLVER),
                    "--root",
                    str(stripped_root),
                    "routing-eval",
                    "--fixtures",
                    str(ROUTING_FIXTURES),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            report = json.loads(result.stdout)
            self.assertFalse(report["ok"])
            for case in report["cases"][:6]:
                self.assertNotIn("skill-suitcase", case["predicted"])

    def test_e2e_user_turn_to_safe_side_effect(self):
        with TemporaryDirectory() as target, TemporaryDirectory() as stage:
            routing = subprocess.run(
                [
                    sys.executable,
                    str(RESOLVER),
                    "--root",
                    str(ROOT),
                    "routing-eval",
                    "--fixtures",
                    str(ROUTING_FIXTURES),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual("skill-suitcase", json.loads(routing.stdout)["cases"][0]["predicted"][0])

            initial = run_cli(
                "status",
                "--source",
                str(ROOT),
                "--target",
                "agents",
                "--agents-skills",
                target,
            )
            self.assertEqual(1, initial["summary"]["missing"])

            packed = run_cli(
                "pack",
                "--source",
                str(ROOT),
                "--target",
                "agents",
                "--agents-skills",
                target,
                "--output",
                stage,
            )
            applied = run_cli(
                "apply",
                "--source",
                str(ROOT),
                "--target",
                "agents",
                "--agents-skills",
                target,
                "--artifact",
                packed["bundle"]["artifactPath"],
            )
            self.assertTrue(applied["ok"])
            self.assertTrue((Path(target) / "skill-suitcase" / "SKILL.md").is_file())
            self.assertTrue((Path(target) / ".skill-suitcase-receipt.json").is_file())

            settled = run_cli(
                "status",
                "--source",
                str(ROOT),
                "--target",
                "agents",
                "--agents-skills",
                target,
            )
            self.assertEqual(1, settled["summary"]["current"])
            self.assertEqual(0, settled["summary"]["missing"])


if __name__ == "__main__":
    unittest.main()
`
    ),
  ]);

  const result = await validate({ source, strict: true });
  assert.equal(result.ok, true);
  assert.equal(result.strict, true);
  assert.equal(result.summary.referencedSkills, 1);
  assert.equal(result.summary.contractsEvaluated, 1);
  assert.equal(result.summary.contractsComplete, 1);
  assert.deepEqual(
    result.contracts.map((contract) => ({
      skill: contract.skill,
      score: contract.score,
      total: contract.total,
      complete: contract.complete,
    })),
    [{ skill: "skill-suitcase", score: 10, total: 10, complete: true }]
  );
  assert.deepEqual(result.findings.filter((finding) => finding.level === "error"), []);

  const executableEvidence = spawnSync(
    "python3",
    ["-m", "unittest", "discover", "-s", "tests", "-p", "test_skill_suitcase.py", "-v"],
    {
      cwd: source,
      encoding: "utf8",
      env: {
        ...process.env,
        SKILL_SUITCASE_CLI: path.join(process.cwd(), "dist", "src", "cli.js"),
        SKILL_SUITCASE_NODE: process.execPath,
      },
    }
  );
  assert.equal(
    executableEvidence.status,
    0,
    `catalog-root contract evidence failed:\n${executableEvidence.stdout}\n${executableEvidence.stderr}`
  );
  assert.match(executableEvidence.stderr, /Ran 6 tests/);
  assert.match(executableEvidence.stderr, /OK/);
});

test("agent install guide tells agents how to install and verify the skill", async () => {
  const [install, installHtml] = await Promise.all([
    readFile("INSTALL.md", "utf8"),
    readFile("docs/install.html", "utf8"),
  ]);

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

  const existingCheckoutBlock = installHtml.match(
    /Inspect an existing checkout[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>/
  )?.[1];
  assert.ok(existingCheckoutBlock, "the install page must keep an existing-checkout block");
  assert.match(existingCheckoutBlock, /^unset SRC$/m);
  assert.match(
    existingCheckoutBlock,
    /if test -e "\$HOME\/\.skill-suitcase\/skills\/\.git" &amp;&amp;\n  git -C "\$CATALOG_DIR" status --short --branch\nthen/
  );
  assert.match(existingCheckoutBlock, /export SRC="\$CATALOG_DIR"/);
  assert.match(existingCheckoutBlock, /Catalog checkout is missing; SRC was not exported/);
});
