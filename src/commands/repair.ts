import { repair } from "../core/repair/index.js";
import { hasJson, hasSource, hasTarget, requireStringValue } from "./helpers.js";
import { targetOverridesFromArgs } from "./target-overrides.js";
import type { CommandModule } from "./types.js";

export const repairCommand: CommandModule = {
  name: "repair",
  accepts(args) {
    const wantsDryRun = args.dryRun === true;
    const wantsApply = args.apply === true;
    return args.command === "repair" &&
      hasSource(args) &&
      hasTarget(args) &&
      hasJson(args) &&
      wantsDryRun !== wantsApply;
  },
  async run(args) {
    const input: Parameters<typeof repair>[0] = {
      source: requireStringValue("source", args.source),
      target: requireStringValue("target", args.target),
      ...(args.skill !== undefined ? { skills: args.skill } : {}),
      ...(args.dryRun === true ? { dryRun: true } : {}),
      ...(args.apply === true ? { apply: true } : {})
    };

    const targetOverrides = targetOverridesFromArgs(args);
    if (targetOverrides !== undefined) {
      input.targetOverrides = targetOverrides;
    }

    return repair(input);
  }
};
