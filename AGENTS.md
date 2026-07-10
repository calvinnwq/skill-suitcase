# AGENTS.md

This repo is a TypeScript CLI. Keep the CLI architecture aligned with
[`ARCHITECTURE.md`](ARCHITECTURE.md).

Before adding or changing a command:

1. Read `ARCHITECTURE.md`.
2. Keep `src/cli.ts` as a thin entrypoint.
3. Put command-specific parsing and validation in `src/commands/`.
4. Put durable behavior in core modules, not command modules.
5. Keep JSON stdout deterministic. Structured command results, including
   findings, warnings, and `ok: false` errors, belong on stdout. Parser/usage
   failures, uncaught fatal diagnostics, and non-JSON notices belong on stderr.

New product work should extend the command/core/adapter/renderer pattern instead
of adding behavior directly to `src/cli.ts`.

Preserve existing user changes and avoid generated `dist/`, dependency, local
agent-state, or review-artifact files. Use portable paths such as `$HOME`, a
temporary directory, or `/path/to/catalog` in documentation and tests.

## Safety

Prefer read-only commands and disposable fixtures. Do not mutate a real catalog
or agent home without explicit approval for the target and mode. Keep secrets,
credentials, private prompts, and unrelated local state out of source and tool
output.

## Verification

Use the checks relevant to the change. The normal full set is:

```bash
pnpm test
pnpm run lint
pnpm run architecture:check
git diff --check
```

See [`DEVELOPING.md`](DEVELOPING.md) for setup, focused tests, and local CLI
examples.
