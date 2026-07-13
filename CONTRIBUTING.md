# Contributing to Skill Suitcase

Thank you for helping improve Skill Suitcase. Contributions of bug reports,
documentation, tests, and code are welcome.

By participating, you agree to follow the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). For usage questions, start with
[`SUPPORT.md`](SUPPORT.md). Report vulnerabilities through the private process
in [`SECURITY.md`](SECURITY.md), not a public issue.

## Before opening an issue

- Search the existing issues and documentation first.
- Use the support request form for installation and usage questions.
- Use the bug report form for reproducible defects.
- Use the feature request form to describe a user problem before proposing an
  implementation.
- Remove credentials, private prompts, absolute home-directory paths, and other
  machine-specific data from logs and examples.

## Pull requests

1. Read [`DEVELOPING.md`](DEVELOPING.md) and the repository's
   [`ARCHITECTURE.md`](https://github.com/calvinnwq/skill-suitcase/blob/main/ARCHITECTURE.md).
2. Keep each pull request focused on one problem.
3. Add or update tests for behavior changes.
4. Update user-facing documentation when commands, output, or safety boundaries
   change.
5. Run the verification commands in `DEVELOPING.md` before requesting review.
6. Complete the pull request template, including risk and rollback notes.

Skill Suitcase is JSON-first. Keep JSON stdout deterministic. Structured command
results, including findings, warnings, and `ok: false` errors, belong on stdout.
Parser/usage failures, uncaught fatal diagnostics, and non-JSON notices belong
on stderr. Command modules should own parsing and validation, while durable
behavior belongs in core modules.
Literal `skill-suitcase` examples in public and reusable documentation must use
shipped commands and include `--json` on every invocation, including chained
commands.
Use portable placeholders instead of macOS, Linux, or Windows contributor home
paths.

## Commit and release conventions

Use Conventional Commit prefixes:

- `feat:` for release-worthy features
- `fix:` for bug fixes
- `docs:`, `test:`, `refactor:`, and `ci:` for maintenance

GitHub releases and npm publishing are managed by Release Please after changes
land on the default branch. Contributors should not update package versions or
the changelog for ordinary pull requests unless a maintainer requests it.

Merging the Release Please pull request updates `package.json`,
`.release-please-manifest.json`, and `CHANGELOG.md`, then creates the GitHub
release and tag. When a release is created, the same workflow verifies the
package and publishes it through npm Trusted Publishing. The npm package must
keep its trusted publisher configured for repository
`calvinnwq/skill-suitcase` and workflow `release-please.yml`; never introduce a
long-lived npm token.
The release gate smoke-packs and installs the tarball, then checks
`npm publish --dry-run --access public --json` before provenance publishing.

See [`docs/release-readiness.md`](docs/release-readiness.md) for the Release
Please merge checklist, npm package/bin policy, repository controls, and the
public-documentation gate.
