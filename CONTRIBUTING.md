# Contributing

## Development

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm run format:check
```

`lint`, `typecheck`, `build`, and `format:check` currently run the same
JavaScript syntax check over `src` and `test`.

## Releases

GitHub releases are managed by Release Please. Use Conventional Commits for
changes that should appear in release notes:

- `feat:` for new release-worthy behavior
- `fix:` for bug fixes
- `docs:`, `test:`, `refactor:`, and `ci:` for non-release maintenance

Merging the Release Please PR updates `package.json`, `.release-please-manifest.json`,
and `CHANGELOG.md`, then creates the GitHub release and tag.

npm publishing is not configured yet.
