import type { TargetOverrides } from "../core/catalog/index.js";
import type { ParsedCommandArgs } from "./types.js";

export function targetOverridesFromArgs(args: ParsedCommandArgs): TargetOverrides | undefined {
  const overrides: TargetOverrides = {};

  if (args.agentsSkills !== undefined) {
    overrides.agentsSkills = args.agentsSkills;
  }

  if (args.codexHome !== undefined) {
    overrides.codexHome = args.codexHome;
  }

  if (args.codexSkills !== undefined) {
    overrides.codexSkills = args.codexSkills;
  }

  if (args.claudeSkills !== undefined) {
    overrides.claudeSkills = args.claudeSkills;
  }

  return overrides.agentsSkills === undefined &&
    overrides.codexHome === undefined &&
    overrides.codexSkills === undefined &&
    overrides.claudeSkills === undefined
      ? undefined
      : overrides;
}
