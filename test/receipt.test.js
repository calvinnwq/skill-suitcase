import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  RECEIPT_FILE,
  RECEIPT_SCHEMA,
  buildInstallRecord,
  buildReceipt,
  buildInstalledFiles,
  upsertAndWriteReceipt,
  writeReceipt,
  upsertInstallRecord
} from "../src/receipt.js";

test("receipt builder captures skill install metadata", () => {
  const base = buildReceipt({
    sourceRoot: "/Users/ngxcalvin/repos/skills",
    sourceRef: "refs/heads/main",
    sourceCommit: "deadbeef"
  });

  const installRecord = buildInstallRecord({
    skill: "office-hours",
    target: "openclaw",
    agent: "openclaw",
    mode: "copy",
    source: { path: "/src/skills/office-hours" },
    sourcePath: "/src/skills/office-hours",
    targetPath: "/tmp/openclaw/skills/office-hours",
    version: "2026.06.10",
    sourceCommit: "deadbeef",
    sourceHash: "cafebabe",
    installedFiles: [{ path: "SKILL.md", hash: "1234" }],
    priorState: { installedCommit: null, status: "missing" }
  });

  const receipt = upsertInstallRecord({
    ...base,
    installs: { ...base.installs }
  }, {
    skillName: "office-hours",
    installRecord
  });

  assert.equal(receipt.schema, RECEIPT_SCHEMA);
  assert.equal(receipt.source.repo, "/Users/ngxcalvin/repos/skills");
  assert.equal(receipt.source.ref, "refs/heads/main");
  assert.equal(receipt.source.commit, "deadbeef");

  const entry = receipt.installs["office-hours"];
  assert.equal(entry.skill, "office-hours");
  assert.equal(entry.target, "openclaw");
  assert.equal(entry.mode, "copy");
  assert.equal(entry.sourceCommit, "deadbeef");
  assert.equal(entry.sourceHash, "cafebabe");
  assert.equal(entry.installedFiles[0].path, "SKILL.md");
  assert.equal(entry.priorState.status, "missing");
  assert.ok(Array.isArray(entry.installedFiles));
});

test("receipt builder supports multi-target records for the same skill", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-receipt-multi-") );
  const installOne = path.join(sourceRoot, "openclaw");
  const installTwo = path.join(sourceRoot, "codex");
  const targetRecordDir = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-receipt-output-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRecordDir, { recursive: true, force: true }));
  await mkdir(installOne, { recursive: true });
  await mkdir(installTwo, { recursive: true });

  let receipt = buildReceipt({ sourceRoot });
  receipt = upsertInstallRecord({
    ...receipt,
    installs: { ...receipt.installs }
  }, {
    skillName: "office-hours",
    installRecord: buildInstallRecord({
      skill: "office-hours",
      agent: "openclaw",
      mode: "copy",
      targetPath: path.join(installOne, "office-hours"),
      sourcePath: "/repo/skills/office-hours",
      version: "2026.06.10"
    })
  });

  receipt = upsertInstallRecord({
    ...receipt,
    installs: { ...receipt.installs }
  }, {
    skillName: "office-hours",
    installRecord: buildInstallRecord({
      skill: "office-hours",
      agent: "openclaw",
      mode: "copy",
      targetPath: path.join(installTwo, "office-hours"),
      sourcePath: "/repo/skills/office-hours",
      version: "2026.06.10"
    })
  });

  const stored = {
    ...receipt,
    ...{ schema: RECEIPT_SCHEMA }
  };
  await writeFile(
    path.join(targetRecordDir, RECEIPT_FILE),
    `${JSON.stringify(stored, null, 2)}\n`,
    "utf8"
  );

  const loaded = JSON.parse(await readFile(path.join(targetRecordDir, RECEIPT_FILE), "utf8"));
  const entries = loaded.installs["office-hours"];
  assert.ok(Array.isArray(entries));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].targetPath.includes("openclaw"), true);
  assert.equal(entries[1].targetPath.includes("codex"), true);
});

