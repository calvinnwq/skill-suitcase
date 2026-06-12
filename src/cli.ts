#!/usr/bin/env node
type CliCommand = "plan" | "diff" | "pack" | "validate" | "targets" | "status" | "apply" | "help";

type CliParsedArgs = {
  command: CliCommand | null;
  dryRun: boolean;
  json: boolean;
  source?: string;
  target?: string;
  output?: string;
  lock?: string;
  artifact?: string;
};

type FlagName = "source" | "target" | "output" | "lock" | "artifact";

type CliCommandResult =
  | Awaited<ReturnType<typeof plan>>
  | Awaited<ReturnType<typeof pack>>
  | Awaited<ReturnType<typeof diff>>
  | Awaited<ReturnType<typeof validate>>
  | Awaited<ReturnType<typeof targets>>
  | Awaited<ReturnType<typeof status>>
  | Awaited<ReturnType<typeof apply>>;

type CommandFlags = {
  isPlan: boolean;
  isDiff: boolean;
  isPack: boolean;
  isTargets: boolean;
  isStatus: boolean;
  isApply: boolean;
};

import { apply } from "./apply.js";
import { diff } from "./diff.js";
import { pack } from "./packer.js";
import { plan } from "./planner.js";
import { status } from "./status.js";
import { targets } from "./targets.js";
import { validate } from "./validator.js";

function printUsage() {
  console.error("Usage:");
  console.error("  suitcase plan --source <skills-repo> --target <target> --json");
  console.error("  suitcase diff --source <skills-repo> --target <target> --json");
  console.error("  suitcase pack --source <skills-repo> --target <target> --dry-run --json");
  console.error("  suitcase pack --source <skills-repo> --target <target> --output <dir> --json");
  console.error("  suitcase validate --source <skills-repo> --json");
  console.error("  suitcase targets --source <skills-repo> --json");
  console.error("  suitcase status --source <skills-repo> --json");
  console.error("  suitcase apply --source <skills-repo> --target <target> --lock <path> --json");
  console.error("  suitcase apply --source <skills-repo> --target <target> --artifact <path> --json");
}

function parseArgs(argv: string[]): CliParsedArgs {
  const [command = "", ...rest] = argv;
  const args: CliParsedArgs = {
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
      const key = token.slice(2) as FlagName;
      args[key] = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

async function main() {
  let args: CliParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Failed to parse arguments.");
    }
    printUsage();
    process.exitCode = 2;
    return;
  }

  const hasJson = args.json === true;
  const hasTarget = typeof args.target === "string";
  const hasSource = typeof args.source === "string";
  const hasLock = typeof args.lock === "string";
  const hasArtifact = typeof args.artifact === "string";
  const hasOutput = typeof args.output === "string";
  const hasNoTarget = !hasTarget;
  const hasPackOutputOrDryRun = args.dryRun || hasOutput;

  const isPlan = args.command === "plan" && hasSource && hasTarget && hasJson;
  const isDiff = args.command === "diff" && hasSource && hasTarget && hasJson;
  const isPack = args.command === "pack" && hasSource && hasTarget && hasJson && hasPackOutputOrDryRun;
  const isValidate = args.command === "validate" && hasSource && hasNoTarget && hasJson;
  const isTargets = args.command === "targets" && hasSource && hasNoTarget && hasJson;
  const isStatus = args.command === "status" && hasSource && hasNoTarget && hasJson;
  const isApply = args.command === "apply" && hasSource && hasTarget && hasJson
    && ((hasLock || hasArtifact) && !(hasLock && hasArtifact));

  if (!isPlan && !isDiff && !isPack && !isValidate && !isTargets && !isStatus && !isApply) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  try {
    const result = await runCommand(args, {
      isPlan,
      isDiff,
      isPack,
      isTargets,
      isStatus,
      isApply
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Unhandled command failure.");
    }
    process.exitCode = 1;
  }
}

function isKnownCommand(command: string): command is CliCommand {
  return command === "plan" || command === "diff" || command === "pack" || command === "validate"
    || command === "targets" || command === "status" || command === "apply";
}

function isValueArg(token: string): token is `--${FlagName}` {
  return token === "--source" || token === "--target" || token === "--output" || token === "--lock"
    || token === "--artifact";
}

async function runCommand(
  args: CliParsedArgs,
  { isPlan, isDiff, isPack, isTargets, isStatus, isApply }: CommandFlags
): Promise<CliCommandResult> {
  if (isPlan) {
    return plan({
      source: requireStringValue("source", args.source),
      target: requireStringValue("target", args.target)
    });
  }

  if (isDiff) {
    return diff({
      source: requireStringValue("source", args.source),
      target: requireStringValue("target", args.target)
    });
  }

  if (isPack) {
    return pack({
      source: requireStringValue("source", args.source),
      target: requireStringValue("target", args.target),
      dryRun: args.dryRun,
      output: args.output ?? null
    });
  }

  if (isTargets) {
    return targets({ source: requireStringValue("source", args.source) });
  }

  if (isStatus) {
    return status({ source: requireStringValue("source", args.source) });
  }

  if (isApply) {
    const applyInput: {
      source: string;
      target: string;
      lock?: string;
      artifact?: string;
    } = {
      source: requireStringValue("source", args.source),
      target: requireStringValue("target", args.target)
    };

    if (args.lock !== undefined) {
      applyInput.lock = args.lock;
    }

    if (args.artifact !== undefined) {
      applyInput.artifact = args.artifact;
    }

    return apply(applyInput);
  }

  return validate({
    source: requireStringValue("source", args.source)
  });
}

await main();

function requireStringValue(name: FlagName | "source", value: string | undefined): string {
  if (typeof value !== "string") {
    throw new Error(`${name} is required`);
  }
  return value;
}
