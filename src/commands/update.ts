import { updateCli } from "../core/cli-update/index.js";
import { hasJson } from "./helpers.js";
import type { CommandModule } from "./types.js";

export const updateCommand: CommandModule = {
  name: "update",
  accepts(args) {
    return args.command === "update";
  },
  presentation(args) {
    return hasJson(args) ? "json" : "summary";
  },
  async run(args) {
    return updateCli({ check: args.check === true });
  }
};
