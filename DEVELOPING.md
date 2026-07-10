# Developing Skill Suitcase

This guide covers local development of the TypeScript CLI. Contribution policy
and pull request expectations live in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Prerequisites

- Node.js 20 or newer
- Corepack and pnpm
- Git

## Set up the repository

```bash
git clone https://github.com/calvinnwq/skill-suitcase.git
cd skill-suitcase
corepack enable
pnpm install --frozen-lockfile
```

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

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before changing a command or adding
product behavior. The main boundaries are:

- `src/cli.ts` is a thin process entrypoint.
- `src/commands/` parses and validates command input.
- `src/core/` owns durable product behavior.
- `src/adapters/` owns filesystem and infrastructure boundaries.
- `src/renderers/` owns JSON, usage, error, and exit-code rendering.

Keep machine-readable JSON on stdout deterministic. Human-readable usage,
notices, warnings, and errors belong on stderr.

## Verification

Run the full local gate:

```bash
pnpm test
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run format:check
pnpm run architecture:check
```

`pnpm test` rebuilds the project and runs Node's built-in test runner against
the compiled test suite, including deterministic checks for the community files,
issue forms, and local documentation links. `lint` currently aliases the
TypeScript typecheck. `format:check` runs `git diff --check`, and
`architecture:check` enforces the module boundaries documented in
`ARCHITECTURE.md`.

When changing CLI output, test both the parsed JSON stdout and the stderr/exit
code contract. Tests should use temporary directories and deterministic fixture
data rather than depending on a contributor's home directory.

## Documentation and portability

Examples should use placeholders such as `/path/to/skills-catalog`, `$HOME`, or
temporary directories. Do not commit credentials, private prompts, real agent
home contents, or contributor-specific absolute paths.
