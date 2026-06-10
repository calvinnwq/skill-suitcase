import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const targets = process.argv.slice(2);

const files = [];

function collectJsFiles(candidate) {
  if (!existsSync(candidate)) {
    return;
  }

  const info = statSync(candidate);
  if (info.isDirectory()) {
    for (const item of readdirSync(candidate, { withFileTypes: true })) {
      collectJsFiles(join(candidate, item.name));
    }
    return;
  }

  if (!info.isFile()) {
    return;
  }

  if (candidate.endsWith(".js")) {
    files.push(candidate);
  }
}

for (const target of targets) {
  collectJsFiles(target);
}

if (files.length === 0) {
  process.exit(0);
}

let exitCode = 0;
for (const filePath of files) {
  const result = spawnSync(process.execPath, ["--check", filePath], {
    encoding: "utf8",
    stdio: "inherit"
  });

  if (result.status !== 0) {
    exitCode = result.status ?? 1;
    break;
  }
}

process.exit(exitCode);
