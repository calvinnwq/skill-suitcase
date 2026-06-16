import { applyCommand } from "./apply.js";
import { diffCommand } from "./diff.js";
import { importCommand } from "./import.js";
import { packCommand } from "./pack.js";
import { planCommand } from "./plan.js";
import { rollbackCommand } from "./rollback.js";
import { statusCommand } from "./status.js";
import { targetsCommand } from "./targets.js";
import { trackCommand } from "./track.js";
import { validateCommand } from "./validate.js";
import { exitCodeForCommandResult, EXIT_CODE_USAGE } from "../renderers/exit-codes.js";
import { usageText } from "../renderers/usage.js";
import type { CommandModule, CommandName, DispatchResult, ParsedCommandArgs, ValueFlagName } from "./types.js";

const DEFAULT_COMMANDS: CommandModule[] = [
  planCommand,
  diffCommand,
  packCommand,
  importCommand,
  validateCommand,
  targetsCommand,
  statusCommand,
  applyCommand,
  rollbackCommand,
  trackCommand
];

const KNOWN_COMMAND_NAMES: ReadonlySet<string> = new Set(
  DEFAULT_COMMANDS.map((command) => command.name)
);

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
      if (!isFlagAllowedForCommand(args.command, token)) {
        throw new Error(`Unknown argument: ${token}`);
      }
      args.dryRun = true;
      continue;
    }

    if (token === "--strict") {
      if (!isFlagAllowedForCommand(args.command, token)) {
        throw new Error(`Unknown argument: ${token}`);
      }
      args.strict = true;
      continue;
    }

    if (token === "--skill") {
      if (args.command !== "track") {
        throw new Error(`Unknown argument: ${token}`);
      }
      const value = rest[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error(`${token} requires a value`);
      }
      if (value.trim().length === 0) {
        throw new Error(`${token} requires a non-blank value`);
      }
      args.skill = [...(args.skill ?? []), value];
      index += 1;
      continue;
    }

    if (isValueArg(token)) {
      if (!isFlagAllowedForCommand(args.command, token)) {
        throw new Error(`Unknown argument: ${token}`);
      }
      const value = rest[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error(`${token} requires a value`);
      }
      const key = valueFlagName(token);
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
      exitCode: EXIT_CODE_USAGE
    };
  }

  const command = createCommandRegistry().find(args);
  if (command === null) {
    return {
      type: "usage",
      message: null,
      usage: usageText(),
      exitCode: EXIT_CODE_USAGE
    };
  }

  const result = await command.run(args);
  return {
    type: "result",
    result,
    exitCode: exitCodeForCommandResult(result)
  };
}

function isKnownCommand(command: string): command is CommandName {
  return KNOWN_COMMAND_NAMES.has(command);
}

function isValueArg(token: string): boolean {
  return token === "--source" || token === "--target" || token === "--output" || token === "--lock"
    || token === "--artifact" || token === "--mode" || token === "--receipt" || token === "--codex-home"
    || token === "--codex-skills" || token === "--claude-skills";
}

function valueFlagName(token: string): ValueFlagName {
  switch (token) {
    case "--codex-home":
      return "codexHome";
    case "--codex-skills":
      return "codexSkills";
    case "--claude-skills":
      return "claudeSkills";
    default:
      return token.slice(2) as ValueFlagName;
  }
}

function isFlagAllowedForCommand(command: CommandName | "help", token: string): boolean {
  if (command === "help") {
    return true;
  }

  switch (token) {
    case "--source":
      return command === "plan" || command === "diff" || command === "pack" || command === "import"
        || command === "validate" || command === "targets" || command === "status" || command === "apply"
        || command === "track";
    case "--target":
      return command === "plan" || command === "diff" || command === "pack" || command === "apply"
        || command === "track" || command === "status";
    case "--output":
      return command === "pack";
    case "--lock":
    case "--artifact":
    case "--mode":
      return command === "apply";
    case "--receipt":
      return command === "rollback";
    case "--codex-home":
    case "--codex-skills":
    case "--claude-skills":
      return command === "diff" || command === "pack" || command === "targets" || command === "status"
        || command === "apply" || command === "track";
    case "--dry-run":
      return command === "pack";
    case "--strict":
      return command === "validate";
    default:
      return false;
  }
}
