import * as v from "valibot";
import type { FilterNode, Group, Route } from "../types";
import { log } from "../lib/log";
import { explainFilterNode } from "../events/filter-ast";

export const CONFIG_SCHEMA_VERSION = 1;

export const filterSchema = v.object({
  type: v.picklist(["event", "repo", "actor", "action", "branch", "keyword", "field"]),
  match: v.optional(v.union([v.string(), v.array(v.string())])),
  exclude: v.optional(v.boolean()),
  path: v.optional(v.string()),
  op: v.optional(
    v.picklist([
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
    ]),
  ),
});

export const routeTargetSchema = v.object({
  platform: v.optional(v.picklist(["discord", "telegram", "feishu"])),
  channelId: v.optional(v.string()),
  threadId: v.optional(v.string()),
  chatId: v.optional(v.string()),
  topicId: v.optional(v.string()),
});

export const filterNodeSchema: v.GenericSchema<FilterNode> = v.lazy(() =>
  v.union([
    filterSchema,
    v.object({ all: v.array(filterNodeSchema) }),
    v.object({ any: v.array(filterNodeSchema) }),
    v.object({ not: filterNodeSchema }),
  ]),
);

export const routeSchema = v.object({
  id: v.string(),
  name: v.string(),
  enabled: v.boolean(),
  filters: v.array(filterSchema),
  targets: v.array(routeTargetSchema),
  groupId: v.optional(v.string()),
  fallback: v.optional(v.boolean()),
  stop: v.optional(v.boolean()),
  discordRoleIds: v.optional(v.array(v.string())),
  ast: v.optional(filterNodeSchema),
});

export const groupMemberSchema = v.object({
  login: v.string(),
  role: v.picklist(["owner", "admin", "viewer"]),
  userId: v.optional(v.string()),
});

export const forgeSourceSchema = v.object({
  host: v.string(),
  type: v.picklist(["github", "gitea"]),
  name: v.optional(v.string()),
});

export const groupSchema = v.object({
  id: v.string(),
  name: v.string(),
  adminIds: v.array(v.string()),
  members: v.optional(v.array(groupMemberSchema)),
  owners: v.optional(v.array(v.string())),
  providers: v.optional(v.array(v.picklist(["github", "gitea", "gitlab", "custom"]))),
  installationId: v.optional(v.number()),
  isolated: v.optional(v.boolean()),
  instance: v.optional(v.string()),
  instanceBackfilled: v.optional(v.boolean()),
  legacyId: v.optional(v.string()),
  webhookSecret: v.optional(v.nullable(v.string())),
  emoji: v.optional(v.boolean()),
  forgeSources: v.optional(v.array(forgeSourceSchema)),
  lang: v.optional(v.string()),
  logTarget: v.optional(routeTargetSchema),
});

export function migrateRoutes(routes: Route[]): Route[] {
  return routes.map((r) => {
    if (r.targets && r.targets.length > 0) return r;
    const legacy = (r as Route & { target?: Route["targets"][number] }).target;
    if (!legacy) return r;
    const { target: _target, ...rest } = r as Route & { target?: Route["targets"][number] };
    return { ...rest, targets: [legacy] };
  });
}

export function migrateGroups(groups: Group[]): Group[] {
  return groups;
}

export function validateRoutes(routes: Route[]): Route[] {
  for (const r of routes) {
    const result = v.safeParse(routeSchema, r);
    if (!result.success) {
      log.warn({ id: r?.id, issues: result.issues }, "Invalid route config");
    }
  }
  return routes;
}

export function validateGroups(groups: Group[]): Group[] {
  for (const g of groups) {
    const result = v.safeParse(groupSchema, g);
    if (!result.success) {
      log.warn({ id: g?.id, issues: result.issues }, "Invalid group config");
    }
  }
  return groups;
}

export function explainRoute(route: Route): string {
  const node = route.ast ?? { all: route.filters };
  return `${route.name}: ${explainFilterNode(node)}`;
}