test("upsertInstallRecord replaces existing record for the same skill/target path", () => {
  const receipt = buildReceipt({ sourceRoot: "/Users/ngxcalvin/repos/skills" });

  const prior = upsertInstallRecord({
    ...receipt,
    installs: { ...receipt.installs }
  }, {
    skillName: "office-hours",
    installRecord: buildInstallRecord({
      skill: "office-hours",
      agent: "openclaw",
      mode: "copy",
      targetPath: "/tmp/openclaw/skills/office-hours",
      sourcePath: "/repo/skills/office-hours",
      version: "2026.06.10"
    })
  });

  const updated = upsertInstallRecord({
    ...prior,
    installs: { ...prior.installs }
  }, {
    skillName: "office-hours",
    installRecord: buildInstallRecord({
      skill: "office-hours",
      agent: "openclaw",
      mode: "copy",
      targetPath: "/tmp/openclaw/skills/office-hours",
      sourcePath: "/repo/skills/office-hours",
      version: "2026.06.11"
    })
  });

  const entries = updated.installs["office-hours"];
  assert.equal(Array.isArray(entries), false);
  assert.equal(entries.version, "2026.06.11");
});

test("upsertInstallRecord appends records when target paths differ", () => {
  const receipt = buildReceipt({ sourceRoot: "/Users/ngxcalvin/repos/skills" });

  let current = upsertInstallRecord({
    ...receipt,
    installs: { ...receipt.installs }
  }, {
    skillName: "office-hours",
    installRecord: buildInstallRecord({
      skill: "office-hours",
      agent: "openclaw",
      mode: "copy",
      targetPath: "/tmp/openclaw/skills/office-hours",
      sourcePath: "/repo/skills/office-hours",
      version: "2026.06.10"
    })
  });

  current = upsertInstallRecord({
    ...current,
    installs: { ...current.installs }
  }, {
    skillName: "office-hours",
    installRecord: buildInstallRecord({
      skill: "office-hours",
      agent: "openclaw",
      mode: "copy",
      targetPath: "/tmp/codex/skills/office-hours",
      sourcePath: "/repo/skills/office-hours",
      version: "2026.06.10"
    })
  });

  const entries = current.installs["office-hours"];
  assert.equal(Array.isArray(entries), true);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].targetPath, "/tmp/openclaw/skills/office-hours");
  assert.equal(entries[1].targetPath, "/tmp/codex/skills/office-hours");
});

test("upsertInstallRecord treats equivalent target paths as the same install target", () => {
  const receipt = buildReceipt({ sourceRoot: "/Users/ngxcalvin/repos/skills" });

  const first = upsertInstallRecord({
    ...receipt,
    installs: { ...receipt.installs }
  }, {
    skillName: "office-hours",
    installRecord: buildInstallRecord({
      skill: "office-hours",
      agent: "openclaw",
      mode: "copy",
      targetPath: "/tmp/openclaw/skills/office-hours/",
      sourcePath: "/repo/skills/office-hours",
      version: "2026.06.10"
    })
  });

  const second = upsertInstallRecord({
    ...first,
    installs: { ...first.installs }
  }, {
    skillName: "office-hours",
    installRecord: buildInstallRecord({
      skill: "office-hours",
      agent: "openclaw",
      mode: "copy",
      targetPath: "/tmp/openclaw/skills/office-hours/../office-hours",
      sourcePath: "/repo/skills/office-hours",
      version: "2026.06.11"
    })
  });

  const entry = second.installs["office-hours"];
  assert.equal(Array.isArray(entry), false);
  assert.equal(entry.version, "2026.06.11");
});

test("upsertInstallRecord enforces required install record fields", () => {
  const receipt = buildReceipt({ sourceRoot: "/Users/ngxcalvin/repos/skills" });

  assert.throws(
    () =>
      upsertInstallRecord({
        ...receipt,
        installs: { ...receipt.installs }
      }, {
        skillName: "office-hours",
        installRecord: {
          agent: "openclaw",
          mode: "copy",
          targetPath: "/tmp/openclaw/skills/office-hours"
        }
      }),
    /installRecord must include sourcePath or source.path/
  );
});

