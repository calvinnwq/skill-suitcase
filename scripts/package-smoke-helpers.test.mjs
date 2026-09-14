import assert from "node:assert/strict";
import { test } from "node:test";
import { isRegistryUnavailable, parseCliJson } from "./package-smoke-helpers.mjs";

test("parseCliJson surfaces spawn failures instead of a null dereference", () => {
  const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  assert.throws(() => parseCliJson({ error, status: null, stdout: null, stderr: null }), /ENOENT/);
  assert.throws(() => parseCliJson({ status: 1, stdout: "", stderr: "boom" }), /status 1.*boom/s);
  assert.deepEqual(parseCliJson({ status: 0, stdout: "{\"ok\":true}\n", stderr: "" }), { ok: true });
});

test("isRegistryUnavailable accepts every structured registry error and nothing else", () => {
  assert.equal(isRegistryUnavailable(1, { ok: false, error: { code: "registry-unreachable" } }), true);
  assert.equal(isRegistryUnavailable(1, { ok: false, error: { code: "registry-response-invalid" } }), true);
  assert.equal(isRegistryUnavailable(1, { ok: false, error: { code: "install-failed" } }), false);
  assert.equal(isRegistryUnavailable(0, { ok: true, error: null }), false);
});
