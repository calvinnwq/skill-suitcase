import { applyCommand } from "./apply.js";
import { diffCommand } from "./diff.js";
import { packCommand } from "./pack.js";
import { planCommand } from "./plan.js";
import { statusCommand } from "./status.js";
import { targetsCommand } from "./targets.js";
import { validateCommand } from "./validate.js";
import type { CommandModule, CommandName, DispatchResult, ParsedCommandArgs, ValueFlagName } from "./types.js";

const DEFAULT_COMMANDS: CommandModule[] = [
  planCommand,
  diffCommand,
  packCommand,
  validateCommand,
  targetsCommand,
  statusCommand,
  applyCommand
];

export class CommandRegistry {
  readonly #commands: CommandModule[];

  constructor(commands: CommandModule[]) {
    this.#commands = [...commands];
  }

  names(): CommandName[] {
    return this.#commands.map((command) => command.name);
  }

  find(args: ParsedCommandArgs): CommandModule | null {
    return this.#commands.find((command) => command.accepts(args)) ?? null;
  }
}

export function createCommandRegistry(): CommandRegistry {
  return new CommandRegistry(DEFAULT_COMMANDS);
}

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

export function parseCommandArgs(argv: string[]): ParsedCommandArgs {
  const [command = "", ...rest] = argv;
  const args: ParsedCommandArgs = {
    command: isKnownCommand(command) ? command : "help",
    dryRun: false,
    json: false
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      break;
    }

    if (token === "--json") {
      args.json = true;
      continue;
    }

    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (isValueArg(token)) {
      const value = rest[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error(`${token} requires a value`);
      }
      const key = token.slice(2) as ValueFlagName;
      args[key] = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

export async function dispatchCommand(argv: string[]): Promise<DispatchResult> {
  let args: ParsedCommandArgs;
  try {
    args = parseCommandArgs(argv);
  } catch (error) {
    return {
      type: "usage",
      message: error instanceof Error ? error.message : "Failed to parse arguments.",
      usage: usageText(),
      exitCode: 2
    };
  }

  const command = createCommandRegistry().find(args);
  if (command === null) {
    return {
      type: "usage",
      message: null,
      usage: usageText(),
      exitCode: 2
    };
  }

  const result = await command.run(args);
  return {
    type: "result",
    result,
    exitCode: result.ok ? 0 : 1
  };
}

function isKnownCommand(command: string): command is CommandName {
  return command === "plan" || command === "diff" || command === "pack" || command === "validate"
    || command === "targets" || command === "status" || command === "apply";
}

function isValueArg(token: string): token is `--${ValueFlagName}` {
  return token === "--source" || token === "--target" || token === "--output" || token === "--lock"
    || token === "--artifact";
}