test("upsertAndWriteReceipt rejects records with invalid source object metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upsert-write-invalid-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, "skills");

  const record = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    sourcePath: "/repo/skills/office-hours",
    source: { path: 123 },
    targetPath: path.join(installRoot, "office-hours"),
    version: "2026.06.10",
    sourceCommit: "deadbeef"
  });

  const receipt = buildReceipt({
    sourceRoot: "/Users/ngxcalvin/repos/skills",
    sourceRef: "refs/heads/main",
    sourceCommit: "cafebabe"
  });

  await assert.rejects(
    () =>
      upsertAndWriteReceipt({
        installRoot,
        receipt,
        skillName: "office-hours",
        installRecord: record
      }),
    /installRecord.source.path must be a non-empty string when source is an object/
  );
});

test("upsertAndWriteReceipt rejects records with non-string optional fields", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upsert-write-invalid-scalars-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, "skills");

  const record = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    target: { name: "openclaw" },
    targetPath: path.join(installRoot, "office-hours"),
    sourcePath: "/repo/skills/office-hours",
    version: 20260610,
    sourceCommit: "deadbeef",
    sourceHash: "cafebabe"
  });

  const receipt = buildReceipt({
    sourceRoot: "/Users/ngxcalvin/repos/skills",
    sourceRef: "refs/heads/main",
    sourceCommit: "cafebabe"
  });

  await assert.rejects(
    () =>
      upsertAndWriteReceipt({
        installRoot,
        receipt,
        skillName: "office-hours",
        installRecord: record
      }),
    /installRecord.target must be a string when provided/
  );
});

test("upsertAndWriteReceipt requires installRoot", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upsert-write-install-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const record = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    targetPath: path.join(root, "office-hours"),
    sourcePath: "/repo/skills/office-hours",
    version: "2026.06.10",
    sourceCommit: "deadbeef"
  });
  const receipt = buildReceipt({
    sourceRoot: "/Users/ngxcalvin/repos/skills",
    sourceRef: "refs/heads/main",
    sourceCommit: "cafebabe"
  });

  await assert.rejects(
    () =>
      upsertAndWriteReceipt({
        receipt,
        skillName: "office-hours",
        installRecord: record
      }),
    /installRoot is required/
  );
});

test("upsertAndWriteReceipt requires receiptPath", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upsert-write-receipt-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, "skills");

  const record = {
    agent: "openclaw",
    mode: "copy",
    skill: "office-hours",
    targetPath: path.join(installRoot, "office-hours"),
    sourcePath: "/repo/skills/office-hours",
    version: "2026.06.10",
    sourceCommit: "deadbeef"
  };
  const receipt = buildReceipt({
    sourceRoot: "/Users/ngxcalvin/repos/skills",
    sourceRef: "refs/heads/main",
    sourceCommit: "cafebabe"
  });

  await assert.rejects(
    () =>
      upsertAndWriteReceipt({
        installRoot,
        receipt,
        skillName: "office-hours",
        installRecord: record,
        receiptPath: ""
      }),
    /receiptPath must be a non-empty string/
  );
});

test("upsertAndWriteReceipt rejects records with non-string provenance fields", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upsert-write-invalid-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, "skills");

  const record = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    targetPath: path.join(installRoot, "office-hours"),
    sourcePath: "/repo/skills/office-hours",
    version: 20260611,
    sourceCommit: "cafebabe",
    sourceHash: 12345678
  });

  const receipt = buildReceipt({
    sourceRoot: "/Users/ngxcalvin/repos/skills",
    sourceRef: "refs/heads/main",
    sourceCommit: "cafebabe"
  });

  await assert.rejects(
    () =>
      upsertAndWriteReceipt({
        installRoot,
        receipt,
        skillName: "office-hours",
        installRecord: record
      }),
    /installRecord.version must be a string when provided/
  );
});

