---
title: CLI Self-Update and Version Notices - Plan
type: feat
date: 2026-09-11
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# CLI Self-Update and Version Notices - Plan

## Goal Capsule

- **Objective:** Let users update the npm-installed CLI on demand and discover newer releases through a small terminal reminder.
- **Authority:** The Product Contract records the approved scope. `AGENTS.md` and `ARCHITECTURE.md` govern implementation boundaries. New user instructions override this plan.
- **Execution:** Planning is approved; implementation has not been authorized by approval of this document alone. Use focused regression tests and disposable installation fixtures when implementation is authorized.
- **Stop conditions:** Stop when the requirements and verification gates pass. Do not expand into skill updates, package-manager migration, release infrastructure, or a general updater framework.
- **Delivery boundary:** No live global installation, catalog, or agent home may be changed for verification. Branch creation, commits, pushes, PRs, and publishing require separate authorization.

---

## Product Contract

### Summary

Add an explicit CLI update command for supported global npm installations.
Show a separate terminal notice when a newer stable release is available.
Keep existing command data and all catalogs and installed skills unchanged.

### Problem Frame

Users currently repeat the npm installation procedure to upgrade the CLI.
There is no CLI-owned version check or reminder.
The existing `upstream` command concerns catalog sources, not the CLI package, so it is not the owner of this feature.

### Requirements

**Explicit updates**

- R1. The `update` command works without catalog arguments and without requiring `--json`. Invoking it authorizes installation without another prompt; `--check` checks availability without installing.
- R2. Only a verified global npm installation can be self-updated. Source checkouts, npm links, project-local packages, ephemeral runners, other package managers, and ambiguous installations receive guidance without installation changes.
- R3. Target the public npm package's latest stable release. Never downgrade, select a prerelease, or claim success until the selected version is installed and its entrypoint passes a fresh-process smoke check.
- R4. Support `--json` for both update and check modes. Return structured execution failures with exit code 1, parser failures with exit code 2, and successful checks or updates with exit code 0; discovering an available update is not a failure.

**Passive notices**

- R5. Successful ordinary CLI commands may show a short update reminder on interactive stderr, including when the command uses `--json`. Do not change their JSON stdout, exit code, or structured warnings.
- R6. Passive checking is cached, bounded, and best-effort. Skip it for CI, non-interactive stderr, help, usage failures, failed commands, and the explicit update command; provide an environment opt-out.

**Isolation**

- R7. Update only the CLI package and its npm-managed dependencies. Do not refresh catalog sources, installed skills, copied operator skills, agent homes, receipts, or repository files.
- R8. Never install automatically or escalate privileges. Distinguish check failure, unsupported installation, installation failure, and post-install verification failure, with safe recovery guidance.

### Approved Decisions

- **Explicit updates, not automatic upgrades.** Governs R1 and R8. (session-settled: user-approved - chosen over automatic installation: the user chooses when the CLI changes.)
- **npm-installed CLI only.** Governs R2 and R7. (session-settled: user-approved - chosen over editing source checkouts or refreshing skills: installation ownership and scope stay clear.)
- **Separate terminal reminders.** Governs R5. (session-settled: user-approved - chosen over mixing notices with command data: scripts and agents must continue to work.)

### Proposed Command Surface

These are planned command components, not runnable examples of the current release.
The executable is `skill-suitcase`; public command examples must be added only with the implementation.

| Subcommand | Flags | Behavior |
| --- | --- | --- |
| `update` | none | Check and install when supported and newer; readable summary on stderr |
| `update` | `--check` | Fresh availability check; no installation or cache writes |
| `update` | `--json` | Check and install; one structured JSON result on stdout |
| `update` | `--check --json` | Fresh availability and support report; one JSON result |
| `update` | `--help` | Local help only; no network, cache, or installation activity |

Do not add aliases, positional versions, `--force`, `--yes`, `--beta`, or a second dry-run spelling.
Other commands retain their existing flag requirements.

### Acceptance Examples

