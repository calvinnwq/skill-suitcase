import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scoreSkillContract } from "../src/core/validation/skillify-contract.js";
import { validate } from "../src/validator.js";

async function makeCatalogRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "skillify-contract-"));
}

async function writeSkill(root: string, name: string, skillMd: string): Promise<void> {
  const dir = path.join(root, "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), skillMd);
}

const PERFECT_SKILL_MD = `---
name: demo
description: |
  Demo skill. Use when the user wants the demo. Mentions a model prompt.
---

# Demo

## Contract

Trigger phrases mirror user wording.

This skill has a reachability and DRY audit gate.

## Filing rules

Filing rules: not applicable for this demo.

## Phases

### Phase 1

Do the thing.

## Output Format

JSON.
`;

const PERFECT_TEST_PY = `def test_demo_unit():
    assert True


def test_demo_integration_tempfile_routing_e2e():
    # integration test exercising routing and the e2e side effect with eval/quality
    # uses TemporaryDirectory and a real endpoint for the end-to-end side effect
    assert True
`;

async function writePerfectSkill(root: string): Promise<void> {
  await writeSkill(root, "demo", PERFECT_SKILL_MD);
  await mkdir(path.join(root, "skills", "demo", "scripts"), { recursive: true });
  await writeFile(path.join(root, "skills", "demo", "scripts", "check.py"), "print('ok')\n");
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, "tests", "test_demo.py"), PERFECT_TEST_PY);
  const fixturesDir = path.join(root, "skills", "check-resolvable-local", "fixtures");
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(path.join(fixturesDir, "routing-fixtures.json"), JSON.stringify({ cases: [{ skill: "demo" }] }));
}

test("scores a complete skill as 10/10", async () => {
  const root = await makeCatalogRoot();
  await writePerfectSkill(root);

  const report = await scoreSkillContract(root, "demo");

  assert.equal(report.skill, "demo");
  assert.equal(report.total, 10);
  assert.equal(report.score, 10);
  assert.equal(report.complete, true);
  const failing = report.items.filter((item) => !item.ok);
  assert.deepEqual(failing, []);
});

test("flags a bare skill and exposes per-item applicability", async () => {
  const root = await makeCatalogRoot();
  await writeSkill(root, "bare", "# Bare\n\nNo frontmatter, no sections.\n");

  const report = await scoreSkillContract(root, "bare");

  assert.equal(report.complete, false);
  assert.ok(report.score < 10);

  const byId = new Map(report.items.map((item) => [item.id, item]));

  // SKILL.md contract item fails on missing frontmatter and sections.
  assert.equal(byId.get(1)?.ok, false);
  assert.ok((byId.get(1)?.missing.length ?? 0) > 0);

  // Deterministic code is applicable (no N/A rationale) and missing.
  assert.equal(byId.get(2)?.ok, false);
  assert.equal(byId.get(2)?.applicable, true);

  // LLM evals are not applicable because the skill never mentions an LLM.
  assert.equal(byId.get(5)?.ok, false);
  assert.equal(byId.get(5)?.applicable, false);

  // Filing rules are not applicable because the skill writes no notes/memory.
  assert.equal(byId.get(10)?.applicable, false);
});

test("treats generic model/prompt prose as not-LLM but recognizes LLM phrasing", async () => {
  const root = await makeCatalogRoot();
  await writeSkill(
    root,
    "prose",
    `---
name: prose
description: Use when you need to prompt the user about a data model.
---

# Prose

## Contract

We prompt the user for confirmation and update the domain model. Trigger included.

## Phases

P.

## Output Format

O.
`
  );
  await writeSkill(
    root,
    "llmish",
    `---
name: llmish
description: Use when editing the system prompt for a language model. Trigger included.
---

# LLMish

## Contract

Tune the system prompt sent to the language model. Trigger included.

## Phases

P.

## Output Format

O.
`
  );

  const prose = await scoreSkillContract(root, "prose");
  const llmish = await scoreSkillContract(root, "llmish");

  // "prompt the user" / "domain model" are generic prose, so the LLM eval item
  // stays not-applicable instead of becoming a release-blocking failure.
  assert.equal(prose.items.find((item) => item.id === 5)?.applicable, false);
  // "system prompt" / "language model" are genuine LLM phrasing and remain applicable.
  assert.equal(llmish.items.find((item) => item.id === 5)?.applicable, true);
});

