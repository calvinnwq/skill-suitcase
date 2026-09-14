/**
 * Parse the JSON stdout of an installed CLI invocation, surfacing spawn and empty-output failures directly.
 * @param {{ error?: Error, status: number | null, stdout: string | null, stderr: string | null }} result
 * @returns {any}
 */
export function parseCliJson(result) {
  if (result.error) {
    throw result.error;
  }
  if (!result.stdout) {
    throw new Error(`installed CLI produced no stdout (status ${result.status}): ${(result.stderr ?? "").trim()}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * True when `update --check` failed only because the registry could not be used from this network.
 * Every structured `registry-*` error code counts: unreachable hosts, timeouts, captive-portal redirects, and proxied bodies.
 * @param {number | null} status
 * @param {{ ok?: boolean, error?: { code?: string } | null }} checkResult
 */
export function isRegistryUnavailable(status, checkResult) {
  return status === 1 && checkResult.ok === false && typeof checkResult.error?.code === "string" && checkResult.error.code.startsWith("registry-");
}
