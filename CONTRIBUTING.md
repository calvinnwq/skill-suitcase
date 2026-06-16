# Contributing

## Development

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before command, core, adapter, or
renderer changes.

```bash
pnpm test
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run format:check
pnpm run architecture:check
```

`build` compiles the TypeScript sources to `dist` with `tsc`. `typecheck` runs
`tsc --noEmit`, and `lint` is an alias for `typecheck`. `test` builds first, then
runs Node's built-in test runner against `dist/tests/*.test.js`. `format:check`
runs `git diff --check`. `architecture:check` runs `scripts/check-architecture.mjs`
to enforce the module boundaries described in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Releases

GitHub releases are managed by Release Please. Use Conventional Commits for
changes that should appear in release notes:

- `feat:` for new release-worthy behavior
- `fix:` for bug fixes
- `docs:`, `test:`, `refactor:`, and `ci:` for non-release maintenance

Merging the Release Please PR updates `package.json`, `.release-please-manifest.json`,
and `CHANGELOG.md`, then creates the GitHub release and tag.

npm publishing is not configured yet. Keep `private: true` until publishing is
approved separately.

See [`docs/release-readiness.md`](docs/release-readiness.md) for the Release
Please merge checklist, npm package/bin policy, GitHub visibility tradeoffs, and
the public-readiness checklist.