test("treats incidental note/memory prose as not-note-writing but recognizes genuine note outputs", async () => {
  const root = await makeCatalogRoot();
  await writeSkill(
    root,
    "shallow",
    `---
name: shallow
description: Use when you summarize the release notes. Trigger included.
---

# Shallow

## Contract

Summarize the latest release notes and recall prior decisions from memory. Trigger included.

## Phases

P.

## Output Format

O.
`
  );
  await writeSkill(
    root,
    "noteish",
    `---
name: noteish
description: Use when you capture meeting notes into the Obsidian vault. Trigger included.
---

# Noteish

## Contract

Capture meeting notes and write them to the Obsidian vault. Trigger included.

## Phases

P.

## Output Format

O.
`
  );

  const shallow = await scoreSkillContract(root, "shallow");
  const noteish = await scoreSkillContract(root, "noteish");

  // "release notes" / "from memory" are incidental prose, so the filing-rules
  // item stays not-applicable instead of becoming a release-blocking failure.
  assert.equal(shallow.items.find((item) => item.id === 10)?.applicable, false);
  // "meeting notes" written into an "Obsidian vault" is a genuine note output
  // and stays applicable, so a missing filing rule still gates.
  const noteishFiling = noteish.items.find((item) => item.id === 10);
  assert.equal(noteishFiling?.applicable, true);
  assert.equal(noteishFiling?.ok, false);
});

test("accepts explicit not-applicable rationales", async () => {
  const root = await makeCatalogRoot();
  await writeSkill(
    root,
    "rationale",
    `---
name: rationale
description: Rationale skill with explicit waivers.
---

# Rationale

## Contract

Code: not applicable, this skill is pure prose.
LLM evals: not applicable, no model calls.
Filing rules: not applicable, no notes are written.

## Phases

Phase one.

## Output Format

Text.
`
  );

  const report = await scoreSkillContract(root, "rationale");
  const byId = new Map(report.items.map((item) => [item.id, item]));

  // Code item passes via explicit N/A and is marked not applicable.
  assert.equal(byId.get(2)?.ok, true);
  assert.equal(byId.get(2)?.applicable, false);
  assert.deepEqual(byId.get(2)?.evidence, ["explicit Code N/A rationale"]);

  // LLM evals pass via explicit N/A.
  assert.equal(byId.get(5)?.ok, true);

  // Filing rules pass via explicit N/A.
  assert.equal(byId.get(10)?.ok, true);
});

test("parses block-scalar and quoted frontmatter values", async () => {
  const root = await makeCatalogRoot();
  await writeSkill(
    root,
    "quoted",
    `---
name: "quoted"
description: 'Use when quoting. Trigger words included.'
---

# Quoted

## Contract

Trigger.

## Phases

P.

## Output Format

O.
`
  );

  const report = await scoreSkillContract(root, "quoted");
  const byId = new Map(report.items.map((item) => [item.id, item]));

  // name with surrounding quotes still matches the skill name.
  assert.equal(byId.get(1)?.ok, true);
  // description with "Use when" and a Trigger section satisfies the resolver item.
  assert.equal(byId.get(6)?.ok, true);
});

test("parses CRLF frontmatter", async () => {
  const root = await makeCatalogRoot();
  const crlf = `---
name: crlf
description: |
  Use when the file is saved with Windows line endings. Trigger phrases included.
---

# CRLF

## Contract

Trigger.

## Phases

P.

## Output Format

O.
`.replace(/\n/g, "\r\n");
  await writeSkill(root, "crlf", crlf);

  const report = await scoreSkillContract(root, "crlf");
  const byId = new Map(report.items.map((item) => [item.id, item]));

  // name parses despite CRLF line endings, so it still matches the skill name.
  assert.equal(byId.get(1)?.ok, true);
  // multi-line block-scalar description with "Use when" survives CRLF normalization.
  assert.equal(byId.get(6)?.ok, true);
});

