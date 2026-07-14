export const HERMES_EXCLUDED_SKILL_DIRECTORIES = new Set([
  ".git",
  ".github",
  ".hub",
  ".archive",
  ".venv",
  "venv",
  "node_modules",
  "site-packages",
  "__pycache__",
  ".tox",
  ".nox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache"
]);

export const HERMES_SKILL_SUPPORT_DIRECTORIES = new Set(["references", "templates", "assets", "scripts"]);

const WINDOWS_RESERVED_CATEGORY_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function isHermesCategorySegment(value: string): boolean {
  const basename = value.split(".", 1)[0] ?? value;
  return value !== "."
    && value !== ".."
    && !value.endsWith(".")
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    && !WINDOWS_RESERVED_CATEGORY_BASENAME.test(basename)
    && !HERMES_EXCLUDED_SKILL_DIRECTORIES.has(value);
}
