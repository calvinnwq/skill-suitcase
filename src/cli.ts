#!/usr/bin/env node
import { dispatchCommand } from "./commands/index.js";
import { EXIT_CODE_EXECUTION_FAILURE } from "./renderers/exit-codes.js";
import { renderCliError, messageFromUnknownError } from "./renderers/errors.js";
import { renderJson } from "./renderers/json.js";

async function main(): Promise<void> {
  try {
    const dispatched = await dispatchCommand(process.argv.slice(2));

    if (dispatched.type === "usage") {
      process.stderr.write(renderCliError({ type: "usage", message: dispatched.message }));
      process.exitCode = dispatched.exitCode;
      return;
    }

    process.stdout.write(renderJson(dispatched.result));
    process.exitCode = dispatched.exitCode;
  } catch (error) {
    process.stderr.write(renderCliError({
      type: "fatal",
      message: messageFromUnknownError(error, "Unhandled command failure.")
    }));
    process.exitCode = EXIT_CODE_EXECUTION_FAILURE;
  }
}

await main();