test("parses frontmatter with a leading UTF-8 BOM", async () => {
  const root = await makeCatalogRoot();
  const bom = `\uFEFF---
name: bom
description: |
  Use when the file is saved with a leading byte-order mark. Trigger phrases included.
---

# BOM

## Contract

Trigger.

## Phases

P.

## Output Format

O.
`;
  await writeSkill(root, "bom", bom);

  const report = await scoreSkillContract(root, "bom");
  const byId = new Map(report.items.map((item) => [item.id, item]));

  // name parses despite the leading BOM, so it still matches the skill name.
  assert.equal(byId.get(1)?.ok, true);
  // multi-line block-scalar description with "Use when" survives BOM stripping.
  assert.equal(byId.get(6)?.ok, true);
});

test("parses folded and chomped block-scalar descriptions", async () => {
  const root = await makeCatalogRoot();
  await writeSkill(
    root,
    "folded",
    `---
name: folded
description: >-
  Use when the description uses a folded block scalar.
  Trigger wording is preserved across the fold.
---

# Folded

## Contract

Trigger.

## Phases

P.

## Output Format

O.
`
  );

  const report = await scoreSkillContract(root, "folded");
  const byId = new Map(report.items.map((item) => [item.id, item]));

  // description is the folded body, not the literal ">-" indicator.
  assert.equal(byId.get(1)?.ok, true);
  // "Use when" inside the folded scalar satisfies the resolver trigger item.
  assert.equal(byId.get(6)?.ok, true);
});

