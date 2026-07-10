# CLAUDE.md

This repository is a TypeScript CLI. Follow [`AGENTS.md`](AGENTS.md) and keep
the implementation aligned with [`ARCHITECTURE.md`](ARCHITECTURE.md).

Before adding or changing a command:

1. Read `ARCHITECTURE.md`.
2. Keep `src/cli.ts` as a thin entrypoint.
3. Put command-specific parsing and validation in `src/commands/`.
4. Put durable behavior in domain or core modules, not command modules.
5. Keep JSON stdout deterministic. Usage text, notices, warnings, and errors
   belong on stderr.

Extend the command/core/adapter/renderer pattern for new product work. Preserve
unrelated working-tree changes, use temporary directories for mutation tests,
and run the verification commands in [`DEVELOPING.md`](DEVELOPING.md) before
handing off changes.
