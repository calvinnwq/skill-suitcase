---
name: hello-suitcase
description: >-
  A harmless sample skill for portable Skill Suitcase demos and tests. Use when
  the user asks to see the sample greeting or verify a disposable Skill
  Suitcase installation.
---

# Hello Suitcase

## Contract

Use this fixture only to exercise catalog planning and installation in
disposable directories.
Trigger on requests such as "show the sample greeting" or "verify the
disposable Skill Suitcase install."
Read `references/greeting.md` and return its greeting without adding private or
machine-specific information.

Use `scripts/render_greeting.py` for deterministic routing and greeting output
inside disposable fixture tests.
Keep the agent-facing trigger language synchronized with
`references/routing.json`, which is the deterministic routing source of truth.
LLM evals are not applicable because the fixture does not call a model or use a
prompt template.
Filing rules are not applicable because the fixture does not create notes,
memory, wiki, vault, or other durable output.

The catalog test runs the workspace reachability and DRY audit, confirms the
check_resolvable_local support fixture matches `references/routing.json`, and
executes the runner end to end.

## Phases

1. Match the request through the trigger phrases above.
2. Read `references/greeting.md`.
3. Return the greeting exactly as plain text.

## Output Format

Return only the greeting from `references/greeting.md` as plain text.
