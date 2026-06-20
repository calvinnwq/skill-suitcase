import { importTarget } from "../core/import-target/index.js";
import { hasJson, hasSource, hasTarget, requireStringValue } from "./helpers.js";
import { targetOverridesFromArgs } from "./target-overrides.js";
import type { CommandModule } from "./types.js";

export const importTargetCommand: CommandModule = {
  name: "import-target",
  accepts(args) {
    // import-target needs an explicit mode: --dry-run for the read-only plan, or
    // --apply for the approval-gated catalog write. Exactly one must be set, so
    // neither/both falls through to a usage error.
    const wantsDryRun = args.dryRun === true;
    const wantsApply = args.apply === true;
    return args.command === "import-target" &&
      hasSource(args) &&
      hasTarget(args) &&
      hasJson(args) &&
      wantsDryRun !== wantsApply;
  },
  async run(args) {
    const input: Parameters<typeof importTarget>[0] = {
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

    return importTarget(input);
  }
};
