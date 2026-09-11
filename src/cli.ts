#!/usr/bin/env node
import { dispatchCommand } from "./commands/index.js";
import { EXIT_CODE_EXECUTION_FAILURE } from "./renderers/exit-codes.js";
import { renderCliError, messageFromUnknownError } from "./renderers/errors.js";
import { renderJson } from "./renderers/json.js";
import { renderUpdateNotice, renderUpdateSummary } from "./renderers/update.js";

async function main(): Promise<void> {
  try {
    const dispatched = await dispatchCommand(process.argv.slice(2), { interactiveStderr: process.stderr.isTTY === true });

    if (dispatched.type === "usage") {
      process.stderr.write(renderCliError(dispatched));
      process.exitCode = dispatched.exitCode;
      return;
    }

    if (dispatched.type === "summary") {
      process.stderr.write(renderUpdateSummary(dispatched.result));
      process.exitCode = dispatched.exitCode;
      return;
    }

    process.stdout.write(renderJson(dispatched.result));
    process.exitCode = dispatched.exitCode;
    const notice = await dispatched.notice;
    if (notice !== null) {
      process.stderr.write(renderUpdateNotice(notice));
    }
  } catch (error) {
    process.stderr.write(renderCliError({
      type: "fatal",
      message: messageFromUnknownError(error, "Unhandled command failure.")
    }));
    process.exitCode = EXIT_CODE_EXECUTION_FAILURE;
  }
}

await main();
