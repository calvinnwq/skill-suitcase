# Skill Variant Portability Matrix

Skill Suitcase treats the source catalog as the authority for canonical skill
bundles. Platform-specific live installs can be slimmer than the canonical
source, but they must not be overwritten unless the catalog explicitly models
that variant.

## Source Catalog Variants

Use `compatibility.<skill>.variant` to label the catalog source being planned or
packed. Current fixtures use `canonical` for the OpenClaw source bundle.

Use `compatibility.<skill>.agents` to list platforms that can receive that
source bundle without transformation.

Use `compatibility.<skill>.blockedAgents` to protect platforms that need a
separate slimmer variant. This is the current guard for `gnhf-postflight` on
Codex and Claude: the canonical OpenClaw bundle is blocked so `diff`, `pack`,
`apply`, and `track` cannot blindly replace the live slimmer copy.

## Generated Packs

Generated packs are immutable snapshots of a plan. They preserve the `variant`
label from the source catalog in `planned` and `blocked` records, but they do
not create a new variant model. If a platform needs a different source shape,
add that model to the catalog first, then generate a pack from that catalog
state.

## Regression Fixture

`tests/fixtures/skills-catalog/skill-suitcase.yaml` keeps
`gnhf-postflight` canonical for OpenClaw and blocked for Codex and Claude. Use
it when validating that:

- OpenClaw plans and packs the canonical bundle.
- Codex and Claude only receive portable core skills.
- Canonical `gnhf-postflight` appears as blocked for Codex or Claude when it is
  included in an assignment.
- `track` refuses to adopt a blocked canonical skill into a slimmer live target.
