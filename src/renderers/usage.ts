type HelpEntry = {
  description: string;
  flags: (keyof typeof FLAGS)[];
  notes?: string[];
  targetOverrides?: boolean;
};

const COMMAND_HELP: Record<string, HelpEntry> = {
  plan: {
    description: "Preview the skills assigned to a target",
    flags: ["source", "target"]
  },
  diff: {
    description: "Compare catalog skills with installed targets",
    flags: ["source", "target"], targetOverrides: true
  },
  pack: {
    description: "Build an install artifact or preview its contents",
    flags: ["source", "target", "dry-run", "output"], targetOverrides: true,
    notes: ["Use --dry-run to preview, or --output to build outside catalog and target roots."]
  },
  import: {
    description: "Inspect a source repository for catalog onboarding",
    flags: ["source"]
  },
  validate: {
    description: "Check catalog structure and skill contracts",
    flags: ["source", "strict"]
  },
  targets: {
    description: "List targets and their resolved paths",
    flags: ["source"], targetOverrides: true
  },
  status: {
    description: "Show installed skill health and drift",
    flags: ["source", "target"], targetOverrides: true,
    notes: ["Omit --target to report all targets."]
  },
  apply: {
    description: "Install skills from an approved lock or artifact",
    flags: ["source", "target", "lock", "artifact", "mode"], targetOverrides: true,
    notes: ["Requires exactly one of --lock or --artifact.",
      "Re-pack before artifact apply; approve target paths and install mode separately."]
  },
  rollback: {
    description: "Reverse prior installs or repairs using a receipt",
    flags: ["receipt", "source", "target"], targetOverrides: true,
    notes: ["Pass --source and --target together; required for external projections",
      "and when removing an apply-created symlink. Promotions are not restored."]
  },
  track: {
    description: "Record ownership of installs matching the catalog",
    flags: ["source", "target", "skill"], targetOverrides: true,
    notes: ["--skill is optional and repeatable. Writes receipts only, not skill files."]
  },
  reconcile: {
    description: "Replace differing, unreceipted installs from the catalog",
    flags: ["source", "target", "skill", "dry-run", "apply"], targetOverrides: true,
    notes: ["Requires --skill (repeatable) and exactly one of --dry-run or --apply.",
      "Backs up the existing target; use track for exact matches or apply for missing skills."]
  },
  repair: {
    description: "Restore selected dirty, managed copies from the catalog",
    flags: ["source", "target", "skill", "dry-run", "apply"], targetOverrides: true,
    notes: ["Requires --skill (repeatable) and exactly one of --dry-run or --apply.",
      "Backs up local edits before replacement. Copy-mode installs only."]
  },
  prune: {
    description: "Remove selected managed installs no longer assigned",
    flags: ["source", "target", "skill", "dry-run", "apply", "plan-id"], targetOverrides: true,
    notes: ["Requires --skill (repeatable) and exactly one of --dry-run or --apply.",
      "--apply requires the exact reviewed --plan-id; state drift invalidates it."]
  },
  promote: {
    description: "Bring a target-created skill into the catalog",
    flags: ["source", "target-skill", "dry-run", "apply"],
    notes: ["Requires --target-skill and exactly one of --dry-run or --apply.",
      "Copies and verifies source, backs up the target, then symlinks it to the catalog."]
  },
  "import-target": {
    description: "Keep intentional target edits by importing to the catalog",
    flags: ["source", "target", "skill", "dry-run", "apply"], targetOverrides: true,
    notes: ["Requires --skill (repeatable) and exactly one of --dry-run or --apply.",
      "Copy-mode installs only; leaves catalog changes for Git review."]
  },
  upstream: {
    description: "Refresh catalog source from pinned upstream providers",
    flags: []
  }
};

const UPSTREAM_HELP: Record<string, HelpEntry> = {
  check: {
    description: "Report upstream declarations, lineage, and catalog hash drift",
    flags: ["source"]
  },
  fetch: {
    description: "Fetch in an isolated workspace and preview catalog changes",
    flags: ["source", "skill", "dry-run"],
    notes: ["Requires exactly one --skill and --dry-run; does not change the catalog."]
  },
  import: {
    description: "Import fetched source into the catalog for review",
    flags: ["source", "skill", "apply"],
    notes: ["Requires exactly one --skill and --apply; refuses dirty selected source.",
      "Updates catalog source and upstream lock only; no target sync or commit."]
  }
};

