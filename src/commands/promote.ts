import { executePromote, planPromote } from "../core/promote/index.js";
import { hasJson, hasSource, requireStringValue } from "./helpers.js";
import type { CommandModule, ParsedCommandArgs } from "./types.js";

export const promoteCommand: CommandModule = {
  name: "promote",
  accepts(args) {
    // promote needs an explicit mode: --dry-run for the read-only plan, or
    // --apply for the approval-gated live promotion (copy, hash-verify,
    // symlink-back, receipt). The two are mutually exclusive — exactly one must
    // be set, so neither/both falls through to a usage error.
    const wantsDryRun = args.dryRun === true;
    const wantsApply = args.apply === true;
    return args.command === "promote" &&
      hasSource(args) &&
      hasTargetSkill(args) &&
      hasJson(args) &&
      wantsDryRun !== wantsApply;
  },
  async run(args) {
    const source = requireStringValue("source", args.source);
    const targetSkill = requireStringValue("targetSkill", args.targetSkill);
    if (args.apply === true) {
      return executePromote({ source, targetSkill });
    }
    return planPromote({ source, targetSkill });
  }
};

function hasTargetSkill(args: ParsedCommandArgs): boolean {
  return typeof args.targetSkill === "string";
}
