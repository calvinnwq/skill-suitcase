import { rollback } from "../core/rollback/index.js";
import { hasJson, requireStringValue } from "./helpers.js";
import { targetOverridesFromArgs } from "./target-overrides.js";
import type { CommandModule } from "./types.js";

export const rollbackCommand: CommandModule = {
  name: "rollback",
  accepts(args) {
    return args.command === "rollback" && typeof args.receipt === "string" && hasJson(args);
  },
  async run(args) {
    return rollback({
      receipt: requireStringValue("receipt", args.receipt),
      ...(typeof args.source === "string" ? { source: requireStringValue("source", args.source) } : {}),
      ...(typeof args.target === "string" ? { target: requireStringValue("target", args.target) } : {}),
      targetOverrides: targetOverridesFromArgs(args)
    });
  }
};
