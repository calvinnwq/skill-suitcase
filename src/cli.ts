#!/usr/bin/env node
import { dispatchCommand } from "./commands/index.js";

async function main(): Promise<void> {
  try {
    const dispatched = await dispatchCommand(process.argv.slice(2));

    if (dispatched.type === "usage") {
      if (dispatched.message !== null) {
        console.error(dispatched.message);
      }
      console.error(dispatched.usage);
      process.exitCode = dispatched.exitCode;
      return;
    }

    console.log(JSON.stringify(dispatched.result, null, 2));
    process.exitCode = dispatched.exitCode;
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Unhandled command failure.");
    }
    process.exitCode = 1;
  }
}

await main();