test("upsertAndWriteReceipt rejects records with invalid installed file list", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upsert-write-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, "skills");

  const record = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    targetPath: path.join(installRoot, "office-hours"),
    sourcePath: "/repo/skills/office-hours",
    version: "2026.06.10",
    sourceCommit: "deadbeef",
    installedFiles: ["bad-entry"]
  });

  const receipt = buildReceipt({
    sourceRoot: "/Users/ngxcalvin/repos/skills",
    sourceRef: "refs/heads/main",
    sourceCommit: "cafebabe"
  });

  assert.rejects(
    async () =>
      upsertAndWriteReceipt({
        installRoot,
        receipt,
        skillName: "office-hours",
        installRecord: record
      }),
    /installRecord.installedFiles must be an array/
  );
});

test("upsertAndWriteReceipt rejects records with invalid priorState", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upsert-write-invalid-priorstate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, "skills");

  const record = {
    agent: "openclaw",
    mode: "copy",
    skill: "office-hours",
    targetPath: path.join(installRoot, "office-hours"),
    sourcePath: "/repo/skills/office-hours",
    version: "2026.06.10",
    sourceCommit: "deadbeef",
    priorState: "bad"
  };
  const receipt = buildReceipt({
    sourceRoot: "/Users/ngxcalvin/repos/skills",
    sourceRef: "refs/heads/main",
    sourceCommit: "cafebabe"
  });

  await assert.rejects(
    () =>
      upsertAndWriteReceipt({
        installRoot,
        receipt,
        skillName: "office-hours",
        installRecord: record
      }),
    /installRecord.priorState must be an object/
  );
});

test("buildInstalledFiles returns deterministic install file hashes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-installed-files-"));
  const sourceSkill = path.join(root, "office-hours");
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(sourceSkill, { recursive: true });
  await mkdir(path.join(sourceSkill, "nested"), { recursive: true });
  await mkdir(path.join(sourceSkill, "__pycache__"), { recursive: true });

  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: office-hours\n---\n", "utf8");
  await writeFile(path.join(sourceSkill, "runtime.js"), "console.log('current');\n", "utf8");
  await writeFile(path.join(sourceSkill, "nested", "notes.txt"), "hello\n", "utf8");
  await writeFile(path.join(sourceSkill, "__pycache__", "cached.pyc"), "ignore this\n", "utf8");
  await writeFile(path.join(sourceSkill, "skip-me.pyc"), "ignore this\n", "utf8");

  const installedFiles = await buildInstalledFiles(sourceSkill);
  const expected = [
    { path: "SKILL.md", hash: createHash("sha256").update("---\nname: office-hours\n---\n", "utf8").digest("hex") },
    { path: "nested/notes.txt", hash: createHash("sha256").update("hello\n", "utf8").digest("hex") },
    { path: "runtime.js", hash: createHash("sha256").update("console.log('current');\n", "utf8").digest("hex") }
  ].sort((left, right) => left.path.localeCompare(right.path));

  assert.deepEqual(installedFiles, expected);
});

test("writeReceipt writes a normalized suitcase receipt to the install root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-write-receipt-"));
  const installRoot = path.join(root, "nested", "install");
  t.after(() => rm(root, { recursive: true, force: true }));

  const receipt = upsertInstallRecord({
    ...buildReceipt({
      sourceRoot: "/Users/ngxcalvin/repos/skills",
      sourceRef: "refs/heads/main",
      sourceCommit: "cafebabe"
    }),
    installs: {}
  }, {
    skillName: "office-hours",
    installRecord: buildInstallRecord({
      skill: "office-hours",
      agent: "openclaw",
      mode: "copy",
      target: "codex",
      sourcePath: "/repo/skills/office-hours",
      targetPath: "/tmp/codex/skills/office-hours",
      version: "2026.06.10"
    })
  });

  const receiptPath = await writeReceipt({ installRoot, receipt });
  const persisted = JSON.parse(await readFile(receiptPath, "utf8"));

  assert.equal(path.basename(receiptPath), RECEIPT_FILE);
  assert.equal(path.dirname(receiptPath), path.resolve(installRoot));
  assert.equal(persisted.schema, RECEIPT_SCHEMA);
  assert.equal(persisted.source.repo, "/Users/ngxcalvin/repos/skills");
  assert.equal(persisted.installs["office-hours"].version, "2026.06.10");
});

