# Developing Skill Suitcase

This guide covers local development of the TypeScript CLI. Contribution policy
and pull request expectations live in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Prerequisites

- Node.js 20 or newer
- npm
- Git

## Set up the repository

```bash
git clone https://github.com/calvinnwq/skill-suitcase.git
cd skill-suitcase
pnpm() {
  npm exec --yes --package=pnpm@10.34.4 -- pnpm "$@"
}
test "$(pnpm --version)" = "10.34.4"
pnpm install --frozen-lockfile
```

This shell-local wrapper runs the pnpm version pinned by `packageManager` in
`package.json` without modifying Corepack or global package-manager shims.

Build and run the CLI from source:

```bash
pnpm run build
node dist/src/cli.js targets --source tests/fixtures/skills-catalog --json
```

Use disposable fixtures or temporary directories when exercising mutating
commands. Do not point `apply`, `rollback`, `track`, `reconcile --apply`,
`repair --apply`, `promote --apply`, `import-target --apply`, or
`upstream import --apply` at a real agent home or catalog unless that mutation
is intentional and approved.

## Architecture

Read the repository's
[`ARCHITECTURE.md`](https://github.com/calvinnwq/skill-suitcase/blob/main/ARCHITECTURE.md)
before changing a command or adding product behavior. The main boundaries are:

- `src/cli.ts` is a thin process entrypoint.
- `src/commands/` parses and validates command input.
- `src/core/` owns durable product behavior.
- `src/adapters/` owns filesystem and infrastructure boundaries.
- `src/renderers/` owns JSON, usage, error, and exit-code rendering.

Keep machine-readable JSON on stdout deterministic. Structured command results,
including findings, warnings, and `ok: false` errors, belong on stdout.
Parser/usage failures, uncaught fatal diagnostics, and non-JSON notices belong
on stderr.

## Verification

Run the full local gate:

```bash
pnpm test
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run package:smoke
pnpm run format:check
pnpm run architecture:check
```

`pnpm test` rebuilds the project and runs Node's built-in test runner against
the compiled test suite, including deterministic checks for the community files,
issue forms, local documentation links, and packaging validation.
`package:smoke` clean-builds through npm's `prepack` hook, validates the public
metadata and exact tarball payload, installs that tarball in an empty temporary
project, and runs its read-only `targets` command. `package:prepare` is the
lower-level clean-build and hash-recording step used by `prepack`, while
`package:validate` rechecks the recorded build without rebuilding it. `lint`
currently aliases the TypeScript typecheck. `format:check` runs
`git diff --check`, and `architecture:check` enforces the module boundaries
documented in `ARCHITECTURE.md`.

For a focused test, build first and run the compiled test file directly:

```bash
pnpm run build
node --test dist/tests/commands.test.js
```

When changing CLI output, test both the parsed JSON stdout and the stderr/exit
code contract. Tests should use temporary directories and deterministic fixture
data rather than depending on a contributor's home directory.

## Documentation and portability

Examples should use placeholders such as `/path/to/skills-catalog`, `$HOME`, or
temporary directories. Do not commit credentials, private prompts, real agent
home contents, or contributor-specific absolute paths.
