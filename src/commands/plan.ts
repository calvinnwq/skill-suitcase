import { plan } from "../planner.js";
import { hasJson, hasSource, hasTarget, requireStringValue } from "./helpers.js";
import type { CommandModule } from "./types.js";

export const planCommand: CommandModule = {
  name: "plan",
  accepts(args) {
    return args.command === "plan" && hasSource(args) && hasTarget(args) && hasJson(args);
  },
  async run(args) {
    return plan({
      source: requireStringValue("source", args.source),
      target: requireStringValue("target", args.target)
    });
  }
};