test("upsertAndWriteReceipt writes and upserts install records", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upsert-write-"));
  const installRoot = path.join(root, "skills");
  t.after(() => rm(root, { recursive: true, force: true }));

  const firstRecord = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    targetPath: path.join(installRoot, "office-hours"),
    sourcePath: "/repo/skills/office-hours",
    version: "2026.06.10",
    sourceCommit: "deadbeef",
    sourceHash: "cafebabe"
  });
  const alternateRecord = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    targetPath: path.join(installRoot, "office-hours-alt"),
    sourcePath: "/repo/skills/office-hours",
    version: "2026.07.01",
    sourceCommit: "feedface",
    sourceHash: "deadcafe"
  });
  const updateRecord = buildInstallRecord({
    ...firstRecord,
    version: "2026.06.11",
    sourceCommit: "cafed00d",
    sourceHash: "facefeed"
  });

  const receipt = buildReceipt({
    sourceRoot: "/Users/ngxcalvin/repos/skills",
    sourceRef: "refs/heads/main",
    sourceCommit: "cafebabe"
  });

  let receiptPath = await upsertAndWriteReceipt({
    installRoot,
    receipt,
    skillName: "office-hours",
    installRecord: firstRecord
  });
  let persisted = JSON.parse(await readFile(receiptPath, "utf8"));
  let entries = [].concat(persisted.installs["office-hours"]);
  assert.equal(Array.isArray(entries), true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].version, "2026.06.10");

  receiptPath = await upsertAndWriteReceipt({
    installRoot,
    receipt: persisted,
    skillName: "office-hours",
    installRecord: updateRecord
  });
  persisted = JSON.parse(await readFile(receiptPath, "utf8"));
  entries = [].concat(persisted.installs["office-hours"]);
  assert.equal(Array.isArray(entries), true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].version, "2026.06.11");

  await upsertAndWriteReceipt({
    installRoot,
    receipt: persisted,
    skillName: "office-hours",
    installRecord: alternateRecord,
    receiptPath: ".nested/receipts/.skill-suitcase-receipt.json"
  });
  const altReceiptPath = path.join(installRoot, ".nested/receipts/.skill-suitcase-receipt.json");
  const altPersisted = JSON.parse(await readFile(altReceiptPath, "utf8"));
  const altEntries = [].concat(altPersisted.installs["office-hours"]);
  assert.equal(Array.isArray(altEntries), true);
  assert.equal(altEntries.length, 2);
});

test("upsertAndWriteReceipt normalizes relative target paths for deduplication", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upsert-write-relative-target-"));
  const installRoot = path.join(root, "skills");
  t.after(() => rm(root, { recursive: true, force: true }));

  const relativeRecord = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    targetPath: "office-hours",
    sourcePath: "/repo/skills/office-hours",
    version: "2026.06.10",
    sourceCommit: "deadbeef",
    sourceHash: "cafebabe"
  });
  const absoluteRecord = buildInstallRecord({
    ...relativeRecord,
    version: "2026.06.11",
    targetPath: path.join(installRoot, "office-hours"),
    sourceCommit: "facefeed"
  });

  const receipt = buildReceipt({
    sourceRoot: "/Users/ngxcalvin/repos/skills",
    sourceRef: "refs/heads/main",
    sourceCommit: "cafebabe"
  });

  let receiptPath = await upsertAndWriteReceipt({
    installRoot,
    receipt,
    skillName: "office-hours",
    installRecord: relativeRecord
  });
  let persisted = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(Array.isArray(persisted.installs["office-hours"]), false);
  assert.equal(persisted.installs["office-hours"].targetPath, path.join(installRoot, "office-hours"));

  receiptPath = await upsertAndWriteReceipt({
    installRoot,
    receipt: persisted,
    skillName: "office-hours",
    installRecord: absoluteRecord
  });
  persisted = JSON.parse(await readFile(receiptPath, "utf8"));
  const entries = [].concat(persisted.installs["office-hours"]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].version, "2026.06.11");
  assert.equal(entries[0].sourceCommit, "facefeed");
  assert.equal(entries[0].targetPath, path.join(installRoot, "office-hours"));
});

