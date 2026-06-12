# Skill Suitcase CLI Architecture

This is the source of truth for how Skill Suitcase's TypeScript CLI should be
structured as it grows. It applies the shared TypeScript CLI refactor pattern
from Linear `NGX-420` to this repo.

## End State

Skill Suitcase should converge on this shape:

```txt
src/
  cli.ts
  commands/
    index.ts
    plan.ts
    diff.ts
    pack.ts
    validate.ts
    targets.ts
    status.ts
    apply.ts
    rollback.ts
    track.ts
  core/
    planning/
    diffing/
    packing/
    apply/
    rollback/
    track/
    receipts/
    status/
    catalog/
    validation/
  adapters/
    filesystem.ts
  renderers/
    json.ts
    errors.ts
    usage.ts
    exit-codes.ts
  config/
    defaults.ts
```

This tree is the current target shape after the architecture refactor. Keep future
changes moving one command or feature boundary at a time.

## Responsibilities

`src/cli.ts` is the process entrypoint. It may:

- call the command registry
- pass `process.argv` into the parser/registry boundary
- map top-level failures to `process.exitCode`
- perform final stdout/stderr writes through renderer helpers

It should not own command behavior, domain rules, persistence details, or large
switch statements.

`src/commands/` owns user-visible commands. A command module should:

- define the command's args, flags, aliases, and help metadata
- validate and normalize user input
- build a command input object
- call a domain/core function
- render the result through a renderer
- map known command errors to exit codes

Command modules should stay thin. They adapt the outside world to core code.

`src/core/` owns durable behavior:

- planning and lock semantics
- packing and artifact construction
- apply/install workflows
- receipt creation and validation
- catalog, manifest, target, and validation rules

Core modules must not depend on command modules, help text, stdout/stderr, or
`process.argv`.

`src/adapters/` owns infrastructure boundaries:

- filesystem reads/writes
- target installation locations
- package/archive IO
- future network or external process calls

Adapters should expose narrow functions that core code can call without knowing
about CLI parsing or rendering.

`src/renderers/` owns output:

- JSON formatting
- usage/help text
- known error rendering
- stdout/stderr discipline

Skill Suitcase is JSON-first. JSON stdout is a contract. Human usage text,
warnings, and errors belong on stderr unless an issue explicitly changes that
contract.

`src/config/` owns defaults:

- default paths
- environment-driven behavior
- package metadata
- runtime constants that are not domain rules

`src/shared/` is only for truly shared types and small helpers. Do not turn it
into a junk drawer.

## Import Direction

Default dependency direction:

```txt
cli.ts -> commands -> core/domain -> adapters/interfaces/shared
commands -> renderers
```

Rules:

- Core/domain modules must not import `commands/`.
- Core/domain modules must not import `renderers/`.
- Adapter modules must not import command modules.
- `process.argv` should stay at the CLI boundary.
- `process.stdout` and `process.stderr` should stay in `cli.ts` or renderers.
- New command behavior should not be added directly to `src/cli.ts`.

## Migration Path

Skill Suitcase has completed the initial migration: `src/cli.ts` is a thin
entrypoint and the `commands/`, `core/`, `adapters/`, `renderers/`, and `config/`
boundaries now exist. The original domain-shaped files in `src/` remain as
re-export shims over `src/core/`.

The migration followed this order, which also describes how to land future
boundary moves:

1. Add the command registry and move command-specific parsing/validation into
   `src/commands/`.
2. Extract JSON and error rendering into `src/renderers/`.
3. Move feature modules into `src/core/` only when a command or feature change
   already touches that area.
4. Add adapter modules when core behavior needs filesystem or target-install IO.
5. Add import-boundary checks once the folders exist.

Avoid moving every file at once. Each change should preserve behavior and leave
the repo shippable.

## Command Module Contract

Each command module should follow this pattern:

```ts
export function registerPlanCommand(registry: CommandRegistry): void {
  registry.command("plan", async (args, deps) => {
    const input = parsePlanArgs(args);
    const result = await plan(input, deps);
    return renderJsonResult(result);
  });
}
```

The exact API can change, but the separation should not:

- parse and validate at the command boundary
- execute durable behavior in core/domain code
- render through renderer helpers
- keep process IO out of domain code

## Output Contract

Existing JSON contracts must be preserved unless a specific issue says
otherwise.

For command results:

- success JSON should remain deterministic
- error JSON should use stable fields when introduced
- usage errors should exit with code `2`
- command execution failures should exit with code `1`
- successful commands should exit with code `0`

Do not print notices, usage text, or warnings to stdout when `--json` is used.

## Adding New CLI Features

When adding a new product feature:

1. Add or extend a command module under `src/commands/`.
2. Put business behavior in `src/core/<feature>/` or an existing domain module.
3. Put filesystem or target install IO behind an adapter.
4. Render JSON through `src/renderers/`.
5. Add command-boundary tests and core behavior tests.
6. Run `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm run architecture:check`,
   and `git diff --check`.

The blunt rule: do not fatten `src/cli.ts`.

## Definition Of Done

The architecture is working when:

- `src/cli.ts` is a thin entrypoint
- commands are discoverable by command name or family
- core/domain behavior is testable without CLI process IO
- JSON stdout remains stable
- `pnpm run architecture:check` prevents obvious boundary regressions
- new feature work naturally follows the same pattern
