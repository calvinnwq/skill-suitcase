import { usageText } from "./usage.js";

export type KnownCliError =
  | {
    type: "usage";
    message: string | null;
  }
  | {
    type: "fatal";
    message: string;
  };

export function renderCliError(error: KnownCliError): string {
  if (error.type === "usage") {
    const usage = usageText();
    return error.message === null ? `${usage}\n` : `${error.message}\n${usage}\n`;
  }

  return `${error.message}\n`;
}

export function messageFromUnknownError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
