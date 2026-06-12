import type { CliExitCode } from "../renderers/exit-codes.js";
import type { apply } from "../apply.js";
import type { diff } from "../diff.js";
import type { pack } from "../packer.js";
import type { plan } from "../planner.js";
import type { status } from "../status.js";
import type { targets } from "../targets.js";
import type { validate } from "../validator.js";

export type CommandName = "plan" | "diff" | "pack" | "validate" | "targets" | "status" | "apply";

export type ParsedCommandArgs = {
  command: CommandName | "help";
  dryRun: boolean;
  json: boolean;
  source?: string;
  target?: string;
  output?: string;
  lock?: string;
  artifact?: string;
};

export type ValueFlagName = "source" | "target" | "output" | "lock" | "artifact";

export type CommandJsonResult =
  | Awaited<ReturnType<typeof plan>>
  | Awaited<ReturnType<typeof diff>>
  | Awaited<ReturnType<typeof pack>>
  | Awaited<ReturnType<typeof validate>>
  | Awaited<ReturnType<typeof targets>>
  | Awaited<ReturnType<typeof status>>
  | Awaited<ReturnType<typeof apply>>;

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
