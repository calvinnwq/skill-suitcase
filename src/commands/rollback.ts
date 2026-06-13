import { rollback } from "../core/rollback/index.js";
import { hasJson, requireStringValue } from "./helpers.js";
import type { CommandModule } from "./types.js";

export const rollbackCommand: CommandModule = {
  name: "rollback",
  accepts(args) {
    return args.command === "rollback" && typeof args.receipt === "string" && hasJson(args);
  },
  async run(args) {
    return rollback({
      receipt: requireStringValue("receipt", args.receipt)
    });
  }
};
