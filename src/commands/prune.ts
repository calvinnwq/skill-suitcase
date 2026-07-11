import { prune } from "../core/prune/index.js";
import { hasJson, hasSource, hasTarget, requireStringValue } from "./helpers.js";
import { targetOverridesFromArgs } from "./target-overrides.js";
import type { CommandModule } from "./types.js";

export const pruneCommand: CommandModule = {
  name: "prune",
  accepts(args) {
    const wantsDryRun = args.dryRun === true;
    const wantsApply = args.apply === true;
    return args.command === "prune" && hasSource(args) && hasTarget(args) && hasJson(args) &&
      wantsDryRun !== wantsApply && (wantsDryRun ? args.planId === undefined : typeof args.planId === "string");
  },
  async run(args) {
    const input: Parameters<typeof prune>[0] = {
      source: requireStringValue("source", args.source),
      target: requireStringValue("target", args.target),
      ...(args.skill !== undefined ? { skills: args.skill } : {}),
      ...(args.dryRun === true ? { dryRun: true } : {}),
      ...(args.apply === true ? { apply: true } : {}),
      ...(args.planId !== undefined ? { planId: args.planId } : {})
    };
    const targetOverrides = targetOverridesFromArgs(args);
    if (targetOverrides !== undefined) input.targetOverrides = targetOverrides;
    return prune(input);
  }
};
