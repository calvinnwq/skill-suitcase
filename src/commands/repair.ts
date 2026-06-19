import { repair } from "../core/repair/index.js";
import { hasJson, hasSource, hasTarget, requireStringValue } from "./helpers.js";
import { targetOverridesFromArgs } from "./target-overrides.js";
import type { CommandModule } from "./types.js";

export const repairCommand: CommandModule = {
  name: "repair",
  accepts(args) {
    return args.command === "repair" &&
      hasSource(args) &&
      hasTarget(args) &&
      hasJson(args) &&
      args.dryRun === true;
  },
  async run(args) {
    const input: Parameters<typeof repair>[0] = {
      source: requireStringValue("source", args.source),
      target: requireStringValue("target", args.target),
      ...(args.skill !== undefined ? { skills: args.skill } : {}),
      dryRun: true
    };

    const targetOverrides = targetOverridesFromArgs(args);
    if (targetOverrides !== undefined) {
      input.targetOverrides = targetOverrides;
    }

    return repair(input);
  }
};
