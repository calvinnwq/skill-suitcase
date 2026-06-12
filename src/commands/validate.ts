import { validate } from "../core/validation/index.js";
import { hasJson, hasNoTarget, hasSource, requireStringValue } from "./helpers.js";
import type { CommandModule } from "./types.js";

export const validateCommand: CommandModule = {
  name: "validate",
  accepts(args) {
    return args.command === "validate" && hasSource(args) && hasNoTarget(args) && hasJson(args);
  },
  async run(args) {
    return validate({ source: requireStringValue("source", args.source) });
  }
};
