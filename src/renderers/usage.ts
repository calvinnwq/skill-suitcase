export function usageText(): string {
  return [
    "Usage:",
    "  suitcase plan --source <skills-repo> --target <target> --json",
    "  suitcase diff --source <skills-repo> --target <target> --json",
    "  suitcase pack --source <skills-repo> --target <target> --dry-run --json",
    "  suitcase pack --source <skills-repo> --target <target> --output <dir> --json",
    "  suitcase import --source <skills-repo> --json",
    "  suitcase validate --source <skills-repo> --json",
    "  suitcase validate --source <skills-repo> --strict --json",
    "  suitcase targets --source <skills-repo> --json",
    "  suitcase status --source <skills-repo> --json",
    "  suitcase status --source <skills-repo> --target <target> --json",
    "  suitcase apply --source <skills-repo> --target <target> --lock <path> --json",
    "  suitcase apply --source <skills-repo> --target <target> --artifact <path> --json",
    "  suitcase apply --source <skills-repo> --target <target> --lock <path> --mode symlink --json",
    "  suitcase rollback --receipt <path> --json",
    "  suitcase track --source <skills-repo> --target <target> [--skill <name> ...] --json",
    "  suitcase promote --source <skills-repo> --target-skill <dir> --dry-run --json",
    "",
    "Promote (read-only dry-run plan for a target-created skill):",
    "  --target-skill <dir>   Path to the agent-home skill directory to promote",
    "",
    "Target path overrides:",
    "  --codex-home <dir>     Override codex codexHome; skillsPath defaults to <dir>/skills",
    "  --codex-skills <dir>   Override codex skillsPath",
    "  --claude-skills <dir>  Override claude path"
  ].join("\n");
}
