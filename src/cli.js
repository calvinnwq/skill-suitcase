#!/usr/bin/env node
import { plan } from "./planner.js";

function printUsage() {
  console.error("Usage: suitcase plan --source <skills-repo> --target <target> --json");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, json: false };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === "--json") {
      args.json = true;
      continue;
    }

    if (token === "--source" || token === "--target") {
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

  if (args.command !== "plan" || !args.source || !args.target || !args.json) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  try {
    const result = await plan({ source: args.source, target: args.target });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

await main();
