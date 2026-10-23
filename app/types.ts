export type FilterType = "event" | "repo" | "actor" | "action" | "branch" | "keyword" | "field";

export type FilterOp =
  | "eq"
  | "ne"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "regex"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "exists";

export interface Filter {
  type: FilterType;
  match?: string | string[];
  exclude?: boolean;
  path?: string;
  op?: FilterOp;
}

export interface FilterAll {
  all: FilterNode[];
}

export interface FilterAny {
  any: FilterNode[];
}

export interface FilterNot {
  not: FilterNode;
}

export type FilterNode = Filter | FilterAll | FilterAny | FilterNot;

export interface NamedFragment {
  id: string;
  groupId?: string;
  name: string;
  node: FilterNode;
}

export interface RouteTarget {
  platform?: "discord" | "telegram" | "feishu";
  channelId?: string;
  threadId?: string;
  chatId?: string;
  topicId?: string;
}

export interface Route {
  id: string;
  name: string;
  enabled: boolean;
  filters: Filter[];
  targets: RouteTarget[];
  groupId?: string;
  fallback?: boolean;
  stop?: boolean;
  discordRoleIds?: string[];
  ast?: FilterNode;
}

export type GroupRole = "owner" | "admin" | "viewer";

export interface ForgeSource {
  host: string;
  type: "github" | "gitea";
  name?: string;
}

export interface GroupMember {
  login: string;
  role: GroupRole;
}

export interface Group {
  id: string;
  name: string;
  adminIds: string[];
  members?: GroupMember[];
  owners?: string[];
  providers?: ("github" | "gitea" | "gitlab")[];
  installationId?: number;
  /** Self-service group: only its own webhook ingress dispatches to it (super-only). */
  isolated?: boolean;
  /** Immutable server-assigned group identity (kept across renames). */
  instance?: string;
  /** Server revision of the stored group; sent back on update to detect stale edits. */
  revision?: string;
  emoji?: boolean;
  forgeSources?: ForgeSource[];
  lang?: string;
  logTarget?: RouteTarget;
}

export interface GroupInvite {
  token: string;
  groupId: string;
  role: "admin" | "viewer";
  expiresAt: number;
  createdBy: string;
  note?: string;
}

export interface AuditEntry {
  id?: number;
  ts: number;
  actorId?: string;
  actorLogin?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  groupId?: string;
  detail?: Record<string, unknown>;
  ip?: string;
}

export interface RouteTemplate {
  id: string;
  nameKey: string;
  filters: Filter[];
}

export const ROUTE_TEMPLATES: RouteTemplate[] = [
  {
    id: "push-events",
    nameKey: "templates.push",
    filters: [{ type: "event", match: "push" }],
  },
  {
    id: "pull-requests",
    nameKey: "templates.pullRequest",
    filters: [
      { type: "event", match: "pull_request" },
      { type: "action", match: ["opened", "synchronize", "reopened", "closed"] },
    ],
  },
  {
    id: "issues",
    nameKey: "templates.issues",
    filters: [
      { type: "event", match: "issues" },
      { type: "action", match: ["opened", "edited", "closed", "reopened"] },
    ],
  },
  {
    id: "releases",
    nameKey: "templates.release",
    filters: [
      { type: "event", match: "release" },
      { type: "action", match: ["published"] },
    ],
  },
  {
    id: "workflows",
    nameKey: "templates.workflow",
    filters: [{ type: "event", match: "workflow_run" }],
  },
  {
    id: "checks",
    nameKey: "templates.checks",
    filters: [{ type: "event", match: ["check_suite"] }],
  },
  {
    id: "deployments",
    nameKey: "templates.deployment",
    filters: [{ type: "event", match: "deployment" }],
  },
  {
    id: "comments",
    nameKey: "templates.comments",
    filters: [{ type: "event", match: ["issue_comment", "pull_request_review_comment"] }],
  },
  {
    id: "reviews",
    nameKey: "templates.reviews",
    filters: [{ type: "event", match: "pull_request_review" }],
  },
  {
    id: "star-fork",
    nameKey: "templates.starFork",
    filters: [{ type: "event", match: ["star", "fork"] }],
  },
  {
    id: "create-delete",
    nameKey: "templates.createDelete",
    filters: [{ type: "event", match: ["create", "delete"] }],
  },
  {
    id: "members",
    nameKey: "templates.member",
    filters: [{ type: "event", match: "member" }],
  },
  {
    id: "commit-comments",
    nameKey: "templates.commitComment",
    filters: [{ type: "event", match: "commit_comment" }],
  },
  {
    id: "custom-webhook",
    nameKey: "templates.customWebhook",
    filters: [{ type: "event", match: "custom" }],
  },
];

export interface FragmentPreset {
  id: string;
  nameKey: string;
  node: FilterNode;
}

export const FRAGMENT_PRESETS: FragmentPreset[] = [
  {
    id: "preset-pr-bot",
    nameKey: "fragmentPreset.prBot",
    node: {
      all: [
        { type: "event", match: "pull_request" },
        { type: "field", path: "pull_request.user.type", match: "Bot" },
      ],
    },
  },
  {
    id: "preset-dependabot",
    nameKey: "fragmentPreset.dependabot",
    node: {
      all: [
        { type: "event", match: "pull_request" },
        { type: "field", path: "pull_request.user.login", match: "dependabot[bot]" },
      ],
    },
  },
  {
    id: "preset-release-published",
    nameKey: "fragmentPreset.releasePublished",
    node: {
      all: [
        { type: "event", match: "release" },
        { type: "action", match: "published" },
      ],
    },
  },
  {
    id: "preset-push-main",
    nameKey: "fragmentPreset.pushMain",
    node: {
      all: [
        { type: "event", match: "push" },
        { type: "branch", match: "main" },
      ],
    },
  },
  {
    id: "preset-issue-bug",
    nameKey: "fragmentPreset.issueBug",
    node: {
      all: [
        { type: "event", match: "issues" },
        { type: "field", path: "issue.labels.name", match: "bug" },
      ],
    },
  },
];

export const FILTER_TYPES = [
  "event",
  "repo",
  "actor",
  "action",
  "branch",
  "keyword",
  "field",
] as const;

export const FILTER_OPS: FilterOp[] = [
  "eq",
  "ne",
  "contains",
  "startsWith",
  "endsWith",
  "regex",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "exists",
];

export function fmtMatch(match: string | string[] | undefined): string {
  if (Array.isArray(match)) return match.join(", ");
  return String(match ?? "");
}

export interface SendRecord {
  id?: number;
  ts: number;
  routeId: string;
  groupId?: string;
  event: string;
  repo?: string;
  target: string;
  ok: boolean;
  error?: string;
  status?: number;
  messageId?: string;
  deliveryId?: string;
  platform?: string;
  actor?: string;
  action?: string;
  durationMs?: number;
  errorCode?: string;
  attempts?: number;
  detail?: Record<string, unknown>;
}

export interface MetricsBreakdown {
  platform?: string;
  event?: string;
  total: number;
  ok: number;
  failed: number;
}

export interface MetricsStatus {
  status: string;
  count: number;
}

export interface DeliveryMetrics {
  total: number;
  ok: number;
  failed: number;
  failureRate: number;
  byPlatform: MetricsBreakdown[];
  byEvent: MetricsBreakdown[];
  byStatus: MetricsStatus[];
  avgDurationMs: number;
  totalAttempts: number;
  avgAttempts: number;
  recentFailures: SendRecord[];
}
