# Contributing

Thanks for helping improve Skill Suitcase. By participating, you agree to
follow the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Before You Start

- Use the repository issue chooser for reproducible bugs and feature proposals.
- Read [`SUPPORT.md`](SUPPORT.md) before opening a general support request.
- Report suspected vulnerabilities privately as described in
  [`SECURITY.md`](SECURITY.md), not in a public issue.
- For a non-trivial change, open or find an issue first so the intended behavior
  and safety boundary can be agreed before implementation.

## Development

Follow [`DEVELOPING.md`](DEVELOPING.md) for setup, architecture, test commands,
and local CLI workflows. Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before
changing a command, core module, adapter, or renderer.

Keep contributions focused. Add tests for behavior changes, update the
operator-facing documentation when a workflow changes, and use portable example
paths such as `$HOME` or `/path/to/catalog` instead of personal machine paths.

## Pull Requests

In the pull request:

1. Explain the user-visible outcome and any important design decision.
2. Link the relevant issue when one exists.
3. List the verification you ran.
4. Describe risk and rollback, including whether the change can write to a
   catalog or target install path.

Do not include generated `dist/` output, dependencies, credentials, local agent
state, or review artifacts. Keep unrelated changes in separate pull requests.

## Commits And Releases

GitHub releases are managed by Release Please. Use Conventional Commits for
changes that should appear in release notes:

- `feat:` for new release-worthy behavior
- `fix:` for bug fixes
- `docs:`, `test:`, `refactor:`, and `ci:` for non-release maintenance

Merging the Release Please PR updates `package.json`,
`.release-please-manifest.json`, and `CHANGELOG.md`, then creates the GitHub
release and tag.

When the Release Please run creates a GitHub release, the same workflow runs the normal gates, smoke-packs and installs the tarball, checks `npm publish --dry-run --access public --json`, and publishes it to npm with provenance through npm Trusted Publishing.
The npm package must have a trusted publisher configured for `calvinnwq/skill-suitcase` and workflow filename `release-please.yml`; do not add long-lived npm tokens.

See [`docs/release-readiness.md`](docs/release-readiness.md) for the Release
Please merge checklist, npm package/bin policy, repository controls, and the
public-documentation gate.