- AE1. Given an eligible npm installation and a newer stable release, an explicit update installs the selected version and reports success only after verification. Covers R1–R4 and R8.
- AE2. Given a source checkout or an npm link, explicit update returns an unsupported-installation failure with guidance and does not invoke installation. Check-only may still report release availability successfully, with self-update support marked false. Covers R2 and R4.
- AE3. Given a successful JSON command in a terminal and a newer cached release, stdout is byte-for-byte unchanged and the reminder appears only on stderr. Non-interactive stderr suppresses passive checking; piping stdout alone does not. Covers R5 and R6.
- AE4. Given offline networking or an unwritable cache, an ordinary command behaves normally. Explicit check reports network failure rather than saying the CLI is up to date. Covers R4, R6, and R8.
- AE5. Given an installed version equal to or newer than the registry version, an eligible update succeeds without reinstalling. Covers R3 and R4.

### Scope Boundaries

R7 excludes operator-skill copies even though the updated npm package contains its own bundled skill directory.
No binary download/replacement, daemon, detached background worker, custom registry switch, catalog manifest setting, updater rollback engine, or generalized package-manager support is included.
No existing catalog command is converted to human-readable output.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Use npm as the installer, not GitHub release assets.** Implements R2 and R3. Fetch metadata from `https://registry.npmjs.org/skill-suitcase/latest`, then install the exact validated version rather than resolving `latest` a second time. Use the same public registry explicitly for installation. Artshelf establishes this package-manager delegation pattern; no-mistakes' binary replacement is not applicable.
- KTD2. **Use standard SemVer comparison and engine validation.** Implements R3. Add `semver` and its TypeScript declarations rather than copying artshelf's permissive comparator. Validate package name and exact version, reject prerelease targets and malformed metadata, ignore build metadata for precedence, and check the selected release's `engines.node` against the running Node version before installation. An invalid current version is an explicit failure and suppresses passive notices.
- KTD3. **Prove ownership before mutation.** Implements R2 and R8. Resolve the running package root from module location, never the working directory. Resolve a known npm CLI entrypoint and query its global prefix and root using the same Node runtime and environment that will install. Require the package to occupy that global root's `skill-suitcase` slot as a real directory, not a package-level link; canonical paths must match the running package. Reject detectable source checkouts. Missing npm, incompatible prefixes, or uncertain ownership fail closed. Do not infer ownership merely from a path containing `node_modules`.
- KTD4. **Keep subprocess execution narrow and verify afterward.** Implements R3 and R8. Invoke the resolved npm JavaScript entrypoint through the current Node executable with an argument array and no shell. Pass explicit `--global`, the verified prefix, exact package version, public registry, `--ignore-scripts`, `--no-audit`, and `--no-fund`. Recheck ownership immediately before spawning. After npm succeeds, reread installed metadata without module-cache reuse. Require its version to equal the selected version and its declared entrypoint to remain inside the verified package. Verify that the global executable link/shim in the verified prefix targets that entrypoint, then launch help through that executable in a fresh process. Directly launching the package's JavaScript file alone is not sufficient. If npm configuration prevents creation of a working launcher, report verification failure rather than an updated-success result.
- KTD5. **Keep presentation at the existing boundary.** Implements R1, R4, and R5. Add a human-output variant for explicit update results to the dispatch contract; render its summary on stderr and emit no stdout. JSON mode uses the existing `renderJson` path. Passive notices use separate optional presentation metadata, not additional fields in ordinary command results. The registry coordinates checking after successful execution; `cli.ts` passes terminal eligibility and writes renderer output. Do not move policy or network calls into `cli.ts`.
- KTD6. **Prefer a small in-process cache to a worker.** Implements R6. Use one cache file under absolute `XDG_CACHE_HOME`, otherwise `os.homedir()/.cache`, in a `skill-suitcase` directory. Cache successful metadata for 24 hours and failed attempts for one hour. Key entries to current version and registry; reject malformed values and future timestamps. A stale entry triggers a fresh check; failure produces no notice. Bound the passive request and body read to 750 ms, explicit metadata checks to 5 seconds, and metadata bodies to 256 KiB. Reject redirects for metadata requests. Cache IO failures are swallowed, writes use a temporary sibling and rename, and existing symlink cache files are ignored. No cache data is executable or sufficient authority to install.
- KTD7. **Keep opt-out and check-only behavior precise.** Implements R1 and R6. `SKILL_SUITCASE_NO_UPDATE_CHECK=1` suppresses passive network, cache IO, and notices, but not an explicitly requested update/check. Treat a non-empty `CI` value other than `0` or `false` as CI. Passive eligibility depends on stderr being a TTY, not on absence of `--json`. Explicit checks always bypass the passive cache; `--check` never writes it. A successful installation removes the old cache best-effort.

