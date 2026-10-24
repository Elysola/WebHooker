import type { NeutralMessage, NeutralAuthor } from "../types";
import { GITHUB_COLORS } from "./colors";
import { emojiPrefix, type T, buildMessage } from "./helpers";

export function formatCodeScanningAlert(
  payload: Record<string, unknown>,
  repo: string | undefined,
  author: NeutralAuthor,
  t: T,
  showEmoji: boolean,
): NeutralMessage {
  const action = (payload.action as string) ?? "created";
  const alert = payload.alert as {
    rule?: {
      id?: string;
      severity?: string;
      security_severity_level?: string;
      description?: string;
    };
    most_recent_instance?: { location?: { path?: string } };
    state?: string;
  };

  // The security severity (critical/high/medium/low) where the rule has one;
  // `severity` is the tool's own level (error/warning/note).
  const severity = alert.rule?.security_severity_level ?? alert.rule?.severity ?? "warning";
  const colorKey =
    severity === "critical"
      ? "code_scanning_critical"
      : severity === "high"
        ? "code_scanning_high"
        : severity === "medium"
          ? "code_scanning_medium"
          : "code_scanning_low";

  const severityEmoji =
    severity === "critical"
      ? "🔴"
      : severity === "high"
        ? "🟠"
        : severity === "medium"
          ? "🟡"
          : "⚪";
  const al = t("actions." + action) ?? action;
  const em = (e: string): string => emojiPrefix(e, showEmoji);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  fields.push({
    name: t("fields.severity"),
    value: `${em(severityEmoji)}${severity}`,
    inline: true,
  });

  if (alert.rule?.id) {
    fields.push({
      name: t("fields.rule"),
      value: alert.rule.id,
      inline: true,
    });
  }

  if (alert.most_recent_instance?.location?.path) {
    fields.push({
      name: t("fields.file"),
      value: `\`${alert.most_recent_instance.location.path}\``,
      inline: false,
    });
  }

  if (alert.rule?.description) {
    fields.push({
      name: t("fields.description"),
      value: alert.rule.description,
      inline: false,
    });
  }

  return buildMessage(
    {
      author,
      title: t("events.code_scanning.title", {
        repo: repo ?? t("common.repository"),
        action: al,
      }),
      color: GITHUB_COLORS[colorKey],
      fields,
    },
    t,
    repo,
  );
}

export function formatDependabotAlert(
  payload: Record<string, unknown>,
  repo: string | undefined,
  author: NeutralAuthor,
  t: T,
  showEmoji: boolean,
): NeutralMessage {
  const action = (payload.action as string) ?? "created";
  const alert = payload.alert as {
    security_advisory?: { severity?: string; summary?: string; description?: string };
    security_vulnerability?: {
      package?: { name?: string };
      vulnerable_version_range?: string;
      first_patched_version?: { identifier?: string };
    };
    state?: string;
    dependency?: { package?: { name?: string } };
    html_url?: string;
  };

  const severity = alert.security_advisory?.severity ?? "medium";
  const colorKey =
    severity === "critical"
      ? "dependabot_critical"
      : severity === "high"
        ? "dependabot_high"
        : severity === "medium"
          ? "dependabot_medium"
          : "dependabot_low";

  const severityEmoji =
    severity === "critical"
      ? "🔴"
      : severity === "high"
        ? "🟠"
        : severity === "medium"
          ? "🟡"
          : "⚪";
  const al = t("actions." + action) ?? action;
  const em = (e: string): string => emojiPrefix(e, showEmoji);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  fields.push({
    name: t("fields.severity"),
    value: `${em(severityEmoji)}${severity}`,
    inline: true,
  });

  const pkgName = alert.security_vulnerability?.package?.name ?? alert.dependency?.package?.name;
  if (pkgName) {
    fields.push({
      name: t("fields.package"),
      value: pkgName,
      inline: true,
    });
  }

  if (alert.security_vulnerability?.vulnerable_version_range) {
    const patched = alert.security_vulnerability.first_patched_version?.identifier;
    fields.push({
      name: t("fields.vulnerable_range"),
      value: `${alert.security_vulnerability.vulnerable_version_range}${patched ? ` → fix: \`${patched}\`` : ""}`,
      inline: false,
    });
  }

  if (alert.security_advisory?.summary) {
    fields.push({
      name: t("fields.summary"),
      value: alert.security_advisory.summary,
      inline: false,
    });
  }

  return buildMessage(
    {
      author,
      title: t("events.dependabot.title", { repo: repo ?? t("common.repository"), action: al }),
      url: alert.html_url,
      color: GITHUB_COLORS[colorKey],
      fields,
    },
    t,
    repo,
  );
}
