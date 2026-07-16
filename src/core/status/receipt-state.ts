import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  LEGACY_RECEIPT_FILE,
  LEGACY_RECEIPT_SCHEMA,
  RECEIPT_FILE,
  RECEIPT_SCHEMA
} from "../receipts/index.js";
import { normalizeFilesystemComparisonPath } from "../filesystem-comparison.js";

/**
 * Receipt reading and install-record selection for status.
 *
 * Everything in this module treats receipt content as untrusted input: it
 * prefers the modern receipt over the legacy receipt, reads and parses the
 * receipt JSON, validates the receipt schema, normalizes legacy receipts and
 * install records, validates `installedFiles`, and selects the one install
 * record matching the active install root, target path, and destination. It
 * reads the filesystem only to load receipt files and never mutates it. The
 * status entrypoint in index.ts consumes the normalized receipt state returned
 * here and retains status planning, per-skill classification, and summary
 * construction.
 */

export type StatusFinding = {
  code: string;
  message: string;
  path?: string;
  scope?: string;
  skill?: string;
  sourcePath?: string;
  targetPath?: string;
};
type ReceiptReadingResult = {
  found: boolean;
  receipt: {
    schema: string;
    installs: ReceiptInstalls;
  };
  errors: StatusFinding[];
};
export type ReceiptInstalls = Record<string, InstallRecord[]>;
export type InstallRecord = {
  [key: string]: unknown;
  agent?: string;
  mode?: string;
  source?: string | ({ path: string } & Record<string, unknown>) | null;
  sourcePath?: string;
  targetPath?: string;
  target?: string;
  version?: string;
  variant?: string;
  sourceCommit?: string;
  sourceHash?: string;
  destination?: string;
  installedFiles?: InstalledFileRecord[] | null;
  priorState?: Record<string, unknown> | null;
  skill?: string;
};
type NormalizedInstallRecordResult = {
  record: InstallRecord | null;
  errors: StatusFinding[];
};
export type InstalledFileRecord = {
  path?: string;
  hash?: string;
  [key: string]: unknown;
};

const INSTALL_RECORD_SCALAR_FIELDS = [
  "agent",
  "mode",
  "sourcePath",
  "targetPath",
  "version",
  "variant",
  "sourceCommit",
  "sourceHash",
  "destination"
] as const;

export async function readReceipt(installRoot: string): Promise<{ receipt: { schema: string; installs: ReceiptInstalls }; errors: StatusFinding[]; receiptPath: string }> {
  const receiptPath = path.join(installRoot, RECEIPT_FILE);
  const legacyReceiptPath = path.join(installRoot, LEGACY_RECEIPT_FILE);
  const emptyReceipt = { schema: RECEIPT_SCHEMA, installs: {} as ReceiptInstalls };

  const modernReceipt = await readReceiptFile(receiptPath, { legacy: false });
  if (modernReceipt.found) {
    return { receipt: modernReceipt.receipt, errors: modernReceipt.errors, receiptPath };
  }

  const legacyReceipt = await readReceiptFile(legacyReceiptPath, { legacy: true });
  if (legacyReceipt.found) {
    return { receipt: legacyReceipt.receipt, errors: legacyReceipt.errors, receiptPath: legacyReceiptPath };
  }

  return { receipt: emptyReceipt, errors: [], receiptPath };
}

