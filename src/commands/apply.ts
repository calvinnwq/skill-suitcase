import { apply } from "../apply.js";
import { hasJson, hasSource, hasTarget, requireStringValue } from "./helpers.js";
import type { CommandModule } from "./types.js";

export const applyCommand: CommandModule = {
  name: "apply",
  accepts(args) {
    const hasLock = typeof args.lock === "string";
    const hasArtifact = typeof args.artifact === "string";
    return args.command === "apply" && hasSource(args) && hasTarget(args) && hasJson(args)
      && ((hasLock || hasArtifact) && !(hasLock && hasArtifact));
  },
  async run(args) {
    const input: {
      source: string;
      target: string;
      lock?: string;
      artifact?: string;
    } = {
      source: requireStringValue("source", args.source),
      target: requireStringValue("target", args.target)
    };

    if (args.lock !== undefined) {
      input.lock = args.lock;
    }

    if (args.artifact !== undefined) {
      input.artifact = args.artifact;
    }

    return apply(input);
  }
};
