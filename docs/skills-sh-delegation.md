# skills.sh Delegation Spike

Status: recommendation for Linear `NGX-458` / `SS-11`, extended by `NGX-513`.

Recommendation: do not add runtime `skills.sh` installer delegation yet. Keep
Skill Suitcase's native provider, apply, reconcile, repair, import-target,
symlink, promote, receipt, status, and rollback paths as the managed
install/repair path. Treat `skills.sh` as a compatibility metadata source for
now, and only add installer delegation later behind a narrow adapter if the
post-install state can be reconciled into Skill Suitcase receipts.

NGX-513 adds a narrower accepted use: `skills.sh` / `npx skills` may be used as
a pinned upstream source refresh lane for selected catalog skills. That lane
fetches source into an isolated temp workspace, compares it with the catalog,
and imports reviewed changes into the skills repo. It does not install into
live agent homes.

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
- targeted import-target for selected receipt-owned dirty targets whose local
  edits should become catalog source
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
Provider-backed compatibility targets such as OpenCode and Pi remain read-only
in Skill Suitcase, including when a catalog adds a custom manifest
`assignmentPaths` review root for them.
Broad materialization flows must return `read_only_target` for those roots
instead of converting provider-owned homes into managed install targets.

## Source Refresh Lane

Source refresh is different from installer delegation. It uses upstream tooling
to refresh the catalog source, then lets Skill Suitcase manage targets exactly
as before.

The intended v1 flow is:

```txt
upstream check -> sandboxed fetch/diff -> catalog import -> Git review -> pack/apply
```

Rules:

1. Pin the `skills` package version or use a reviewed vendored command path.
   Do not shell out to unpinned `npx skills`.
2. Run `npx skills` only in an isolated temp workspace/home for source refresh.
   Do not point it at Codex, Claude, OpenClaw, or other real agent homes.
3. Store upstream metadata with the catalog, separate from target assignment
   policy. Metadata may include provider, pinned package version, upstream skill
   identity, group labels, imported hash, and last imported provenance.
4. Treat the fetched upstream copy as proposed source, not as an install. Show a
   catalog diff before importing it.
5. Validate upstream lock metadata before provider execution, and abort malformed locks without fetching.
6. Import only into the catalog source tree, and only after the selected source
   skill has no uncommitted edits or untracked files.
7. Do not auto-commit. The import should produce ordinary repository diffs for
   review.
8. New-machine setup still installs from the skills repo through Skill Suitcase,
   not from `skills.sh` directly.
9. After import, use normal `pack`, `apply`, `track`, `status`, and `diff`
   flows to synchronize targets and write receipts.

This lane is useful for upstream-managed skill families such as HyperFrames:
`skills.sh` can provide a fresh source copy, while Skill Suitcase remains the
catalog, receipt, status, dirty-detection, and rollback authority.

## Upstream-Managed Lifecycle

Keep upstream-to-catalog drift separate from catalog-to-target drift.
`upstream check`, `upstream fetch`, and `upstream import` answer whether the
catalog should change. `status`, `diff`, `track`, `pack`, `apply`, `repair`,
`import-target`, and `rollback` answer whether a target should change.

Lifecycle cases:

| Case | Policy |
| --- | --- |
| Upstream unchanged | Report declaration health and lineage metadata, including upstream package/version, imported hash, and current catalog hash, without implying target work. |
| Upstream changed | Fetch into the sandbox, show a catalog diff, import only the selected skill after source hygiene passes, then review/commit before target sync. |
| Local catalog edit | Treat it as catalog-hash drift. Do not silently overwrite it with upstream. Commit/revert deliberately, or fork/adopt it into locally-authored catalog ownership in a future explicit flow. |
| Upstream removed or renamed | Report the missing upstream skill and preserve the current catalog source plus lock until an operator chooses keep, fork/adopt, rename, or delete. |
| Target drift | Use ordinary target status semantics and receipts. Never call `npx skills` against live homes as a shortcut. |

The trust boundary stays narrow: exact pinned package, isolated temp
workspace/home, fetched path inside the sandbox, required `SKILL.md`, and
catalog-only writes. Upstream tooling is not trusted to choose target roots,
write receipts, prove rollback state, or mutate live agent homes.

`upstream check --json` and `status --json` expose lineage metadata for
upstream-managed skills.
`upstream check` reports upstream package/version, upstream repo/skill, imported
hash, current catalog hash, and catalog drift.
`status` adds target status, receipt hash, and receipt commit from the selected
target receipt.
Target-scoped `status` should load lineage for reported skills only and should not hash unrelated upstream-managed catalog skills.

The v1 lock file is `.skill-suitcase/upstream-lock.json`:

```json
{
  "schema": "calvinnwq.skills.upstream-lock.v0",
  "skills": {
    "hyperframes": {
      "provider": "skills-sh",
      "packageVersion": "1.5.11",
      "upstream": {
        "repo": "heygen-com/hyperframes",
        "skill": "hyperframes"
      },
      "group": "hyperframes",
      "imported": {
        "sha256": "<catalog-tree-hash>",
        "packageVersion": "1.5.11",
        "at": "2026-06-23T08:30:00.000Z",
        "source": "skills-sh:heygen-com/hyperframes:hyperframes"
      }
    }
  }
}
```

Each declaration must use provider `skills-sh`, pin an exact `packageVersion`,
and include `upstream.repo` plus `upstream.skill`.
An optional `packageName` can override the default npm package name `skills`.
`validate --source <repo> --json` validates this metadata and counts valid
declarations in `summary.upstreamDeclarations`.
Manifest `validationPolicy.skillify.skip` must not replace this lock for upstream-managed skills; strict validation treats the upstream lock as the ownership source of truth and warns on duplicate manifest provenance.

The operator commands are:

```bash
skill-suitcase upstream check --source "$SRC" --json
skill-suitcase upstream fetch --source "$SRC" --skill hyperframes --dry-run --json
skill-suitcase upstream import --source "$SRC" --skill hyperframes --apply --json
```

`upstream fetch` and `upstream import` use an isolated temp workspace/home for
the pinned package execution.
`fetch` is read-only and returns a file-level catalog diff.
`import` refuses malformed lock metadata before fetching, writes only to the catalog skill directory and the upstream lock file on success, and does not install, sync, or receipt any live target.

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

Defer runtime delegation. Proceed first with source-only upstream refresh:
metadata, read-only checks, sandboxed fetch/diff, catalog import, and dogfood
with a real upstream-managed skill family. This should not replace native Skill
Suitcase install, reconcile, repair, import-target, promote, receipt, status, or
rollback semantics.
