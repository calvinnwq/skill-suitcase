import { inspectImportSource } from "../core/importing/index.js";
import { hasJson, hasNoTarget, hasSource, requireStringValue } from "./helpers.js";
import type { CommandModule, ParsedCommandArgs } from "./types.js";

export const importCommand: CommandModule = {
  name: "import",
  accepts(args) {
    return args.command === "import" &&
      hasSource(args) &&
      hasNoTarget(args) &&
      hasJson(args) &&
      hasNoImportOnlyExtras(args);
  },
  async run(args) {
    return inspectImportSource({ source: requireStringValue("source", args.source) });
  }
};

function hasNoImportOnlyExtras(args: ParsedCommandArgs): boolean {
  return args.dryRun === false &&
    args.output === undefined &&
    args.lock === undefined &&
    args.artifact === undefined &&
    args.receipt === undefined;
}
