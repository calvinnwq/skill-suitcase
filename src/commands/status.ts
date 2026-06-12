import { status } from "../core/status/index.js";
import { hasJson, hasNoTarget, hasSource, requireStringValue } from "./helpers.js";
import type { CommandModule } from "./types.js";

export const statusCommand: CommandModule = {
  name: "status",
  accepts(args) {
    return args.command === "status" && hasSource(args) && hasNoTarget(args) && hasJson(args);
  },
  async run(args) {
    return status({ source: requireStringValue("source", args.source) });
  }
};
