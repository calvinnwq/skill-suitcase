export function usageText(): string {
  return [
    "Usage:",
    "  suitcase plan --source <skills-repo> --target <target> --json",
    "  suitcase diff --source <skills-repo> --target <target> --json",
    "  suitcase pack --source <skills-repo> --target <target> --dry-run --json",
    "  suitcase pack --source <skills-repo> --target <target> --output <dir> --json",
    "  suitcase validate --source <skills-repo> --json",
    "  suitcase targets --source <skills-repo> --json",
    "  suitcase status --source <skills-repo> --json",
    "  suitcase apply --source <skills-repo> --target <target> --lock <path> --json",
    "  suitcase apply --source <skills-repo> --target <target> --artifact <path> --json"
  ].join("\n");
}
