import { pack } from "../core/packing/index.js";
import { hasJson, hasSource, hasTarget, requireStringValue } from "./helpers.js";
import { targetOverridesFromArgs } from "./target-overrides.js";
import type { CommandModule } from "./types.js";

export const packCommand: CommandModule = {
  name: "pack",
  accepts(args) {
    const hasOutput = typeof args.output === "string";
    return args.command === "pack" && hasSource(args) && hasTarget(args) && hasJson(args)
      && (args.dryRun || hasOutput);
  },
  async run(args) {
    return pack({
      source: requireStringValue("source", args.source),
      target: requireStringValue("target", args.target),
      dryRun: args.dryRun,
      output: args.output ?? null,
      targetOverrides: targetOverridesFromArgs(args)
    });
  }
};
