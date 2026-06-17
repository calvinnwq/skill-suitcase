import { reconcile } from "../core/reconcile/index.js";
import { hasJson, hasSource, hasTarget, requireStringValue } from "./helpers.js";
import { targetOverridesFromArgs } from "./target-overrides.js";
import type { CommandModule } from "./types.js";

export const reconcileCommand: CommandModule = {
  name: "reconcile",
  accepts(args) {
    const wantsDryRun = args.dryRun === true;
    const wantsApply = args.apply === true;
    return args.command === "reconcile" &&
      hasSource(args) &&
      hasTarget(args) &&
      hasJson(args) &&
      wantsDryRun !== wantsApply;
  },
  async run(args) {
    const input: Parameters<typeof reconcile>[0] = {
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

    return reconcile(input);
  }
};