### Structured Result Contract

The update core returns a stable object with `ok`, `action` (`check` or `update`), `status`, `currentVersion`, `latestVersion`, `installedVersion`, `updateAvailable`, `installation`, and `error`.
Use null for unavailable values, including `updateAvailable` when lookup failed.
`installation` contains `kind` (`npm-global` or `unsupported`), `canSelfUpdate`, a stable reason code or null, and portable guidance.
`error` is null or a stable code with a concise message.
Do not include timestamps, random paths, raw npm logs, environment values, registry response bodies, or credentials.
Deterministic output means stable serialization for the same observed state; an explicit upstream query can naturally return different versions over time.

Statuses are `update-available`, `up-to-date`, `ahead`, `updated`, `unsupported-installation`, and `failed`.
`updated` is reserved for verified success.
Check-only returns `ok: true` on a successful lookup even if installation is unsupported.
Actual update refuses unsupported installation before any network request and returns `ok: false` regardless of whether a release would be newer.
Failed install or verification returns `status: failed` with distinct error codes; `installedVersion` is populated only when observed on disk.

### Implementation Boundaries

Use `src/commands/update.ts` for command acceptance and input validation, and `src/core/cli-update/index.ts` for version, support, install, and notification policy.
Use focused IO in new `src/adapters/cli-update.ts`, defaults in new `src/config/cli-update.ts`, and text formatting in new `src/renderers/update.ts`.
Keep these responsibilities cohesive; split a module only if its size or tests demonstrate a need.
Narrow injected dependencies for clock, HTTP, filesystem, and process calls allow deterministic tests without test-only production environment overrides.
Read the running package's metadata through the IO adapter using a module-relative URL and `fileURLToPath`; verify both source and packed layouts.
`ARCHITECTURE.md` remains authoritative: core may call adapters, commands may not call adapters directly, renderers perform no IO, and the entrypoint stays within its existing size limit.

### Risks and Failure Boundaries

- npm installation is not a Suitcase transaction. Failure or interruption can leave a partially changed package; do not promise automatic rollback. Report that possibility and provide a manual npm reinstall instruction for the verified target, without suggesting sudo.
- A compromised published package is still a supply-chain risk. Rely on npm's package integrity handling, skip lifecycle scripts, and do not add a separate trust or checksum system. The fresh-process smoke executes the newly installed CLI under the user's explicit update authorization.
- Resolve npm wrappers conservatively. Unix symlinks and standard Windows npm layouts need fixtures; unfamiliar wrappers must receive unsupported guidance rather than falling back to shell execution.
- Capture bounded npm output for error classification, not verbatim display. Bound discovery/smoke calls to 5 seconds and installation to 5 minutes; timeout is a failure with potentially partial installation. Keep all modules needed after replacement loaded before spawning npm.
- Updating while another invocation is using the package may interfere with that invocation. Document that users should finish other CLI work first; do not add daemon coordination or claim concurrent-install safety.

---

## Implementation Units

### U1. Release metadata and installation ownership

- **Goal:** Determine release availability and whether the running package can be updated. Covers R2, R3, R6, and R8; implements KTD1–KTD3 and metadata limits in KTD6.
- **Files:** New `src/core/cli-update/index.ts`, `src/adapters/cli-update.ts`, `src/config/cli-update.ts`, `tests/cli-update.test.ts`, and `tests/cli-update-adapter.test.ts`; dependency changes in `package.json` and `pnpm-lock.yaml`.
- **Approach:** Build the shared check policy with injected IO. Use npm-reported roots instead of hardcoded Unix prefixes. Complete ownership classification independently from release lookup so unsupported check-only remains useful.
- **Test scenarios:** Numeric version ordering; prerelease current versus stable target; equal/build-metadata versions; ahead versions; invalid current/remote versions; wrong package name; malformed or oversized responses; redirect, timeout, and HTTP failure; compatible/incompatible Node engines; installed package versus caller cwd; valid global directory; global npm link; local/ephemeral package; mismatched Node/npm prefix; missing npm; paths containing spaces; Unix and Windows layout fixtures.
- **Verification:** Focused core/adapter tests prove no install calls occur during discovery. Packed metadata lookup is covered again by U4.

