import { track } from "../core/track/index.js";
import { hasJson, hasSource, hasTarget, requireStringValue } from "./helpers.js";
import type { CommandModule } from "./types.js";

export const trackCommand: CommandModule = {
  name: "track",
  accepts(args) {
    return args.command === "track" && hasSource(args) && hasTarget(args) && hasJson(args);
  },
  async run(args) {
    const input = {
      source: requireStringValue("source", args.source),
      target: requireStringValue("target", args.target),
      ...(args.skill !== undefined ? { skills: args.skill } : {})
    };
    return track(input);
  }
};
