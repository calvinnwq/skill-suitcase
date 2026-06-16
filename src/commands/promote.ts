import { planPromote } from "../core/promote/index.js";
import { hasJson, hasSource, requireStringValue } from "./helpers.js";
import type { CommandModule, ParsedCommandArgs } from "./types.js";

export const promoteCommand: CommandModule = {
  name: "promote",
  accepts(args) {
    // Iteration 1 ships the read-only/dry-run plan only. Live promotion (copy,
    // hash-verify, symlink-back, receipts) is a follow-up, so the command
    // currently requires --dry-run.
    return args.command === "promote" &&
      hasSource(args) &&
      hasTargetSkill(args) &&
      hasJson(args) &&
      args.dryRun === true;
  },
  async run(args) {
    return planPromote({
      source: requireStringValue("source", args.source),
      targetSkill: requireStringValue("targetSkill", args.targetSkill)
    });
  }
};

function hasTargetSkill(args: ParsedCommandArgs): boolean {
  return typeof args.targetSkill === "string";
}
