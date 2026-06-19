# skills.sh Delegation Spike

Status: recommendation for Linear `NGX-458` / `SS-11`.

Recommendation: do not add runtime `skills.sh` installer delegation yet. Keep
Skill Suitcase's native provider, apply, reconcile, repair, symlink, promote,
receipt, status, and rollback paths as the managed install/repair path. Treat
`skills.sh` as a compatibility metadata source for now, and only add installer
delegation later behind a narrow adapter if the post-install state can be
reconciled into Skill Suitcase receipts.

## Evidence Checked

- npm package `skills` latest was `1.5.11` on 2026-06-16.
- The package exposes `skills` and `add-skill` binaries.
- The documented `skills add` install flags include `--global`, `--agent`,
  `--skill`, `--list`, `--copy`, `--yes`, and `--all`.
- The documented install modes are symlink by default and copy with `--copy`.
- The documented supported-agent matrix includes broad coverage, including
  Codex, Claude Code, OpenCode, OpenClaw, and Pi.
- The documented CLI surface does not expose a stable JSON install plan,
  receipt output, rollback contract, or exact post-install manifest suitable for
  direct Skill Suitcase ownership.
- The existing catalog repo compatibility path at
  `/Users/ngxcalvin/repos/skills/scripts/sync.py` shells out to
  `npx skills add <repo> --skill <skill> -g -a <agent> -y`, optionally with
  `--copy`. That path is useful as a compatibility adapter, but it does not
  create Skill Suitcase receipts or prove rollback ownership.

## Comparison

Native Skill Suitcase install/repair path:

- deterministic source and target resolution from manifest paths, local
  overrides, and vendored provider snapshots
- read-only planning before mutation
- copy and symlink install modes selected explicitly
- receipts with source provenance, hashes, install mode, and rollback state
- status and dirty detection after install
- targeted reconcile for selected unknown catalog-owned targets
- targeted repair for selected receipt-owned dirty targets
- rollback boundaries that refuse unmanaged or drifted state
- no network or package execution in normal tests

`skills.sh` delegation:

- strong broad-agent compatibility data
- useful source and agent-name normalization
- current docs show no machine-readable install receipt or JSON install result
- target behavior can drift with package releases unless the package is pinned
- default symlink behavior may not point at the same catalog source path Skill
  Suitcase expects
- rollback is not owned by Skill Suitcase unless every written path is
  reconciled afterward
- package execution introduces network/package drift risk if not isolated

The native path is therefore safer for managed installs. Delegation is not bad;
it is just not ready to become part of the authoritative write path.

## Wrapper Contract For A Future Issue

If delegation is added later, the adapter should be constrained like this:

1. Pin the `skills` package version or use a reviewed vendored command path.
   Do not shell out to unpinned `npx skills`.
2. Keep normal tests deterministic. Use fixtures for adapter parsing and only
   run live package smoke tests manually or in an isolated temp home.
3. Run a read-only preflight first. `skills add --list` may confirm source
   discovery, but Skill Suitcase must still compute expected target roots from
   its own target registry and overrides.
4. Require explicit approval before any live target write.
5. Capture the target state before execution, including whether the target was
   missing, a real directory, a symlink, or dirty.
6. Execute only for an exact target/agent pair that Skill Suitcase can resolve.
   Do not use `--all` or wildcard installs from the managed adapter.
7. After execution, hash-verify the installed target against the approved
   catalog source and classify symlink targets. Accept the install only when the
   target state exactly matches an allowed Skill Suitcase mode.
8. Write a Skill Suitcase receipt after reconciliation. If a receipt cannot be
   written, the install must not be considered managed.
9. Roll back only state the adapter can prove it created. If the target existed
   before or drifted during execution, report a manual recovery boundary instead
   of deleting it.
10. Keep provider snapshots and runtime installer delegation separate. Snapshot
    refreshes are source changes; delegated installs are live mutations.

## Decision

Defer runtime delegation. The next useful follow-up, if needed, is a small
implementation issue for a pinned `skills.sh` adapter contract or snapshot
refresh tool. That should still start read-only and should not replace native
Skill Suitcase install, reconcile, repair, promote, receipt, status, or rollback
semantics.
