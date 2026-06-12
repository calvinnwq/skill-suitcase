export const EXIT_CODE_SUCCESS = 0;
export const EXIT_CODE_EXECUTION_FAILURE = 1;
export const EXIT_CODE_USAGE = 2;

export type CliExitCode = typeof EXIT_CODE_SUCCESS | typeof EXIT_CODE_EXECUTION_FAILURE | typeof EXIT_CODE_USAGE;

export function exitCodeForCommandResult(result: { ok: boolean }): typeof EXIT_CODE_SUCCESS | typeof EXIT_CODE_EXECUTION_FAILURE {
  return result.ok ? EXIT_CODE_SUCCESS : EXIT_CODE_EXECUTION_FAILURE;
}
