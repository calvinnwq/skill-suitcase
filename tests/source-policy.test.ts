import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectSourcePolicyDeniedPaths } from "../src/core/source-policy.js";

test("deny scan refuses unreadable sourcePolicy excluded directories", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-suitcase-source-policy-deny-unreadable-"));
  const cacheRoot = path.join(root, ".cache");
  t.after(async () => {
    await chmod(cacheRoot, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(cacheRoot, { recursive: true });
  await writeFile(path.join(cacheRoot, ".env"), "TOKEN=secret\n");
  await chmod(cacheRoot, 0);

  assert.deepEqual(await collectSourcePolicyDeniedPaths(root, { exclude: ["**/.cache/**"] }), [".cache"]);
});