type ReadReceiptFileInput = {
  legacy: boolean;
};
async function readReceiptFile(receiptPath: string, { legacy }: ReadReceiptFileInput): Promise<ReceiptReadingResult> {
  const emptyReceipt = { schema: RECEIPT_SCHEMA, installs: {} as ReceiptInstalls };
  try {
    const text = await readFile(receiptPath, "utf8");
    const record = JSON.parse(text) as unknown;
    if (!isRecord(record)) {
      return {
        found: true,
        receipt: emptyReceipt,
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt ${receiptPath} must be a JSON object.`
          }
        ]
      };
    }

    if (legacy) {
      if (record.schema !== LEGACY_RECEIPT_SCHEMA) {
        return {
          found: true,
          receipt: emptyReceipt,
          errors: [
            {
              code: "invalid_receipt",
              message: `Suitcase receipt ${receiptPath} has an unsupported legacy schema.`
            }
          ]
        };
      }
      const legacyReceipt = normalizeLegacyReceipt(record);
      return {
        found: true,
        receipt: legacyReceipt.receipt,
        errors: legacyReceipt.errors
      };
    }

    if (record.schema !== RECEIPT_SCHEMA) {
      return {
        found: true,
        receipt: emptyReceipt,
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt ${receiptPath} has an unsupported schema.`
          }
        ]
      };
    }

    const normalized = normalizeReceiptInstalls(record.installs, { receiptPath });
    return {
      found: true,
      receipt: {
        ...record,
        schema: RECEIPT_SCHEMA,
        installs: normalized.installs
      },
      errors: normalized.errors
    };
  } catch (error) {
    const maybeNodeError = error as { code?: string };
    if (maybeNodeError.code === "ENOENT") {
      return { found: false, receipt: emptyReceipt, errors: [] };
    }
    if (error instanceof SyntaxError) {
      return {
        found: true,
        receipt: emptyReceipt,
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt ${receiptPath} is not valid JSON.`
          }
        ]
      };
    }
    return {
      found: true,
      receipt: emptyReceipt,
      errors: [
        {
          code: "receipt_read_failed",
          message: `Unable to read suitcase receipt ${receiptPath}: ${errorMessage(error)}`
        }
      ]
    };
  }
}

function normalizeLegacyReceipt(record: Record<string, unknown>): { receipt: { schema: string; installs: ReceiptInstalls; [key: string]: unknown }; errors: StatusFinding[] } {
  const normalized = {
    ...record,
    schema: RECEIPT_SCHEMA,
    installs: {} as ReceiptInstalls
  };
  const normalizedEntries = normalizeReceiptInstalls(record.installs, {
    receiptPath: "legacy suitcase receipt"
  });
  normalized.installs = normalizedEntries.installs;
  return { receipt: normalized, errors: normalizedEntries.errors };
}

function normalizeReceiptInstalls(
  installs: unknown,
  { receiptPath }: { receiptPath: string }
): { installs: ReceiptInstalls; errors: StatusFinding[] } {
  const normalized: ReceiptInstalls = {};
  const errors: StatusFinding[] = [];
  if (installs === undefined) {
    return { installs: normalized, errors };
  }
  if (!isRecord(installs)) {
    errors.push({
      code: "invalid_receipt",
      message: `Suitcase receipt ${receiptPath} has an invalid installs mapping.`
    });
    return { installs: normalized, errors };
  }

  for (const [skillName, installEntries] of Object.entries(installs)) {
    const entries = Array.isArray(installEntries) ? installEntries : [installEntries];
    const normalizedEntries: InstallRecord[] = [];
    for (const entry of entries) {
      const normalizedEntry = normalizeReceiptInstallRecord(entry, { skillName });
      if (normalizedEntry.errors.length > 0) {
        errors.push(...normalizedEntry.errors.map((item) => ({ ...item, skill: skillName })));
        continue;
      }
      const { record } = normalizedEntry;
      if (record === null) {
        continue;
      }
      normalizedEntries.push(record);
    }
    if (normalizedEntries.length > 0) {
      normalized[skillName] = normalizedEntries;
    }
  }

  return { installs: normalized, errors };
}

function normalizeReceiptInstallRecord(
  installRecord: unknown,
  { skillName }: { skillName: string }
): NormalizedInstallRecordResult {
  if (!isRecord(installRecord)) {
    return {
      record: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt has an invalid install record for ${skillName}.`
        }
      ]
    };
  }

  const source = normalizeValue(installRecord.source);
  const sourcePath =
    normalizeValue(installRecord.sourcePath) ??
    (isRecord(installRecord.source)
      ? normalizeValue(installRecord.source.path)
      : normalizeValue(source))
    ?? undefined;
  const mode = normalizeValue(installRecord.mode) ?? undefined;
  const target = normalizeValue(installRecord.target) ?? undefined;
  const targetPath = normalizeValue(installRecord.targetPath) ?? undefined;
  const version = normalizeValue(installRecord.version) ?? undefined;
  const variant = normalizeValue(installRecord.variant) ?? undefined;
  const sourceCommit = normalizeValue(installRecord.sourceCommit) ?? undefined;
  const sourceHash = normalizeValue(installRecord.sourceHash) ?? undefined;
  const installedFiles = Array.isArray(installRecord.installedFiles) ? installRecord.installedFiles : null;
  const priorState = isRecord(installRecord.priorState) ? installRecord.priorState : null;
  const agent = normalizeValue(installRecord.agent) ?? undefined;
  const canonicalSkill = normalizeValue(installRecord.skill) ?? skillName;

  const requiredField = ["agent", "mode", "sourcePath", "targetPath"].find((field) => {
    const value = {
      agent,
      mode,
      sourcePath,
      targetPath
    }[field];
    return typeof value !== "string" || value.length === 0;
  });
  if (requiredField) {
    return {
      record: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt has an invalid ${requiredField} field for ${skillName}.`
        }
      ]
    };
  }

  if (sourcePath === undefined || mode === undefined || targetPath === undefined || agent === undefined) {
    return {
      record: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt has an invalid install record for ${skillName}.`
        }
      ]
    };
  }

  const normalizedSourcePath = sourcePath;
  const normalizedMode = mode;
  const normalizedTargetPath = targetPath;
  const normalizedAgent = agent;

  const invalidScalarField = Array.from(INSTALL_RECORD_SCALAR_FIELDS).find((field) => {
    const value = installRecord[field];
    if (value === undefined || value === null) {
      return false;
    }
    return typeof value !== "string";
  });
  if (invalidScalarField) {
    return {
      record: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt has an invalid ${invalidScalarField} field for ${skillName}.`
        }
      ]
    };
  }

  const hasProvenance = [version, sourceCommit, sourceHash].some(
    (value) => typeof value === "string" && value.length > 0
  );
  if (!hasProvenance) {
    return {
      record: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt has no source provenance for ${skillName}.`
        }
      ]
    };
  }

  if (installRecord.source !== undefined) {
    if (isRecord(installRecord.source)) {
      if (!normalizeValue(installRecord.source.path)) {
        return {
          record: null,
          errors: [
            {
              code: "invalid_receipt",
              message: `Suitcase receipt has an invalid source.path for ${skillName}.`
            }
          ]
        };
      }
    } else if (typeof installRecord.source !== "string" && installRecord.source !== null) {
      return {
        record: null,
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt has an invalid source for ${skillName}.`
          }
        ]
      };
    }
    if (typeof installRecord.source === "string" && normalizeValue(installRecord.source) === null) {
      return {
        record: null,
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt has an invalid source for ${skillName}.`
          }
        ]
      };
    }
  }

  const normalizedInstalledFiles = validateInstalledFiles(installRecord.installedFiles, {
    skillName
  });
  if (normalizedInstalledFiles.errors.length > 0) {
    return {
      record: null,
      errors: normalizedInstalledFiles.errors
    };
  }

  if (installRecord.priorState !== undefined && !isRecord(installRecord.priorState)) {
    return {
      record: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt has an invalid priorState for ${skillName}.`
        }
      ]
    };
  }

  const sourceRecord = isRecord(installRecord.source)
    ? ({
      ...(installRecord.source as Record<string, unknown>),
      path: source ?? normalizedSourcePath
    } as ({ path: string } & Record<string, unknown>))
    : {
      path: source ?? normalizedSourcePath
    };

  const canonical: InstallRecord = {
    ...installRecord,
    skill: canonicalSkill,
    mode: normalizedMode,
    sourcePath: normalizedSourcePath,
    targetPath: normalizedTargetPath,
    installedFiles: normalizedInstalledFiles.files,
    priorState,
    source: sourceRecord,
    agent: normalizedAgent
  };
  if (target !== undefined) {
    canonical.target = target;
  } else {
    delete canonical.target;
  }
  if (version !== undefined) {
    canonical.version = version;
  } else {
    delete canonical.version;
  }
  if (variant !== undefined) {
    canonical.variant = variant;
  } else {
    delete canonical.variant;
  }
  if (sourceCommit !== undefined) {
    canonical.sourceCommit = sourceCommit;
  } else {
    delete canonical.sourceCommit;
  }
  if (sourceHash !== undefined) {
    canonical.sourceHash = sourceHash;
  } else {
    delete canonical.sourceHash;
  }

  return {
    record: canonical,
    errors: []
  };
}

function validateInstalledFiles(
  installedFiles: unknown,
  { skillName }: { skillName: string }
): { files: InstalledFileRecord[] | null; errors: StatusFinding[] } {
  if (installedFiles === null || installedFiles === undefined) {
    return { files: null, errors: [] };
  }
  if (!Array.isArray(installedFiles)) {
    return {
      files: [],
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt has invalid installedFiles for ${skillName}.`
        }
      ]
    };
  }

  for (const file of installedFiles) {
    if (!isRecord(file)) {
      return {
        files: [],
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt has invalid installedFiles for ${skillName}.`
          }
        ]
      };
    }
    if (normalizeValue(file.path) === null) {
      return {
        files: [],
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt has invalid installedFiles for ${skillName}.`
          }
        ]
      };
    }
    if (file.hash !== undefined && normalizeValue(file.hash) === null) {
      return {
        files: [],
        errors: [
          {
            code: "invalid_receipt",
            message: `Suitcase receipt has invalid installedFiles for ${skillName}.`
          }
        ]
      };
    }
  }

  return {
    files: installedFiles as InstalledFileRecord[],
    errors: []
  };
}

