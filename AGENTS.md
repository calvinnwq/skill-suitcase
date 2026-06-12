# AGENTS.md

This repo is a TypeScript CLI. Keep the CLI architecture aligned with
[`ARCHITECTURE.md`](ARCHITECTURE.md).

Before adding or changing a command:

1. Read `ARCHITECTURE.md`.
2. Keep `src/cli.ts` as a thin entrypoint.
3. Put command-specific parsing and validation in `src/commands/`.
4. Put durable behavior in domain/core modules, not command modules.
5. Keep JSON stdout deterministic. Usage text, notices, and errors belong on stderr.

New product work should extend the command/core/adapter/renderer pattern instead
of adding behavior directly to `src/cli.ts`.
