import { status } from "../core/status/index.js";
import { hasJson, hasSource, requireStringValue } from "./helpers.js";
import { targetOverridesFromArgs } from "./target-overrides.js";
import type { CommandModule } from "./types.js";

export const statusCommand: CommandModule = {
  name: "status",
  accepts(args) {
    return args.command === "status" && hasSource(args) && hasJson(args);
  },
  async run(args) {
    const input: {
      source: string;
      target?: string;
      targetOverrides?: ReturnType<typeof targetOverridesFromArgs>;
    } = {
      source: requireStringValue("source", args.source)
    };

    if (args.target !== undefined) {
      input.target = args.target;
    }

    const targetOverrides = targetOverridesFromArgs(args);
    if (targetOverrides !== undefined) {
      input.targetOverrides = targetOverrides;
    }

    return status(input);
  }
};
