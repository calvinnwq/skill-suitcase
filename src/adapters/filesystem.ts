import { readFile } from "node:fs/promises";

export async function readTextFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}