### U2. Explicit update command and verified installation

- **Goal:** Deliver explicit update and read-only check behavior. Covers R1–R4, R7, and R8; implements KTD4 and the explicit-output part of KTD5.
- **Dependencies:** U1.
- **Files:** New `src/commands/update.ts` and `src/renderers/update.ts`; extend U1 core/adapter files, `src/commands/index.ts`, `src/commands/types.ts`, `src/cli.ts`, `src/renderers/usage.ts`, `tests/commands.test.ts`, `tests/help.test.ts`, `tests/renderers.test.ts`, `tests/cli.test.ts`, and U1 test files.
- **Approach:** Accept only the proposed command surface. Keep ordinary commands' JSON requirements unchanged. Update the help wording so `--json` is optional only for update. Capture child output and return typed results; never inherit child stdout into JSON mode.
- **Test scenarios:** Bare update/check; JSON equivalents; both help forms; unknown positional/flag and catalog-flag rejection; unsupported update versus successful unsupported check; up-to-date/ahead no-op; explicit global mode and exact version/prefix/registry arguments; shell disabled; engine failure before install; install spawn failure/nonzero/timeout; npm success with wrong installed version; missing/broken entrypoint or global launcher; verification success; no post-install lazy import; source, catalog, copied skill, and unrelated prefix unchanged.
- **Verification:** Subprocess tests assert stdout, stderr, and exit code separately. Verify parser and help behavior with network/install sentinels.

### U3. Passive terminal reminders

- **Goal:** Add reminders without changing ordinary command behavior. Covers R5 and R6; implements passive presentation in KTD5 and KTD6–KTD7.
- **Dependencies:** U1 and U2's dispatch/rendering contract.
- **Files:** Extend the update core, adapter, config, renderer, command dispatch, and entrypoint files above; add `tests/update-notice.test.ts`; extend `tests/cli.test.ts` and `tests/renderers.test.ts`.
- **Approach:** Make eligibility explicit at the process boundary, then request an optional notice only after a successful ordinary result. Notification exceptions are contained separately from command execution. Show portable update guidance; source/development launches should point to installation guidance rather than imply their checkout will self-update.
- **Test scenarios:** Interactive JSON result unchanged with newer release; cached repeat without fetch; expired cache; current version invalidates cache; failure backoff; corrupt/future/symlink cache; unwritable cache; offline timeout; no downgrade notice; CI, opt-out, help, failed result, parser failure, update command, and non-TTY all perform zero passive work; no extra exit delay from dangling fetch timers.
- **Verification:** Inject TTY/clock/cache/network dependencies and add a real PTY subprocess case where supported. Compare ordinary JSON bytes and exit codes with the feature enabled and disabled.

### U4. Packaged verification and user guidance

- **Goal:** Prove the updater at a disposable installation boundary and document its limits. Covers R1–R8.
- **Dependencies:** U1–U3.
- **Files:** Extend `scripts/package-smoke.mjs`; add `tests/cli-update-install.test.ts`; update `README.md`, `INSTALL.md`, `docs/getting-started.md`, `docs/command-reference.md`, `SPEC.md`, and `ARCHITECTURE.md` only where update behavior or the output exception belongs. Extend `tests/docs-guidance.test.ts` and `tests/public-docs-contract.test.ts` only as needed to assert the new shipped contract.
- **Approach:** Retain existing local-package smoke coverage. Add a disposable global prefix and controlled package/registry fixtures to exercise real npm replacement and a fresh-process launch, using injected test boundaries rather than a public arbitrary-registry flag. A temporary newer fixture package must be clearly identified as test data, not a published release. Keep HOME, npm cache, and prefix isolated from real user state.
- **Test scenarios:** Installed version metadata resolves outside repo cwd; first install to newer fixture updates the same prefix without creating prefix-level package/lock files; second update is a no-op; a different prefix remains untouched; lifecycle scripts do not run; inherited `bin-links=false` still produces a verified launcher for a changed declared entrypoint, and a hidden launcher fails verification with runnable recovery guidance; copied operator skill remains unchanged; package smoke works on Node 20 and 24; public examples parse under the shipped command registry; existing help remains concise.
- **Verification:** Execute the full Verification Contract. Run real npm integration on macOS and Linux; exercise standard Windows launching on Windows before claiming that path supported, otherwise conservatively return unsupported guidance and disclose the limit. Never claim an unexecuted platform test passed.

