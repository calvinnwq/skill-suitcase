import { diff } from "../core/diffing/index.js";
import { hasJson, hasSource, hasTarget, requireStringValue } from "./helpers.js";
import { targetOverridesFromArgs } from "./target-overrides.js";
import type { CommandModule } from "./types.js";

export const diffCommand: CommandModule = {
  name: "diff",
  accepts(args) {
    return args.command === "diff" && hasSource(args) && hasTarget(args) && hasJson(args);
  },
  async run(args) {
    return diff({
      source: requireStringValue("source", args.source),
      target: requireStringValue("target", args.target),
      targetOverrides: targetOverridesFromArgs(args)
    });
  }
};
