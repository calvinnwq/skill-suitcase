# Developing Skill Suitcase

This guide covers local development of the TypeScript CLI. Contribution and
community expectations live in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Prerequisites

- Node.js 20 or newer; CI currently uses Node.js 24
- pnpm 10.34.4, as pinned by `packageManager` in `package.json`
- Git

Use npm's ephemeral executor for the pinned pnpm version. This shell function
keeps Corepack and global package-manager shims unchanged; keep it in the
current shell for the commands below:

```bash
pnpm() {
  npm exec --yes --package=pnpm@10.34.4 -- pnpm "$@"
}
test "$(pnpm --version)" = "10.34.4"
pnpm install --frozen-lockfile
```

## Architecture

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before changing product behavior. The
main boundaries are:

- `src/cli.ts`: thin process entrypoint
- `src/commands/`: argument parsing, validation, and command orchestration
- `src/core/`: durable domain behavior
- `src/adapters/`: filesystem and other infrastructure boundaries
- `src/renderers/`: deterministic JSON and stderr output
- `src/config/`: runtime defaults

New commands should extend those boundaries instead of putting behavior in
`src/cli.ts`. Core modules must not depend on commands, renderer text,
`process.argv`, or process output.

Skill Suitcase is JSON-first. Machine-readable stdout must remain deterministic.
Usage, notices, warnings, and errors belong on stderr.

## Common Commands

```bash
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run format:check
pnpm run architecture:check
```

`build` compiles TypeScript into `dist/`. `typecheck` runs `tsc --noEmit`, and
`lint` currently aliases that check. `test` removes `dist/`, builds, then runs
Node's test runner against the compiled test files. `format:check` runs
`git diff --check`.

For a focused test, build first and run the compiled file:

```bash
pnpm run build
node --test dist/tests/commands.test.js
```

## Exercising The CLI

Run the built entrypoint rather than checking generated output into Git:

```bash
pnpm run build
node dist/src/cli.js targets --source /path/to/skills-catalog --json
node dist/src/cli.js validate --source /path/to/skills-catalog --strict --json
```

Prefer read-only commands and disposable fixtures while developing. Commands
that apply, repair, reconcile, roll back, promote, import, or otherwise write to
a catalog or target require an explicit approval boundary. Do not test write
flows against a real agent home unless that target and mode were deliberately
chosen for the test.

## Adding Or Changing Behavior

1. Confirm the behavior belongs in the command/core/adapter/renderer pattern.
2. Put parsing and user-input validation in `src/commands/`.
3. Put reusable rules and state transitions in `src/core/`.
4. Keep filesystem details behind narrow adapter functions.
5. Preserve JSON stdout and stderr discipline.
6. Add or update tests under `tests/`.
7. Update the README, install runbook, operator skill, or architecture guide when
   their documented contract changes.

Before opening a pull request, run the checks relevant to the change; the full
local closeout is `pnpm test`, `pnpm run lint`, `pnpm run architecture:check`,
and `git diff --check`.
