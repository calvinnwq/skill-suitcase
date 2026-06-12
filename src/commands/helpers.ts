import type { ParsedCommandArgs, ValueFlagName } from "./types.js";

export function hasSource(args: ParsedCommandArgs): boolean {
  return typeof args.source === "string";
}

export function hasTarget(args: ParsedCommandArgs): boolean {
  return typeof args.target === "string";
}

export function hasJson(args: ParsedCommandArgs): boolean {
  return args.json === true;
}

export function hasNoTarget(args: ParsedCommandArgs): boolean {
  return !hasTarget(args);
}

export function requireStringValue(name: ValueFlagName | "source", value: string | undefined): string {
  if (typeof value !== "string") {
    throw new Error(`${name} is required`);
  }
  return value;
}