test("strict validate surfaces contract reports and distinguishes warnings from failures", async () => {
  const root = await makeCatalogRoot();
  // A skill that is structurally broken (applicable failures) but mentions no LLM/notes.
  await writeSkill(root, "broken", "# Broken\n\nNo frontmatter.\n");
  await writeFile(
    path.join(root, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - broken

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    assignment: openclaw
`
  );

  const strictResult = await validate({ source: root, strict: true });
  assert.equal(strictResult.strict, true);
  assert.equal(strictResult.contracts.length, 1);
  assert.equal(strictResult.contracts[0]?.skill, "broken");
  assert.equal(strictResult.summary.contractsEvaluated, 1);
  assert.equal(strictResult.summary.contractsComplete, 0);

  const codes = strictResult.findings.map((finding) => finding.code);
  // Applicable contract gaps are release-blocking failures.
  assert.ok(codes.includes("skillify_contract_failed"));
  // Not-applicable contract gaps are warnings only.
  assert.ok(codes.includes("skillify_contract_warning"));
  // Release-blocking failures flip ok to false.
  assert.equal(strictResult.ok, false);

  const errorFinding = strictResult.findings.find((finding) => finding.code === "skillify_contract_failed");
  assert.equal(errorFinding?.level, "error");
  const warningFinding = strictResult.findings.find((finding) => finding.code === "skillify_contract_warning");
  assert.equal(warningFinding?.level, "warning");

  // Basic (non-strict) validation does not score contracts and stays fast.
  const basicResult = await validate({ source: root });
  assert.equal(basicResult.strict, false);
  assert.deepEqual(basicResult.contracts, []);
  assert.equal(basicResult.summary.contractsEvaluated, 0);
  assert.ok(!basicResult.findings.some((finding) => finding.code.startsWith("skillify_contract")));
});

test("strict validate skips upstream-managed skills for Skillify contract scoring", async () => {
  const root = await makeCatalogRoot();
  await writeSkill(root, "upstream-video", "# Upstream Video\n\nProvider-owned source shape.\n");
  await writeSkill(root, "local-broken", "# Local Broken\n\nNo frontmatter.\n");
  await mkdir(path.join(root, ".skill-suitcase"), { recursive: true });
  await writeFile(
    path.join(root, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - upstream-video
      - local-broken

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    assignment: openclaw
`
  );
  await writeFile(
    path.join(root, ".skill-suitcase", "upstream-lock.json"),
    `${JSON.stringify({
      schema: "calvinnwq.skills.upstream-lock.v0",
      skills: {
        "upstream-video": {
          provider: "skills-sh",
          packageVersion: "1.5.13",
          upstream: {
            repo: "heygen-com/hyperframes",
            skill: "upstream-video"
          },
          group: "video"
        }
      }
    }, null, 2)}\n`
  );

  const result = await validate({ source: root, strict: true });

  assert.equal(result.strict, true);
  assert.equal(result.summary.referencedSkills, 2);
  assert.equal(result.summary.upstreamDeclarations, 1);
  assert.equal(result.summary.contractsEvaluated, 1);
  assert.equal(result.summary.contractsSkippedUpstream, 1);
  assert.deepEqual(result.contracts.map((contract) => contract.skill), ["local-broken"]);
  assert.ok(result.findings.some((finding) => finding.path?.startsWith("skills.local-broken.contract.")));
  assert.ok(!result.findings.some((finding) => finding.path?.startsWith("skills.upstream-video.contract.")));
});

test("strict validate rejects non-upstream skip kinds for upstream-managed skills", async () => {
  const root = await makeCatalogRoot();
  await writeSkill(root, "external-overlap", "# External Overlap\n\nProvider-owned source shape.\n");
  await writeSkill(root, "legacy-overlap", "# Legacy Overlap\n\nProvider-owned source shape.\n");
  await mkdir(path.join(root, ".skill-suitcase"), { recursive: true });
  await writeFile(
    path.join(root, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - external-overlap
      - legacy-overlap

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    assignment: openclaw

validationPolicy:
  skillify:
    skip:
      external-overlap:
        kind: external-managed
        source: agents-global
        owner: upstream
        reason: Maintained in an external workflow source.
        reviewAfter: 2026-09-01
      legacy-overlap:
        kind: legacy-local
        source: local-catalog
        owner: skill-maintainers
        reason: Temporary exemption while old local skills are migrated.
        reviewAfter: 2026-09-01
`
  );
  await writeFile(
    path.join(root, ".skill-suitcase", "upstream-lock.json"),
    `${JSON.stringify({
      schema: "calvinnwq.skills.upstream-lock.v0",
      skills: {
        "external-overlap": {
          provider: "skills-sh",
          packageVersion: "1.5.13",
          upstream: {
            repo: "heygen-com/hyperframes",
            skill: "external-overlap"
          },
          group: "video"
        },
        "legacy-overlap": {
          provider: "skills-sh",
          packageVersion: "1.5.13",
          upstream: {
            repo: "heygen-com/hyperframes",
            skill: "legacy-overlap"
          },
          group: "video"
        }
      }
    }, null, 2)}\n`
  );

  const result = await validate({ source: root, strict: true });
  const overlapFindings = result.findings.filter((finding) => finding.code === "invalid_skillify_skip_upstream_overlap");

  assert.equal(result.ok, false);
  assert.equal(result.summary.contractsEvaluated, 0);
  assert.equal(result.summary.contractsSkippedUpstream, 2);
  assert.equal(result.summary.contractsSkippedExternal, 0);
  assert.equal(result.summary.contractsSkippedLegacy, 0);
  assert.equal(overlapFindings.length, 2);
  assert.ok(!result.findings.some((finding) => finding.code === "legacy_skillify_skip"));
});

test("strict validate skips external-managed skills with explicit provenance", async () => {
  const root = await makeCatalogRoot();
  await writeSkill(root, "external-video", "# External Video\n\nExternal source shape.\n");
  await writeSkill(root, "local-broken", "# Local Broken\n\nNo frontmatter.\n");
  await writeFile(
    path.join(root, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - external-video
      - local-broken

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    assignment: openclaw

validationPolicy:
  skillify:
    skip:
      external-video:
        kind: external-managed
        source: agents-global
        owner: upstream
        reason: Maintained in an external video workflow skill source.
        reviewAfter: 2026-09-01
`
  );

  const result = await validate({ source: root, strict: true });

  assert.equal(result.strict, true);
  assert.equal(result.summary.referencedSkills, 2);
  assert.equal(result.summary.contractsEvaluated, 1);
  assert.equal(result.summary.contractsSkippedExternal, 1);
  assert.equal(result.summary.contractsSkippedLegacy, 0);
  assert.deepEqual(result.contracts.map((contract) => contract.skill), ["local-broken"]);
  assert.ok(result.findings.some((finding) => finding.path?.startsWith("skills.local-broken.contract.")));
  assert.ok(!result.findings.some((finding) => finding.path?.startsWith("skills.external-video.contract.")));
  assert.ok(!result.findings.some((finding) => finding.path?.startsWith("validationPolicy.skillify.skip.external-video")));
});

test("strict validate reports malformed Skillify skip policy entries", async () => {
  const root = await makeCatalogRoot();
  await writeSkill(root, "external-video", "# External Video\n\nExternal source shape.\n");
  await writeSkill(root, "external-dated", "# External Dated\n\nExternal source shape.\n");
  await writeFile(
    path.join(root, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - external-video
      - external-dated

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    assignment: openclaw

validationPolicy:
  skillify:
    skip:
      external-video:
        kind: external-managed
        source: agents-global
      external-dated:
        kind: external-managed
        source: agents-global
        owner: upstream
        reason: Maintained in an external video workflow skill source.
        reviewAfter: soon
      stale-skill:
        kind: external-managed
        source: elsewhere
        owner: upstream
        reason: Not referenced.
      bad-kind:
        kind: maybe
        source: elsewhere
        owner: upstream
        reason: Invalid kind.
`
  );

  const result = await validate({ source: root, strict: true });
  const codes = result.findings.map((finding) => finding.code);

  assert.equal(result.ok, false);
  assert.equal(result.summary.contractsEvaluated, 2);
  assert.equal(result.summary.contractsSkippedExternal, 0);
  assert.ok(codes.includes("missing_skillify_skip_metadata"));
  assert.ok(codes.includes("invalid_skillify_skip_review_after"));
  assert.ok(codes.includes("unreferenced_skillify_skip"));
  assert.ok(codes.includes("invalid_skillify_skip_kind"));
  assert.ok(result.findings.some((finding) => finding.path?.startsWith("skills.external-video.contract.")));
  assert.ok(result.findings.some((finding) => finding.path?.startsWith("skills.external-dated.contract.")));
});

test("strict validate skips legacy-local skills but leaves a review warning", async () => {
  const root = await makeCatalogRoot();
  await writeSkill(root, "legacy-local", "# Legacy Local\n\nOld local source shape.\n");
  await writeFile(
    path.join(root, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - legacy-local

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    assignment: openclaw

validationPolicy:
  skillify:
    skip:
      legacy-local:
        kind: legacy-local
        source: local-catalog
        owner: skill-maintainers
        reason: Temporary exemption while old local skills are migrated.
        reviewAfter: 2026-09-01
`
  );

  const result = await validate({ source: root, strict: true });

  assert.equal(result.ok, true);
  assert.equal(result.summary.contractsEvaluated, 0);
  assert.equal(result.summary.contractsSkippedLegacy, 1);
  assert.deepEqual(result.contracts, []);
  assert.ok(result.findings.some((finding) => finding.code === "legacy_skillify_skip"));
  assert.ok(!result.findings.some((finding) => finding.path?.startsWith("skills.legacy-local.contract.")));
});

test("strict validate requires review dates for legacy-local skips", async () => {
  const root = await makeCatalogRoot();
  await writeSkill(root, "legacy-local", "# Legacy Local\n\nOld local source shape.\n");
  await writeFile(
    path.join(root, "skill-suitcase.yaml"),
    `suitcases:
  core:
    skills:
      - legacy-local

assignments:
  openclaw:
    suitcases:
      - core

assignmentPaths:
  openclaw:
    assignment: openclaw

validationPolicy:
  skillify:
    skip:
      legacy-local:
        kind: legacy-local
        source: local-catalog
        owner: skill-maintainers
        reason: Temporary exemption while old local skills are migrated.
`
  );

  const result = await validate({ source: root, strict: true });
  const codes = result.findings.map((finding) => finding.code);

  assert.equal(result.ok, false);
  assert.equal(result.summary.contractsSkippedLegacy, 1);
  assert.ok(codes.includes("missing_skillify_skip_review_after"));
  assert.ok(codes.includes("legacy_skillify_skip"));
});
