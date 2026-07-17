# Developing Skill Suitcase

This guide covers local development of the TypeScript CLI. Contribution policy
and pull request expectations live in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Prerequisites

- Node.js 20 or newer
- npm
- Git
- Python 3 for sample contract tests and local static-site preview

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
node dist/src/cli.js targets --source examples/sample-catalog --json
```

Use disposable fixtures or temporary directories when exercising mutating
commands. Do not point `apply`, `rollback`, `track`, `reconcile --apply`,
`repair --apply`, `promote --apply`, `import-target --apply`, `prune --apply`, or
`upstream import --apply` at a real agent home or catalog unless that mutation
is intentional and approved.
The [`examples/sample-catalog`](examples/sample-catalog/README.md) walkthrough provides a public-safe disposable lifecycle for `plan`, `diff`, `status`, `pack`, `apply`, `repair`, `rollback`, and upstream-policy checks.

## Architecture

Read the repository's
[`ARCHITECTURE.md`](https://github.com/calvinnwq/skill-suitcase/blob/main/ARCHITECTURE.md)
before changing a command or adding product behavior. The main boundaries are:

- `src/cli.ts` is a thin process entrypoint and owns direct access to
  `process.argv`, `process.stdout`, and `process.stderr`.
- `src/commands/` parses and validates command input.
- `src/core/` owns durable product behavior.
- `src/adapters/` owns filesystem and infrastructure boundaries.
- `src/renderers/` owns deterministic JSON, usage, and error rendering plus
  exit-code mapping, without writing process streams directly.

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

`pnpm test` rebuilds the project, recursively discovers every
`tests/**/*.test.ts` source, and fails if the compiled test inventory does not
match those sources exactly.
It then runs every compiled test and every `scripts/**/*.test.mjs` test with
Node's built-in test runner, including deterministic checks for the community
files, issue forms, local documentation links, and packaging validation.
`tests/public-docs-contract.test.ts` inventories root Markdown and reusable CSS,
HTML, JavaScript, JSON, Markdown, plain-text, and YAML documentation under
`docs/`, `skills/`, and `examples/`.
It rejects contributor-specific macOS, Linux, and Windows home paths and checks
each CLI invocation independently, including installed-binary, `$CLI`, compiled
CLI, wrapper, package-runner, and structured command examples.
Each example must be accepted by the shipped CLI and produce deterministic
output with `--json`.
`package:smoke` clean-builds through npm's `prepack` hook, validates the public
metadata and exact tarball payload, installs that tarball in an empty temporary
project, runs its read-only `targets` command, and strictly validates the
packaged sample catalog and its contract tests.
The package validation tests pin the exact curated Markdown files under `docs/`
and keep the GitHub Pages-only HTML, CSS, and JavaScript outside the tarball.
`package:prepare` is the lower-level clean-build and hash-recording step used by
`prepack`, while `package:validate` rechecks the recorded build without
rebuilding it.
`lint` currently aliases the TypeScript typecheck.
`format:check` runs
`git diff --check`, and `architecture:check` enforces the dependency,
process-IO, recognized-layer, thin-CLI, and command-module contracts documented
in `ARCHITECTURE.md`. The checker is intentionally syntactic rather than a
whole-program alias or control-flow analyzer.
The architecture contract tests run from
`scripts/architecture-contract.test.mjs` as part of `pnpm test`.

For a focused compiled test, build first and run the test file directly:

```bash
pnpm run build
node --test dist/tests/commands.test.js
```

The architecture contract suite runs directly from its source file:

```bash
node --test scripts/architecture-contract.test.mjs
```

When changing CLI output, test both the parsed JSON stdout and the stderr/exit
code contract. Tests should use temporary directories and deterministic fixture
data rather than depending on a contributor's home directory.

## Documentation and portability

Examples should use placeholders such as `/path/to/skills-catalog`, `$HOME`, or
temporary directories. Do not commit credentials, private prompts, real agent
home contents, or contributor-specific absolute paths.
Every literal public CLI invocation must be accepted by the shipped CLI and
produce deterministic output with `--json`, including each invocation in a
pipeline, command substitution, or subshell.
For example, do not combine `pack --dry-run` with `--output` in documentation.

The static docs site lives in `docs/` as plain HTML with one shared local
stylesheet and client script; there is no build step.
Preview it locally with `pnpm run docs:serve` at `http://127.0.0.1:8080/`.
`tests/docs-site.test.ts` is the site's deterministic check and runs inside
`pnpm test`.
HTML pages must stay at the root of `docs/`.
The navigation manifest must contain exactly one uniquely labeled internal
entry per page, keep the numbered reading order contiguous, and render pager
links in that order.
Deployment goes through `.github/workflows/pages.yml`.
