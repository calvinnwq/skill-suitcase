import { CLI_UPDATE_OPT_OUT_ENV, CLI_UPDATE_PACKAGE_NAME } from "../config/cli-update.js";

type UpdateSummaryInput = {
  action: "check" | "update";
  status: string;
  currentVersion: string | null;
  latestVersion: string | null;
  installedVersion: string | null;
  installation: { canSelfUpdate: boolean; guidance: string };
  error: { code: string; message: string } | null;
};

type UpdateNoticeInput = {
  currentVersion: string;
  latestVersion: string;
  installation: "package" | "source";
};

const NAME = CLI_UPDATE_PACKAGE_NAME;

export function renderUpdateSummary(result: UpdateSummaryInput): string {
  const current = result.currentVersion ?? "unknown";
  const lines: string[] = [];
  if (result.status === "updated") {
    lines.push(`Updated ${NAME} ${current} -> ${result.installedVersion ?? result.latestVersion ?? "unknown"} and verified the new launcher.`);
  } else if (result.status === "update-available") {
    lines.push(`${NAME} ${current} is installed; ${result.latestVersion ?? "a newer release"} is available.`);
    lines.push(result.installation.canSelfUpdate ? `Run "${NAME} update" to install it.` : result.installation.guidance);
  } else if (result.status === "up-to-date") {
    lines.push(`${NAME} ${current} is up to date.`);
  } else if (result.status === "ahead") {
    lines.push(`${NAME} ${current} is newer than the published ${result.latestVersion ?? "release"}; nothing to do.`);
  } else if (result.status === "unsupported-installation") {
    lines.push(`Cannot self-update ${NAME} ${current}: ${result.installation.guidance}`);
  } else {
    const verb = result.action === "check" ? "Update check" : "Update";
    lines.push(`${verb} failed (${result.error?.code ?? "unknown"}): ${result.error?.message ?? "no details."}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderUpdateNotice(notice: UpdateNoticeInput): string {
  const action = notice.installation === "package"
    ? `Run "${NAME} update" to install it.`
    : `This launch does not self-update; install the published package with npm install --global ${NAME}.`;
  return [
    `A newer ${NAME} is available: ${notice.currentVersion} -> ${notice.latestVersion}. ${action}`,
    `Set ${CLI_UPDATE_OPT_OUT_ENV}=1 to silence this notice.`,
    ""
  ].join("\n");
}
