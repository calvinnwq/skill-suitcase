import { realpath } from "node:fs/promises";
import path from "node:path";

export function normalizeFilesystemComparisonPath(value: string, caseInsensitive: boolean): string {
  const canonicallyNormalized = value.normalize("NFC");
  return caseInsensitive
    ? canonicallyNormalized.toLocaleLowerCase("en-US").normalize("NFC")
    : canonicallyNormalized;
}

export async function filesystemComparisonPath(value: string): Promise<string> {
  return normalizeFilesystemComparisonPath(value, await isCaseInsensitiveFilesystem(value));
}

export async function isCaseInsensitiveFilesystem(value: string): Promise<boolean> {
  if (process.platform === "win32") return true;
  let existing = path.resolve(value);
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
  }

  let probe = existing;
  while (true) {
    const basename = path.basename(probe);
    const alternateBasename = toggleFirstAsciiLetterCase(basename);
    if (alternateBasename !== basename) {
      try {
        const alternate = await realpath(path.join(path.dirname(probe), alternateBasename));
        return alternate === probe;
      } catch {
        return false;
      }
    }
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
}

function toggleFirstAsciiLetterCase(value: string): string {
  return value.replace(/[A-Za-z]/, (letter) =>
    letter === letter.toLocaleLowerCase("en-US")
      ? letter.toLocaleUpperCase("en-US")
      : letter.toLocaleLowerCase("en-US")
  );
}