const FLAGS = {
  source: ["--source <repo>", "Catalog source repository"],
  target: ["--target <target>", "Catalog target to inspect or update"],
  skill: ["--skill <name>", "Select a skill by name"],
  "target-skill": ["--target-skill <dir>", "Target-created skill directory"],
  "dry-run": ["--dry-run", "Preview without changing catalog or targets"],
  apply: ["--apply", "Approve and perform the mutation"],
  output: ["--output <dir>", "Artifact output directory"],
  strict: ["--strict", "Also validate strict skill authoring contracts"],
  lock: ["--lock <path>", "Approved plan lock (created through the library API)"],
  artifact: ["--artifact <path>", "Approved packed artifact"],
  mode: ["--mode <mode>", "Install mode: copy (default) or symlink"],
  receipt: ["--receipt <path>", "Receipt containing rollback state (required)"],
  "plan-id": ["--plan-id <id>", "Reviewed prune dry-run plan ID"],
  json: ["--json", "Write deterministic JSON results (required to run)"],
  help: ["-h, --help", "Show help for this command"]
} satisfies Record<string, [string, string]>;

const TARGET_OVERRIDES: [string, string][] = [
  ["--codex-home <dir>", "Codex home; skills default to <dir>/skills"],
  ["--codex-skills <dir>", "Codex skills path"],
  ["--claude-skills <dir>", "Claude skills path"],
  ["--hermes-skills <dir>", "Hermes skills path"],
  ["--agents-skills <dir>", "Shared agents skills path"],
  ["--grok-skills <dir>", "Grok skills path"]
];

function rows(entries: [string, string][]): string[] {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, description]) => `  ${label.padEnd(width)}  ${description}`);
}

export function usageText(command?: string, action?: string): string {
  const entry = command !== undefined && Object.hasOwn(COMMAND_HELP, command)
    ? COMMAND_HELP[command] : undefined;
  if (entry === undefined) {
    return [
      "Manage portable agent skills from a versioned catalog.", "",
      "Usage:", "  skill-suitcase <command> [flags]", "",
      "Available Commands:",
      ...rows(Object.entries(COMMAND_HELP).map(([name, help]): [string, string] => [name, help.description])
        .concat([["help", "Show help for a command"]]).sort(([a], [b]) => a.localeCompare(b))),
      "", "Flags:", ...rows([FLAGS.help, FLAGS.json]), "",
      'Use "skill-suitcase <command> --help" for more information about a command.'
    ].join("\n");
  }
  const upstream = command === "upstream";
  const actionHelp = upstream && action !== undefined && Object.hasOwn(UPSTREAM_HELP, action)
    ? UPSTREAM_HELP[action] : undefined;
  const help = actionHelp ?? entry;
  const path = actionHelp === undefined ? command : `${command} ${action}`;
  const lines = [help.description, "", "Usage:",
    `  skill-suitcase ${path}${upstream && actionHelp === undefined ? " <command>" : ""} [flags]`];
  if (upstream && actionHelp === undefined) {
    lines.push("", "Available Commands:",
      ...rows(Object.entries(UPSTREAM_HELP).map(([name, item]) => [name, item.description])));
  }
  lines.push("", "Flags:", ...rows([...help.flags.map((flag) => FLAGS[flag]), FLAGS.json, FLAGS.help]));
  if (help.targetOverrides) lines.push("", "Target path overrides:", ...rows(TARGET_OVERRIDES));
  if (help.flags.includes("source") && command !== "rollback") {
    lines.push("", `Requires --source${help.flags.includes("target") && command !== "status" ? " and --target" : ""}.`);
  }
  if (help.notes !== undefined) lines.push("", ...help.notes);
  if (upstream && actionHelp === undefined) {
    lines.push("", 'Use "skill-suitcase upstream <command> --help" for action details.');
  }
  return lines.join("\n");
}
