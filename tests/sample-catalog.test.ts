import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { apply } from "../src/apply.js";
import { diff } from "../src/diff.js";
import { pack } from "../src/packer.js";
import { plan } from "../src/planner.js";
import { repair } from "../src/repair.js";
import { rollback } from "../src/rollback.js";
import { status } from "../src/status.js";
import { checkUpstream } from "../src/upstream.js";
import { validate } from "../src/validator.js";

const sampleCatalog = path.join(process.cwd(), "examples", "sample-catalog");

test("portable sample catalog exercises the offline lifecycle in disposable roots", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-sample-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const source = path.join(sandbox, "catalog");
  const targetRoot = path.join(sandbox, "agent-skills");
  const artifactRoot = path.join(sandbox, "pack");
  await cp(sampleCatalog, source, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  const targetOverrides = { agentsSkills: targetRoot };

  const validated = await validate({ source });
  assert.equal(validated.ok, true);
  assert.equal(validated.summary.referencedSkills, 1);
  assert.equal(validated.summary.upstreamDeclarations, 1);

  const upstream = await checkUpstream(source);
  assert.equal(upstream.ok, true);
  assert.equal(upstream.readOnly, true);
  assert.equal(upstream.summary.declared, 1);
  assert.equal(upstream.declarations[0]?.skill, "hello-suitcase");
  assert.equal(upstream.declarations[0]?.provider, "git");

  const planned = await plan({ source, target: "agents" });
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.planned.map((item) => item.skill), ["hello-suitcase"]);

  const initialStatus = await status({ source, target: "agents", targetOverrides });
  assert.equal(initialStatus.ok, true);
  assert.equal(initialStatus.summary.missing, 1);

  const initialDiff = await diff({ source, target: "agents", targetOverrides });
  assert.equal(initialDiff.ok, true);
  assert.ok(initialDiff.summary.create > 0);

  const dryPack = await pack({
    source,
    target: "agents",
    dryRun: true,
    targetOverrides
  });
  assert.equal(dryPack.ok, true);
  assert.equal(dryPack.dryRun, true);
  assert.equal(dryPack.summary.skills, 1);

  const packed = await pack({
    source,
    target: "agents",
    output: artifactRoot,
    targetOverrides
  });
  assert.equal(packed.ok, true);
  assert.ok(packed.bundle.artifactPath?.startsWith(`${artifactRoot}${path.sep}`));
  assert.equal(typeof packed.bundle.manifestPath, "string");

  const applied = await apply({
    source,
    target: "agents",
    artifact: packed.bundle.artifactPath as string,
    targetOverrides
  });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.applied.skills, ["hello-suitcase"]);

  const installedGreeting = path.join(
    targetRoot,
    "hello-suitcase",
    "references",
    "greeting.md"
  );
  const catalogGreeting = await readFile(
    path.join(source, "skills", "hello-suitcase", "references", "greeting.md"),
    "utf8"
  );
  assert.equal(await readFile(installedGreeting, "utf8"), catalogGreeting);

  const settled = await status({ source, target: "agents", targetOverrides });
  assert.equal(settled.summary.current, 1);

  const localEdit = `${catalogGreeting}\nLocal disposable edit.\n`;
  await writeFile(installedGreeting, localEdit);
  const dirty = await status({ source, target: "agents", targetOverrides });
  assert.equal(dirty.summary.dirty, 1);

  const repaired = await repair({
    source,
    target: "agents",
    skills: ["hello-suitcase"],
    apply: true,
    targetOverrides
  });
  assert.equal(repaired.ok, true);
  assert.deepEqual(repaired.repaired.skills, ["hello-suitcase"]);
  assert.equal(await readFile(installedGreeting, "utf8"), catalogGreeting);

  const rolledBack = await rollback({
    receipt: path.join(targetRoot, ".skill-suitcase-receipt.json")
  });
  assert.equal(rolledBack.ok, true);
  assert.equal(await readFile(installedGreeting, "utf8"), localEdit);
});

test("portable sample catalog contains placeholders instead of local homes or secrets", async () => {
  const manifest = await readFile(path.join(sampleCatalog, "skill-suitcase.yaml"), "utf8");
  const walkthrough = await readFile(path.join(sampleCatalog, "README.md"), "utf8");
  const upstreamLock = await readFile(
    path.join(sampleCatalog, ".skill-suitcase", "upstream-lock.json"),
    "utf8"
  );
  const fixtureText = `${manifest}\n${walkthrough}\n${upstreamLock}`;

  assert.match(manifest, /path: \/path\/to\/disposable\/agent-skills/);
  assert.doesNotMatch(fixtureText, /\/Users\/|\/home\/[^/\s]+|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
  assert.doesNotMatch(fixtureText, /(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*\S+/i);
});
