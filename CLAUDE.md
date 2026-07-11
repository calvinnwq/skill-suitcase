# CLAUDE.md

This repository is a TypeScript CLI. Follow [`AGENTS.md`](AGENTS.md) and treat
[`ARCHITECTURE.md`](ARCHITECTURE.md) as the source of truth for implementation
boundaries.

## Implementation Rules

- Keep `src/cli.ts` as a thin process entrypoint.
- Put command parsing and validation in `src/commands/`.
- Put durable behavior and state transitions in `src/core/`.
- Keep filesystem and infrastructure details in adapters.
- Render deterministic JSON on stdout; send usage, notices, warnings, and errors
  to stderr.
- Extend the command/core/adapter/renderer pattern instead of bypassing it.

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
pnpm run package:smoke
pnpm run architecture:check
git diff --check
```

See [`DEVELOPING.md`](DEVELOPING.md) for setup, focused tests, and local CLI
examples.