export function selectInstallRecord({
  installRecords,
  installRoot,
  skillName,
  receiptPath,
  targetPath,
  destination,
  caseInsensitive
}: {
  installRecords: unknown;
  installRoot: string;
  skillName: string;
  receiptPath: string;
  targetPath: string;
  destination: string;
  caseInsensitive: boolean;
}): { installRecord: InstallRecord | null; errors: StatusFinding[] } {
  if (installRecords === undefined) {
    return { installRecord: null, errors: [] };
  }

  if (!Array.isArray(installRecords)) {
    return {
      installRecord: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt ${receiptPath} has an invalid install record for ${skillName}.`
        }
      ]
    };
  }

  const normalizedRootPath = path.resolve(installRoot);
  const comparisonKey = (value: string) => normalizeFilesystemComparisonPath(
    path.resolve(value),
    caseInsensitive
  );
  const normalizedRootKey = comparisonKey(normalizedRootPath);
  const normalizedSkillTarget = comparisonKey(targetPath);
  const matching: InstallRecord[] = [];

  for (const entry of installRecords) {
    if (!isRecord(entry)) {
      continue;
    }
    const candidate = normalizeValue(entry.targetPath);
    if (!candidate) {
      continue;
    }
    const resolvedCandidate = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(normalizedRootPath, candidate);
    const normalizedCandidate = comparisonKey(resolvedCandidate);
    if (
      normalizedCandidate === normalizedRootKey ||
      normalizedCandidate === normalizedSkillTarget
    ) {
      matching.push(entry as InstallRecord);
    }
  }

  if (matching.length > 1) {
    return {
      installRecord: null,
      errors: [
        {
          code: "invalid_receipt",
          message: `Suitcase receipt ${receiptPath} has ambiguous install records for ${skillName} at ${installRoot}.`
        }
      ]
    };
  }

  if (matching.length === 1) {
    const [matchingRecord] = matching;
    const recordedDestination = normalizeValue(matchingRecord?.destination);
    if (
      recordedDestination !== null
      && comparisonKey(path.resolve(normalizedRootPath, recordedDestination))
        !== comparisonKey(path.resolve(normalizedRootPath, destination))
    ) {
      return {
        installRecord: null,
        errors: [{
          code: "invalid_receipt",
          message: `Suitcase receipt ${receiptPath} has destination ${recordedDestination} for ${skillName}, expected ${destination}.`
        }]
      };
    }
    return { installRecord: matchingRecord ?? null, errors: [] };
  }

  return {
    installRecord: null,
    errors: [
      {
        code: "invalid_receipt",
        message: `Suitcase receipt ${receiptPath} has no matching install record for ${skillName} at ${installRoot}.`
      }
    ]
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "An unexpected error occurred";
}