test("upsertAndWriteReceipt preserves unrelated skill records while adding another skill", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upsert-multi-skill-"));
  const installRoot = path.join(root, "skills");
  t.after(() => rm(root, { recursive: true, force: true }));

  const officeRecord = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    targetPath: path.join(installRoot, "office-hours"),
    sourcePath: "/repo/skills/office-hours",
    version: "2026.06.10",
    sourceCommit: "deadbeef",
    sourceHash: "cafebabe"
  });
  const gnhfRecord = buildInstallRecord({
    skill: "gnhf-postflight",
    agent: "openclaw",
    mode: "copy",
    targetPath: path.join(installRoot, "gnhf-postflight"),
    sourcePath: "/repo/skills/gnhf-postflight",
    version: "2026.06.11",
    sourceCommit: "feedface",
    sourceHash: "facefeed"
  });

  let receipt = buildReceipt({
    sourceRoot: "/Users/ngxcalvin/repos/skills",
    sourceRef: "refs/heads/main",
    sourceCommit: "cafebabe"
  });

  let receiptPath = await upsertAndWriteReceipt({
    installRoot,
    receipt,
    skillName: officeRecord.skill,
    installRecord: officeRecord
  });

  receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receiptPath = await upsertAndWriteReceipt({
    installRoot,
    receipt,
    skillName: gnhfRecord.skill,
    installRecord: gnhfRecord
  });

  const persisted = JSON.parse(await readFile(receiptPath, "utf8"));
  const officeEntries = [].concat(persisted.installs["office-hours"]);
  const gnhfEntries = [].concat(persisted.installs["gnhf-postflight"]);

  assert.equal(Array.isArray(officeEntries), true);
  assert.equal(Array.isArray(gnhfEntries), true);
  assert.equal(officeEntries.length, 1);
  assert.equal(gnhfEntries.length, 1);
  assert.equal(officeEntries[0].version, "2026.06.10");
  assert.equal(gnhfEntries[0].version, "2026.06.11");

  const updatedOfficeRecord = {
    ...officeRecord,
    version: "2026.06.12",
    sourceCommit: "beadfeed",
    sourceHash: "badbeef"
  };
  receiptPath = await upsertAndWriteReceipt({
    installRoot,
    receipt: persisted,
    skillName: officeRecord.skill,
    installRecord: updatedOfficeRecord
  });

  const refreshed = JSON.parse(await readFile(receiptPath, "utf8"));
  const refreshedOffice = [].concat(refreshed.installs["office-hours"]);
  const refreshedGnhf = [].concat(refreshed.installs["gnhf-postflight"]);
  assert.equal(refreshedOffice[0].version, "2026.06.12");
  assert.equal(refreshedGnhf[0].version, "2026.06.11");
  assert.equal(refreshedOffice[0].sourceCommit, "beadfeed");
});

