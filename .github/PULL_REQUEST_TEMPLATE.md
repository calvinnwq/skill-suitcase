## Summary

-

## Related issue

- Closes #

## Verification

- [ ] `pnpm test`
- [ ] `pnpm run lint`
- [ ] `pnpm run architecture:check`
- [ ] `pnpm run package:smoke`
- [ ] `git diff --check`

For user-visible changes:

- [ ] Tests cover the changed behavior.
- [ ] Documentation reflects the current CLI behavior and safety boundaries.
- [ ] JSON stdout remains deterministic; structured findings, warnings, and `ok: false` errors use stdout, while parser/usage failures, uncaught fatal diagnostics, and non-JSON notices use stderr.

## Risk / Rollback

-
