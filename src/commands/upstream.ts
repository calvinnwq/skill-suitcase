import {
  checkUpstream,
  fetchUpstreamSkillDryRun,
  importUpstreamSkill
} from "../core/upstream/index.js";
import { hasJson, hasSource, requireStringValue } from "./helpers.js";
import type { CommandModule, ParsedCommandArgs } from "./types.js";

export const upstreamCommand: CommandModule = {
  name: "upstream",
  accepts(args) {
    if (args.command !== "upstream" || !hasSource(args) || !hasJson(args)) {
      return false;
    }
    if (args.upstreamAction === "check") {
      return args.dryRun === false && args.apply !== true && args.skill === undefined;
    }
    if (args.upstreamAction === "fetch") {
      return args.dryRun === true && args.apply !== true && hasExactlyOneSkill(args);
    }
    if (args.upstreamAction === "import") {
      return args.apply === true && args.dryRun === false && hasExactlyOneSkill(args);
    }
    return false;
  },
  async run(args) {
    const source = requireStringValue("source", args.source);
    if (args.upstreamAction === "check") {
      return checkUpstream(source);
    }
    const skill = args.skill?.[0];
    if (skill === undefined) {
      throw new Error("--skill requires a value");
    }
    if (args.upstreamAction === "fetch") {
      return fetchUpstreamSkillDryRun(source, skill);
    }
    return importUpstreamSkill(source, skill);
  }
};

function hasExactlyOneSkill(args: ParsedCommandArgs): boolean {
  return args.skill !== undefined && args.skill.length === 1;
}
