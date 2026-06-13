# Skill Variant Portability Matrix

Skill Suitcase treats the source catalog as the authority for canonical skill
bundles. Platform-specific live installs can be slimmer than the canonical
source, but they must not be overwritten unless the catalog explicitly models
that variant.

## Source Catalog Variants

Use `compatibility.<skill>.variant` to label the default catalog source. Current
fixtures use `canonical` for the OpenClaw source bundle.

Use `compatibility.<skill>.agents` to list platforms that can receive that
source bundle without transformation.

Use `variants.<skill>.<variant>` to declare an installable source variant:

```yaml
variants:
  gnhf-postflight:
    canonical:
      source: skills/gnhf-postflight
      agents:
        - openclaw
    codex:
      source: variants/codex/gnhf-postflight
      agents:
        - codex
```

Planning picks the first variant whose `agents` match the resolved platform
adapter aliases. The planned item carries that variant name and source path
through `diff`, `pack`, `apply`, `track`, receipts, and `status`.

Use `compatibility.<skill>.blockedAgents` as the fallback guard when a platform
needs a slimmer variant but the source catalog does not yet provide one. In that
case the canonical OpenClaw bundle is blocked so `diff`, `pack`, `apply`, and
`track` cannot blindly replace the live slimmer copy.

Use `import --source <skills-catalog> --json` when onboarding or changing
variant metadata. It reports missing compatibility labels, missing variant agent
lists, blocked platform compatibility without variant sources, and variant
sources that are missing, lack `SKILL.md`, or resolve outside the source repo.

## Generated Packs

Generated packs are immutable snapshots of a resolved plan. They preserve the
selected `variant`, selected source path, file hashes, and staged file payloads.
They do not create or infer a variant model. If a platform needs a different
source shape, add that model to `variants` in the source catalog first, then
generate a pack from that catalog state.

## Regression Fixture

`tests/fixtures/skills-catalog/skill-suitcase.yaml` keeps `gnhf-postflight`
canonical for OpenClaw and declares slim Codex and Claude source variants. Use
it when validating that:

- OpenClaw plans and packs the canonical bundle.
- Codex and Claude can plan slim variants when their assignments include the
  skill.
- Canonical `gnhf-postflight` appears as blocked for Codex or Claude when a
  required slim source variant is absent.
- `track` refuses to adopt a blocked canonical skill into a slimmer live target.
