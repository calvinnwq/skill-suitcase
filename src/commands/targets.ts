import { targets } from "../targets.js";
import { hasJson, hasNoTarget, hasSource, requireStringValue } from "./helpers.js";
import type { CommandModule } from "./types.js";

export const targetsCommand: CommandModule = {
  name: "targets",
  accepts(args) {
    return args.command === "targets" && hasSource(args) && hasNoTarget(args) && hasJson(args);
  },
  async run(args) {
    return targets({ source: requireStringValue("source", args.source) });
  }
};
