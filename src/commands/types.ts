import type { CliExitCode } from "../renderers/exit-codes.js";
import type { apply } from "../core/apply/index.js";
import type { diff } from "../core/diffing/index.js";
import type { inspectImportSource } from "../core/importing/index.js";
import type { pack } from "../core/packing/index.js";
import type { plan } from "../core/planning/index.js";
import type { importTarget } from "../core/import-target/index.js";
import type { executePromote, planPromote } from "../core/promote/index.js";
import type { reconcile } from "../core/reconcile/index.js";
import type { repair } from "../core/repair/index.js";
import type { rollback } from "../core/rollback/index.js";
import type { status } from "../core/status/index.js";
import type { targets } from "../core/catalog/targets.js";
import type { track } from "../core/track/index.js";
import type { checkUpstream, fetchUpstreamSkillDryRun, importUpstreamSkill } from "../core/upstream/index.js";
import type { validate } from "../core/validation/index.js";

export type CommandName =
  | "plan"
  | "diff"
  | "pack"
  | "import"
  | "validate"
  | "targets"
  | "status"
  | "apply"
  | "rollback"
  | "track"
  | "reconcile"
  | "repair"
  | "promote"
  | "import-target"
  | "upstream";

export type ParsedCommandArgs = {
  command: CommandName | "help";
  dryRun: boolean;
  json: boolean;
  strict?: boolean;
  apply?: boolean;
  upstreamAction?: "check" | "fetch" | "import";
  source?: string;
  target?: string;
  targetSkill?: string;
  output?: string;
  lock?: string;
  artifact?: string;
  mode?: string;
  receipt?: string;
  codexHome?: string;
  codexSkills?: string;
  claudeSkills?: string;
  skill?: string[];
};

export type ValueFlagName =
  | "source"
  | "target"
  | "targetSkill"
  | "output"
  | "lock"
  | "artifact"
  | "mode"
  | "receipt"
  | "codexHome"
  | "codexSkills"
  | "claudeSkills";

export type CommandJsonResult =
  | Awaited<ReturnType<typeof plan>>
  | Awaited<ReturnType<typeof diff>>
  | Awaited<ReturnType<typeof pack>>
  | Awaited<ReturnType<typeof inspectImportSource>>
  | Awaited<ReturnType<typeof validate>>
  | Awaited<ReturnType<typeof targets>>
  | Awaited<ReturnType<typeof status>>
  | Awaited<ReturnType<typeof apply>>
  | Awaited<ReturnType<typeof rollback>>
  | Awaited<ReturnType<typeof track>>
  | Awaited<ReturnType<typeof reconcile>>
  | Awaited<ReturnType<typeof repair>>
  | Awaited<ReturnType<typeof planPromote>>
  | Awaited<ReturnType<typeof executePromote>>
  | Awaited<ReturnType<typeof importTarget>>
  | Awaited<ReturnType<typeof checkUpstream>>
  | Awaited<ReturnType<typeof fetchUpstreamSkillDryRun>>
  | Awaited<ReturnType<typeof importUpstreamSkill>>;

export type CommandModule = {
  name: CommandName;
  accepts(args: ParsedCommandArgs): boolean;
  run(args: ParsedCommandArgs): Promise<CommandJsonResult>;
};

export type DispatchResult =
  | {
    type: "result";
    result: CommandJsonResult;
    exitCode: CliExitCode;
  }
  | {
    type: "usage";
    message: string | null;
    usage: string;
    exitCode: CliExitCode;
  };
