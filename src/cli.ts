#!/usr/bin/env node
import { plan } from "./planner.js";
import { pack } from "./packer.js";
import { diff } from "./diff.js";
import { validate } from "./validator.js";
import { targets } from "./targets.js";
import { status } from "./status.js";

function printUsage() {
  console.error("Usage:");
  console.error("  suitcase plan --source <skills-repo> --target <target> --json");
  console.error("  suitcase diff --source <skills-repo> --target <target> --json");
  console.error("  suitcase pack --source <skills-repo> --target <target> --dry-run --json");
  console.error("  suitcase pack --source <skills-repo> --target <target> --output <dir> --json");
  console.error("  suitcase validate --source <skills-repo> --json");
  console.error("  suitcase targets --source <skills-repo> --json");
  console.error("  suitcase status --source <skills-repo> --json");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, dryRun: false, json: false };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === "--json") {
      args.json = true;
      continue;
    }

    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (token === "--source" || token === "--target" || token === "--output") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${token} requires a value`);
      }
      args[token.slice(2)] = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printUsage();
    process.exitCode = 2;
    return;
  }

  const isPlan = args.command === "plan" && args.source && args.target && args.json;
  const isDiff = args.command === "diff" && args.source && args.target && args.json;
  const isPack =
    args.command === "pack" &&
    args.source &&
    args.target &&
    args.json &&
    (args.dryRun || args.output);
  const isValidate = args.command === "validate" && args.source && !args.target && args.json;
  const isTargets = args.command === "targets" && args.source && !args.target && args.json;
  const isStatus = args.command === "status" && args.source && !args.target && args.json;

  if (!isPlan && !isDiff && !isPack && !isValidate && !isTargets && !isStatus) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  try {
    const result = await runCommand(args, { isPlan, isDiff, isPack, isTargets, isStatus });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

async function runCommand(args, { isPlan, isDiff, isPack, isTargets, isStatus }) {
  if (isPlan) {
    return plan({ source: args.source, target: args.target });
  }

  if (isDiff) {
    return diff({ source: args.source, target: args.target });
  }

  if (isPack) {
    return pack({
      source: args.source,
      target: args.target,
      dryRun: args.dryRun,
      output: args.output
    });
  }

  if (isTargets) {
    return targets({ source: args.source });
  }

  if (isStatus) {
    return status({ source: args.source });
  }

  return validate({ source: args.source });
}

await main();
