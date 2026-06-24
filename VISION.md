# Skill Suitcase Vision

Skill Suitcase is an agent-first skill package manager backed by a Git catalog.

The `skill-suitcase` CLI is the product backbone. Agents should use it to plan,
inspect, refresh, install, repair, reconcile, and explain skill state across
their own runtimes. Humans may still run the CLI directly for debugging or
release work, but the normal product experience should be mediated by agents.

## Product North Star

- `skill-suitcase` is the main product and tool.
- A renamable skills repository is the source-of-truth warehouse for owned
  skills, variants, logical groups, assignments, upstream metadata, and install
  policy.
- The CLI should be usable by any agent runtime, including Claude, Codex,
  OpenClaw, Hermes, and future runtimes.
- Runtime integrations should adapt to the CLI contract instead of becoming
  separate products.
- OpenClaw is a first-class integration and dogfood surface, not the whole
  product boundary.
- Upstream-managed skills, including skills fetched through `npx skills`, may
  keep their upstream as the versioning authority while Skill Suitcase manages
  reviewed catalog source, local receipts, target status, and safe installs.

## Operating Model

The skills repository is the durable warehouse. It stores reviewed skill source
and metadata in Git so agents can reason about changes before mutating live skill
roots. The repository name and location should be configurable; `skills` is a
convenient default, not a hard-coded identity.

The CLI is JSON-first because agents are the primary callers. Human-facing prose
and runbooks should explain the contract, but command outputs should remain
structured enough for agents to inspect, diff, approve, and recover reliably.

Skill Suitcase owns the local management layer:

- catalog import and validation
- manifest logical-group reporting
- target discovery and assignment resolution
- plans, diffs, bundles, and lock/hash proof
- receipts, status, rollback, and dirty-drift classification
- safe apply, track, reconcile, repair, promote, and import-target workflows
- upstream source refresh into the catalog before ordinary target sync

Upstream-to-catalog drift and catalog-to-target drift are separate decisions.

External providers can be sources of skill content or compatibility data. They
must not bypass Skill Suitcase receipts, review boundaries, or target safety
checks.

## Product Shape

The intended shape is not "OpenClaw-only." The standalone CLI is the backbone,
OpenClaw is the premium integrated experience and dogfood runtime, and broader
runtime compatibility is the expansion path. A runtime-agnostic skill standard is
useful positioning over time, but the practical wedge is an agent-first CLI that
can manage real skill catalogs safely today.

## Non-Goals

- Do not make humans manually run the CLI for routine operations.
- Do not treat live agent homes as the source of truth.
- Do not let `npx skills` write directly into managed target roots as the normal
  path.
- Do not fork the product into separate runtime-specific package managers.
- Do not make upstream refresh equivalent to target install authority.

## Relationship To Other Docs

- `ARCHITECTURE.md` defines the implementation boundaries that preserve this
  vision.
- `README.md` explains the current public CLI surface.
- `INSTALL.md` explains agent/runtime setup.
- `docs/skills-sh-delegation.md` records the current upstream-provider boundary.