---

## Verification Contract

During implementation, use the repository's normal checks:

| Command | Evidence |
| --- | --- |
| `pnpm test` | Build and discover all regression tests, including disposable update integration |
| `pnpm run lint` | Type checking under existing strict settings |
| `pnpm run package:smoke` | Packed installation behavior on supported Node versions |
| `pnpm run architecture:check` | Import direction, renderer mediation, and thin entrypoint/commands |
| `git diff --check` | Whitespace correctness |

No `release:validate` script exists in the inspected manifest; do not invent one.
Before shipping, retain real transcripts of controlled before/after versions and stream/exit-code assertions without publishing private paths or raw npm logs.
Public documentation must not advertise an unshipped command.
Until implementation lands, this plan uses separate executable/subcommand descriptions instead of runnable future CLI examples so it does not violate the existing public-document contract.

---

## Definition of Done

- U1 passes version, engine, registry, timeout, and ownership tests.
- U2 updates a disposable eligible installation, verifies the result, and reports every failure class without false success.
- U3 preserves existing stdout and exit behavior while showing a real terminal reminder under the approved conditions.
- U4 proves packaged operation and records platform coverage; all normal gates pass.
- R7 is demonstrated by unchanged adjacent fixtures, not inferred from an installer success code.
- No live installation was changed, no credentials or raw logs entered artifacts, and no speculative or abandoned implementation remains.
- Docs and help describe CLI-versus-skill scope and partial-install recovery accurately.

---

## Appendix

### Evidence and References

Repository baseline: `5f3a26471004775120220bd2d8f72ab145040dbd`.

- `INSTALL.md:15–66`: global npm installation and separate source workflow.
- `src/commands/status.ts:6–9`: current ordinary command requires JSON.
- `src/commands/index.ts:156–193`: parser, help, execution, and exit mapping boundary.
- `src/cli.ts:7–25`: existing renderer-mediated stdout/stderr boundary.
- `src/renderers/usage.ts:124`: current JSON-required help text needs an update-specific exception.
- `ARCHITECTURE.md:599–739`: enforced layers, size limits, output rules, and verification.
- `scripts/package-smoke.mjs:26–67`: existing disposable local installation and clean-stderr assertion.
- `.github/workflows/ci.yml:60–85`: package smoke on Node 20 and 24.
- [Artshelf update command](https://github.com/calvinnwq/artshelf/blob/549870bd92fabc3121a10e3a75552a1bd458ed46/src/commands/update.ts): npm delegation and stderr notices. Do not copy unconditional global mutation, moving `latest` installation, or success based solely on npm exit.
- [Artshelf update adapter](https://github.com/calvinnwq/artshelf/blob/549870bd92fabc3121a10e3a75552a1bd458ed46/src/adapters/update.ts): bounded fetch, cache, injected IO. Do not copy permissive version parsing.
- [No-mistakes updater](https://github.com/calvinnwq/no-mistakes/blob/0a2c82f993b9467c5ab84992313dfd13b66830af/internal/update/update.go): cached notices, development safeguards, explicit update. Binary and daemon handling are outside this package's requirements.
- [npm root](https://docs.npmjs.com/cli/v11/commands/npm-root) and [npm folders](https://docs.npmjs.com/cli/v11/configuring-npm/folders): global roots, prefixes, and platform layouts.
- [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install): exact package specifications, global installation, and install configuration.