test("upsertAndWriteReceipt reads existing receipt from disk when receipt is omitted", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upsert-read-existing-"));
  const installRoot = path.join(root, "skills");
  t.after(() => rm(root, { recursive: true, force: true }));

  const officeRecord = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    targetPath: path.join(installRoot, "office-hours"),
    sourcePath: "/repo/skills/office-hours",
    version: "2026.06.10",
    sourceCommit: "deadbeef"
  });
  const gnhfRecord = buildInstallRecord({
    skill: "gnhf-postflight",
    agent: "openclaw",
    mode: "copy",
    targetPath: path.join(installRoot, "gnhf-postflight"),
    sourcePath: "/repo/skills/gnhf-postflight",
    version: "2026.06.11",
    sourceCommit: "feedface"
  });

  await upsertAndWriteReceipt({
    installRoot,
    skillName: officeRecord.skill,
    installRecord: officeRecord
  });

  const receiptPath = await upsertAndWriteReceipt({
    installRoot,
    skillName: gnhfRecord.skill,
    installRecord: gnhfRecord
  });

  const persisted = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(persisted.installs["office-hours"].version, "2026.06.10");
  assert.equal(persisted.installs["gnhf-postflight"].version, "2026.06.11");
});

test("writeReceipt defaults missing schema to modern suitcase schema", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-write-receipt-default-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const receiptPath = await writeReceipt({
    installRoot: root,
    receipt: {
      installs: {}
    }
  });

  const persisted = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(persisted.schema, RECEIPT_SCHEMA);
  assert.deepEqual(persisted.installs, {});
});

test("writeReceipt rejects invalid installs payloads", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-write-receipt-invalid-installs-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      writeReceipt({
        installRoot: root,
        receipt: {
          installs: []
        }
      }),
    /Receipt installs must be an object/
  );
});

test("upsertAndWriteReceipt rejects invalid installs payloads", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-upsert-invalid-installs-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const installRecord = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    targetPath: path.join(root, "office-hours"),
    sourcePath: "/repo/skills/office-hours",
    version: "2026.06.10"
  });

  await assert.rejects(
    () =>
      upsertAndWriteReceipt({
        installRoot: root,
        receipt: {
          installs: []
        },
        skillName: "office-hours",
        installRecord
      }),
    /Receipt installs must be an object/
  );
});

test("writeReceipt rejects invalid install records in existing installs mapping", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-write-receipt-invalid-mapping-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      writeReceipt({
        installRoot: root,
        receipt: {
          installs: {
            "office-hours": {
              skill: "office-hours",
              agent: "openclaw",
              mode: "copy",
              targetPath: path.join(root, "office-hours")
            }
          }
        }
      }),
    /installRecord must include sourcePath or source.path/
  );
});

test("writeReceipt creates missing parent directories for custom receipt paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-write-receipt-nested-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const customReceiptPath = ".nested/receipts/.skill-suitcase-receipt.json";
  const receiptPath = await writeReceipt({
    installRoot: root,
    receiptPath: customReceiptPath,
    receipt: {
      installs: {}
    }
  });

  const persisted = JSON.parse(await readFile(receiptPath, "utf8"));

  assert.equal(path.dirname(receiptPath), path.join(root, ".nested", "receipts"));
  assert.equal(persisted.schema, RECEIPT_SCHEMA);
  assert.deepEqual(persisted.installs, {});
  assert.equal(path.basename(receiptPath), ".skill-suitcase-receipt.json");
});

test("receipt writers reject custom receipt paths outside install root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-receipt-path-escape-"));
  const installRoot = path.join(root, "skills");
  t.after(() => rm(root, { recursive: true, force: true }));

  const installRecord = buildInstallRecord({
    skill: "office-hours",
    agent: "openclaw",
    mode: "copy",
    targetPath: path.join(installRoot, "office-hours"),
    sourcePath: "/repo/skills/office-hours",
    version: "2026.06.10"
  });

  await assert.rejects(
    () =>
      writeReceipt({
        installRoot,
        receiptPath: "../receipt.json",
        receipt: {
          installs: {}
        }
      }),
    /receiptPath must stay within installRoot/
  );

  await assert.rejects(
    () =>
      upsertAndWriteReceipt({
        installRoot,
        receiptPath: "../receipt.json",
        skillName: "office-hours",
        installRecord
      }),
    /receiptPath must stay within installRoot/
  );
});
