import type { FilterOp, FilterType } from "~/types";
import type { Locale } from "~/composables/useI18n";

/**
 * Suggestion catalog for the route filter editor. Event and action names come
 * from GitHub's official webhook definitions (`@octokit/webhooks`) plus the
 * extras Gitea sends (`modules/webhook/type.go`, `modules/structs/hook.go`) —
 * Gitea events arrive under their normalized names (see
 * `server/lib/providers/gitea/parse.ts`). Field paths and their values follow
 * the webhook payload schemas (`@octokit/openapi-webhooks-types`).
 *
 * Every entry carries an English and a Chinese description: the stored value
 * is always the English key, searching matches either language.
 */

interface Bilingual {
  en: string;
  zh: string;
}

/** A combobox suggestion: the stored English key plus localized context. */
export interface ComboOption {
  value: string;
  /** Description in the active locale, shown next to the value. */
  hint?: string;
  /** Text matched by search besides the value (descriptions in every language). */
  keywords?: string[];
  /** Localized group heading. */
  group?: string;
}

function toOption(value: string, label: Bilingual | undefined, locale: Locale): ComboOption {
  return label ? { value, hint: label[locale], keywords: [label.en, label.zh] } : { value };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const EVENT_LABELS: Record<string, Bilingual> = {
  push: { en: "Commits pushed to a branch or tag", zh: "推送提交到分支或标签" },
  pull_request: { en: "Pull request activity", zh: "拉取请求（PR）动态" },
  pull_request_review: { en: "Pull request review", zh: "PR 审查" },
  pull_request_review_comment: { en: "Comment on a pull request diff", zh: "PR 代码行评论" },
  issues: { en: "Issue activity", zh: "议题（Issue）动态" },
  issue_comment: { en: "Comment on an issue or pull request", zh: "议题或 PR 下的评论" },
  workflow_run: { en: "Actions workflow run", zh: "Actions 工作流运行" },
  workflow_job: { en: "Actions workflow job", zh: "Actions 工作流任务" },
  check_run: { en: "Check run", zh: "检查运行" },
  check_suite: { en: "Check suite", zh: "检查套件" },
  status: { en: "Commit status changed", zh: "提交状态变更" },
  deployment: { en: "Deployment created", zh: "创建部署" },
  deployment_status: { en: "Deployment status changed", zh: "部署状态变更" },
  release: { en: "Release activity", zh: "版本发布（Release）" },
  create: { en: "Branch or tag created", zh: "创建分支或标签" },
  delete: { en: "Branch or tag deleted", zh: "删除分支或标签" },
  star: { en: "Repository starred or unstarred", zh: "仓库被加星或取消星标" },
  fork: { en: "Repository forked", zh: "仓库被复刻" },
  commit_comment: { en: "Comment on a commit", zh: "提交评论" },
  member: { en: "Collaborator added, removed or changed", zh: "协作者增删或权限变更" },
  label: { en: "Label created, edited or deleted", zh: "标签的创建、编辑或删除" },
  milestone: { en: "Milestone activity", zh: "里程碑动态" },
  discussion: { en: "Discussion activity", zh: "讨论（Discussions）动态" },
  discussion_comment: { en: "Comment on a discussion", zh: "讨论评论" },
  repository: { en: "Repository created, renamed, archived…", zh: "仓库的创建、重命名、归档等" },
  code_scanning_alert: { en: "Code scanning alert", zh: "代码扫描告警" },
  dependabot_alert: { en: "Dependabot alert", zh: "Dependabot 依赖告警" },
  ping: { en: "Webhook test ping", zh: "Webhook 连通性测试" },
  custom: {
    en: "Custom webhook (X-WebHooker-Signature)",
    zh: "自定义 Webhook（X-WebHooker-Signature）",
  },
  branch_protection_configuration: {
    en: "Branch protection enabled or disabled",
    zh: "分支保护整体启用或停用",
  },
  branch_protection_rule: { en: "Branch protection rule changed", zh: "分支保护规则变更" },
  custom_property: { en: "Custom property definition changed", zh: "自定义属性定义变更" },
  custom_property_values: { en: "Custom property values updated", zh: "自定义属性值更新" },
  deploy_key: { en: "Deploy key added or removed", zh: "部署密钥增删" },
  deployment_protection_rule: {
    en: "Deployment protection rule requested",
    zh: "部署保护规则请求",
  },
  deployment_review: { en: "Deployment review", zh: "部署审批" },
  github_app_authorization: { en: "GitHub App authorization revoked", zh: "GitHub App 授权被撤销" },
  gollum: { en: "Wiki page created or updated", zh: "Wiki 页面创建或更新" },
  installation: { en: "GitHub App installation changed", zh: "GitHub App 安装变更" },
  installation_repositories: {
    en: "Repositories added to or removed from an installation",
    zh: "安装中仓库的增删",
  },
  installation_target: { en: "Installation account renamed", zh: "安装账号被重命名" },
  marketplace_purchase: { en: "Marketplace purchase changed", zh: "Marketplace 购买变更" },
  membership: { en: "Team membership changed", zh: "团队成员变更" },
  merge_group: { en: "Merge queue group", zh: "合并队列分组" },
  meta: { en: "Webhook deleted", zh: "Webhook 被删除" },
  org_block: { en: "User blocked or unblocked by an organization", zh: "组织拉黑或解除拉黑用户" },
  organization: { en: "Organization membership or settings changed", zh: "组织成员或设置变更" },
  package: { en: "Package published or updated", zh: "软件包发布或更新" },
  page_build: { en: "GitHub Pages build", zh: "GitHub Pages 构建" },
  personal_access_token_request: {
    en: "Fine-grained personal access token request",
    zh: "细粒度访问令牌申请",
  },
  project: { en: "Classic project changed", zh: "经典项目变更" },
  project_card: { en: "Classic project card changed", zh: "经典项目卡片变更" },
  project_column: { en: "Classic project column changed", zh: "经典项目列变更" },
  projects_v2: { en: "Project changed", zh: "项目（Projects）变更" },
  projects_v2_item: { en: "Project item changed", zh: "项目条目变更" },
  projects_v2_status_update: { en: "Project status update", zh: "项目状态更新" },
  public: { en: "Repository made public", zh: "仓库被设为公开" },
  pull_request_review_thread: {
    en: "Review thread resolved or unresolved",
    zh: "PR 审查会话被解决或重新打开",
  },
  registry_package: { en: "Registry package published or updated", zh: "注册表软件包发布或更新" },
  repository_advisory: { en: "Repository security advisory", zh: "仓库安全公告" },
  repository_dispatch: {
    en: "repository_dispatch (action = your event_type)",
    zh: "repository_dispatch（action 为自定义的 event_type）",
  },
  repository_import: { en: "Repository import finished", zh: "仓库导入完成" },
  repository_ruleset: { en: "Repository ruleset changed", zh: "仓库规则集变更" },
  repository_vulnerability_alert: {
    en: "Vulnerability alert (deprecated)",
    zh: "漏洞告警（已弃用）",
  },
  secret_scanning_alert: { en: "Secret scanning alert", zh: "密钥扫描告警" },
  secret_scanning_alert_location: {
    en: "New location of a secret scanning alert",
    zh: "密钥扫描告警的新位置",
  },
  secret_scanning_scan: { en: "Secret scanning scan completed", zh: "密钥扫描完成" },
  security_advisory: { en: "Global security advisory", zh: "全局安全公告" },
  security_and_analysis: { en: "Code security settings changed", zh: "代码安全设置变更" },
  sponsorship: { en: "Sponsorship changed", zh: "赞助变更" },
  sub_issues: { en: "Sub-issue added or removed", zh: "子议题增删" },
  team: { en: "Team changed", zh: "团队变更" },
  team_add: { en: "Repository added to a team", zh: "仓库被添加到团队" },
  watch: { en: "Repository starred (legacy watch event)", zh: "仓库被加星（旧版 watch 事件）" },
  workflow_dispatch: { en: "Workflow triggered manually", zh: "手动触发工作流" },
  pull_request_approved: { en: "Pull request approved (Gitea)", zh: "PR 审查通过（Gitea）" },
  pull_request_rejected: {
    en: "Pull request changes requested (Gitea)",
    zh: "PR 要求修改（Gitea）",
  },
  wiki: { en: "Wiki page created, edited or deleted (Gitea)", zh: "Wiki 页面增删改（Gitea）" },
};

/** Events with a dedicated WebHooker formatter (everything else uses the generic one). */
const FORMATTED_EVENTS = [
  "push",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issues",
  "issue_comment",
  "workflow_run",
  "workflow_job",
  "check_run",
  "check_suite",
  "status",
  "deployment",
  "deployment_status",
  "release",
  "create",
  "delete",
  "star",
  "fork",
  "commit_comment",
  "member",
  "label",
  "milestone",
  "discussion",
  "discussion_comment",
  "repository",
  "code_scanning_alert",
  "dependabot_alert",
  "ping",
  "custom",
];

/** Events only Gitea sends (after normalization). */
const GITEA_ONLY_EVENTS = ["pull_request_approved", "pull_request_rejected", "wiki"];

const EVENT_GROUPS: Record<"formatted" | "github" | "gitea", Bilingual> = {
  formatted: { en: "Formatted by WebHooker", zh: "WebHooker 已适配" },
  github: { en: "Other GitHub events", zh: "其他 GitHub 事件" },
  gitea: { en: "Gitea only", zh: "仅 Gitea" },
};

export function eventOptions(locale: Locale): ComboOption[] {
  const rest = Object.keys(EVENT_LABELS)
    .filter((e) => !FORMATTED_EVENTS.includes(e) && !GITEA_ONLY_EVENTS.includes(e))
    .sort();
  const section = (names: string[], group: Bilingual): ComboOption[] =>
    names.map((e) => ({ ...toOption(e, EVENT_LABELS[e], locale), group: group[locale] }));
  return [
    ...section(FORMATTED_EVENTS, EVENT_GROUPS.formatted),
    ...section(rest, EVENT_GROUPS.github),
    ...section(GITEA_ONLY_EVENTS, EVENT_GROUPS.gitea),
  ];
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Actions each event can carry: GitHub's plus the extra ones Gitea sends. */
const EVENT_ACTIONS: Record<string, string[]> = {
  branch_protection_configuration: ["disabled", "enabled"],
  branch_protection_rule: ["created", "deleted", "edited"],
  check_run: ["completed", "created", "requested_action", "rerequested"],
  check_suite: ["completed", "requested", "rerequested"],
  code_scanning_alert: [
    "appeared_in_branch",
    "closed_by_user",
    "created",
    "fixed",
    "reopened",
    "reopened_by_user",
  ],
  commit_comment: ["created"],
  custom_property: ["created", "deleted", "promote_to_enterprise", "updated"],
  custom_property_values: ["updated"],
  dependabot_alert: [
    "auto_dismissed",
    "auto_reopened",
    "created",
    "dismissed",
    "fixed",
    "reintroduced",
    "reopened",
  ],
  deploy_key: ["created", "deleted"],
  deployment: ["created"],
  deployment_protection_rule: ["requested"],
  deployment_review: ["approved", "rejected", "requested"],
  deployment_status: ["created"],
  discussion: [
    "answered",
    "category_changed",
    "closed",
    "created",
    "deleted",
    "edited",
    "labeled",
    "locked",
    "pinned",
    "reopened",
    "transferred",
    "unanswered",
    "unlabeled",
    "unlocked",
    "unpinned",
  ],
  discussion_comment: ["created", "deleted", "edited"],
  github_app_authorization: ["revoked"],
  installation: ["created", "deleted", "new_permissions_accepted", "suspend", "unsuspend"],
  installation_repositories: ["added", "removed"],
  installation_target: ["renamed"],
  issue_comment: ["created", "deleted", "edited"],
  issues: [
    "assigned",
    "closed",
    "deleted",
    "demilestoned",
    "edited",
    "labeled",
    "locked",
    "milestoned",
    "opened",
    "pinned",
    "reopened",
    "transferred",
    "typed",
    "unassigned",
    "unlabeled",
    "unlocked",
    "unpinned",
    "untyped",
    "label_updated",
    "label_cleared",
  ],
  label: ["created", "deleted", "edited"],
  marketplace_purchase: [
    "cancelled",
    "changed",
    "pending_change",
    "pending_change_cancelled",
    "purchased",
  ],
  member: ["added", "edited", "removed"],
  membership: ["added", "removed"],
  merge_group: ["checks_requested", "destroyed"],
  meta: ["deleted"],
  milestone: ["closed", "created", "deleted", "edited", "opened"],
  org_block: ["blocked", "unblocked"],
  organization: ["deleted", "member_added", "member_invited", "member_removed", "renamed"],
  package: ["published", "updated", "created", "deleted"],
  personal_access_token_request: ["approved", "cancelled", "created", "denied"],
  project: ["closed", "created", "deleted", "edited", "reopened"],
  project_card: ["converted", "created", "deleted", "edited", "moved"],
  project_column: ["created", "deleted", "edited", "moved"],
  projects_v2: ["closed", "created", "deleted", "edited", "reopened"],
  projects_v2_item: [
    "archived",
    "converted",
    "created",
    "deleted",
    "edited",
    "reordered",
    "restored",
  ],
  projects_v2_status_update: ["created", "deleted", "edited"],
  pull_request: [
    "assigned",
    "auto_merge_disabled",
    "auto_merge_enabled",
    "closed",
    "converted_to_draft",
    "demilestoned",
    "dequeued",
    "edited",
    "enqueued",
    "labeled",
    "locked",
    "milestoned",
    "opened",
    "ready_for_review",
    "reopened",
    "review_request_removed",
    "review_requested",
    "synchronize",
    "unassigned",
    "unlabeled",
    "unlocked",
    "label_updated",
    "label_cleared",
    "synchronized",
    "reviewed",
  ],
  pull_request_approved: ["reviewed"],
  pull_request_rejected: ["reviewed"],
  pull_request_review: ["dismissed", "edited", "submitted"],
  pull_request_review_comment: ["created", "deleted", "edited", "reviewed"],
  pull_request_review_thread: ["resolved", "unresolved"],
  registry_package: ["published", "updated"],
  release: [
    "created",
    "deleted",
    "edited",
    "prereleased",
    "published",
    "released",
    "unpublished",
    "updated",
  ],
  repository: [
    "archived",
    "created",
    "deleted",
    "edited",
    "privatized",
    "publicized",
    "renamed",
    "transferred",
    "unarchived",
  ],
  repository_advisory: ["published", "reported"],
  repository_ruleset: ["created", "deleted", "edited"],
  repository_vulnerability_alert: ["create", "dismiss", "reopen", "resolve"],
  secret_scanning_alert: ["created", "publicly_leaked", "reopened", "resolved", "validated"],
  secret_scanning_alert_location: ["created"],
  secret_scanning_scan: ["completed"],
  security_advisory: ["published", "updated", "withdrawn"],
  sponsorship: [
    "cancelled",
    "created",
    "edited",
    "pending_cancellation",
    "pending_tier_change",
    "tier_changed",
  ],
  star: ["created", "deleted"],
  sub_issues: [
    "parent_issue_added",
    "parent_issue_removed",
    "sub_issue_added",
    "sub_issue_removed",
  ],
  team: ["added_to_repository", "created", "deleted", "edited", "removed_from_repository"],
  watch: ["started"],
  wiki: ["created", "edited", "deleted"],
  workflow_job: ["completed", "in_progress", "queued", "waiting"],
  workflow_run: ["completed", "in_progress", "requested"],
};

const ACTION_LABELS: Record<string, Bilingual> = {
  added: { en: "Added", zh: "已添加" },
  added_to_repository: { en: "Added to a repository", zh: "添加到仓库" },
  answered: { en: "Answered", zh: "已解答" },
  appeared_in_branch: { en: "Appeared in a branch", zh: "出现在分支中" },
  approved: { en: "Approved", zh: "已批准" },
  archived: { en: "Archived", zh: "已归档" },
  assigned: { en: "Assigned", zh: "已指派" },
  auto_dismissed: { en: "Auto-dismissed", zh: "自动忽略" },
  auto_merge_disabled: { en: "Auto-merge disabled", zh: "关闭自动合并" },
  auto_merge_enabled: { en: "Auto-merge enabled", zh: "开启自动合并" },
  auto_reopened: { en: "Auto-reopened", zh: "自动重新打开" },
  blocked: { en: "Blocked", zh: "已拉黑" },
  cancelled: { en: "Cancelled", zh: "已取消" },
  category_changed: { en: "Category changed", zh: "分类变更" },
  changed: { en: "Changed", zh: "已变更" },
  checks_requested: { en: "Checks requested", zh: "请求检查" },
  closed: { en: "Closed", zh: "已关闭" },
  closed_by_user: { en: "Closed by a user", zh: "被用户关闭" },
  completed: { en: "Completed", zh: "已完成" },
  converted: { en: "Converted", zh: "已转换" },
  converted_to_draft: { en: "Converted to draft", zh: "转为草稿" },
  create: { en: "Created", zh: "已创建" },
  created: { en: "Created", zh: "已创建" },
  deleted: { en: "Deleted", zh: "已删除" },
  demilestoned: { en: "Removed from a milestone", zh: "移出里程碑" },
  denied: { en: "Denied", zh: "已拒绝" },
  dequeued: { en: "Removed from the merge queue", zh: "移出合并队列" },
  destroyed: { en: "Destroyed", zh: "已销毁" },
  dismiss: { en: "Dismissed", zh: "已忽略" },
  dismissed: { en: "Dismissed", zh: "已忽略" },
  edited: { en: "Edited", zh: "已编辑" },
  enabled: { en: "Enabled", zh: "已启用" },
  disabled: { en: "Disabled", zh: "已停用" },
  enqueued: { en: "Added to the merge queue", zh: "加入合并队列" },
  fixed: { en: "Fixed", zh: "已修复" },
  in_progress: { en: "In progress", zh: "进行中" },
  label_cleared: { en: "Labels cleared (Gitea)", zh: "清空标签（Gitea）" },
  label_updated: { en: "Labels updated (Gitea)", zh: "标签更新（Gitea）" },
  labeled: { en: "Label added", zh: "添加标签" },
  locked: { en: "Locked", zh: "已锁定" },
  member_added: { en: "Member added", zh: "成员加入" },
  member_invited: { en: "Member invited", zh: "成员受邀" },
  member_removed: { en: "Member removed", zh: "成员移除" },
  milestoned: { en: "Added to a milestone", zh: "加入里程碑" },
  moved: { en: "Moved", zh: "已移动" },
  new_permissions_accepted: { en: "New permissions accepted", zh: "接受新权限" },
  opened: { en: "Opened", zh: "已打开" },
  parent_issue_added: { en: "Parent issue added", zh: "添加父议题" },
  parent_issue_removed: { en: "Parent issue removed", zh: "移除父议题" },
  pending_cancellation: { en: "Pending cancellation", zh: "待取消" },
  pending_change: { en: "Pending change", zh: "待变更" },
  pending_change_cancelled: { en: "Pending change cancelled", zh: "待变更已取消" },
  pending_tier_change: { en: "Pending tier change", zh: "待变更档位" },
  pinned: { en: "Pinned", zh: "已置顶" },
  prereleased: { en: "Pre-released", zh: "发布预发行版" },
  privatized: { en: "Made private", zh: "设为私有" },
  promote_to_enterprise: { en: "Promoted to the enterprise", zh: "提升到企业级" },
  publicized: { en: "Made public", zh: "设为公开" },
  publicly_leaked: { en: "Publicly leaked", zh: "公开泄露" },
  published: { en: "Published", zh: "已发布" },
  purchased: { en: "Purchased", zh: "已购买" },
  queued: { en: "Queued", zh: "排队中" },
  ready_for_review: { en: "Ready for review", zh: "可供审查" },
  reintroduced: { en: "Reintroduced", zh: "重新引入" },
  rejected: { en: "Rejected", zh: "已拒绝" },
  released: { en: "Released", zh: "正式发布" },
  removed: { en: "Removed", zh: "已移除" },
  removed_from_repository: { en: "Removed from a repository", zh: "从仓库移除" },
  renamed: { en: "Renamed", zh: "已重命名" },
  reopen: { en: "Reopened", zh: "重新打开" },
  reopened: { en: "Reopened", zh: "重新打开" },
  reopened_by_user: { en: "Reopened by a user", zh: "被用户重新打开" },
  reordered: { en: "Reordered", zh: "调整顺序" },
  reported: { en: "Reported", zh: "已报告" },
  requested: { en: "Requested", zh: "已请求" },
  requested_action: { en: "Requested action", zh: "请求操作" },
  rerequested: { en: "Re-requested", zh: "重新请求" },
  resolve: { en: "Resolved", zh: "已解决" },
  resolved: { en: "Resolved", zh: "已解决" },
  restored: { en: "Restored", zh: "已恢复" },
  review_request_removed: { en: "Review request removed", zh: "撤回审查请求" },
  review_requested: { en: "Review requested", zh: "请求审查" },
  reviewed: { en: "Reviewed (Gitea)", zh: "已审查（Gitea）" },
  revoked: { en: "Revoked", zh: "已撤销" },
  started: { en: "Started", zh: "已加星" },
  sub_issue_added: { en: "Sub-issue added", zh: "添加子议题" },
  sub_issue_removed: { en: "Sub-issue removed", zh: "移除子议题" },
  submitted: { en: "Submitted", zh: "已提交" },
  suspend: { en: "Suspended", zh: "已暂停" },
  synchronize: { en: "New commits pushed", zh: "推送了新提交" },
  synchronized: { en: "New commits pushed (Gitea)", zh: "推送了新提交（Gitea）" },
  tier_changed: { en: "Tier changed", zh: "档位变更" },
  transferred: { en: "Transferred", zh: "已转移" },
  typed: { en: "Issue type set", zh: "设置议题类型" },
  unanswered: { en: "Unanswered", zh: "取消解答" },
  unarchived: { en: "Unarchived", zh: "取消归档" },
  unassigned: { en: "Unassigned", zh: "取消指派" },
  unblocked: { en: "Unblocked", zh: "解除拉黑" },
  unlabeled: { en: "Label removed", zh: "移除标签" },
  unlocked: { en: "Unlocked", zh: "已解锁" },
  unpinned: { en: "Unpinned", zh: "取消置顶" },
  unpublished: { en: "Unpublished", zh: "取消发布" },
  unresolved: { en: "Unresolved", zh: "重新打开" },
  unsuspend: { en: "Unsuspended", zh: "恢复" },
  untyped: { en: "Issue type removed", zh: "移除议题类型" },
  updated: { en: "Updated", zh: "已更新" },
  validated: { en: "Validated", zh: "已验证" },
  waiting: { en: "Waiting", zh: "等待中" },
  withdrawn: { en: "Withdrawn", zh: "已撤回" },
};

const ACTION_GROUPS: Record<"scoped" | "other", Bilingual> = {
  scoped: { en: "For the selected events", zh: "当前事件可用" },
  other: { en: "Other actions", zh: "其他动作" },
};

/**
 * Action suggestions. Actions of `events` (the route's own event filters) come
 * first; every other known action stays reachable below them. Each option is
 * also searchable by the events that send it.
 */
export function actionOptions(locale: Locale, events: string[]): ComboOption[] {
  const sentBy = new Map<string, string[]>();
  for (const [event, actions] of Object.entries(EVENT_ACTIONS)) {
    for (const action of actions) sentBy.set(action, [...(sentBy.get(action) ?? []), event]);
  }
  // Own keys only: a typed event name such as `constructor` is no catalog entry.
  const scoped = [
    ...new Set(events.flatMap((e) => (Object.hasOwn(EVENT_ACTIONS, e) ? EVENT_ACTIONS[e]! : []))),
  ];
  const rest = [...sentBy.keys()].filter((a) => !scoped.includes(a)).sort();
  const build = (actions: string[], group?: Bilingual): ComboOption[] =>
    actions.map((a) => {
      const opt = toOption(a, ACTION_LABELS[a], locale);
      return {
        ...opt,
        keywords: [...(opt.keywords ?? []), ...(sentBy.get(a) ?? [])],
        group: group?.[locale],
      };
    });
  if (!scoped.length) return build(rest);
  return [...build(scoped, ACTION_GROUPS.scoped), ...build(rest, ACTION_GROUPS.other)];
}

// ---------------------------------------------------------------------------
// Field paths and their values
// ---------------------------------------------------------------------------

const VALUE_LABELS: Record<string, Bilingual> = {
  true: { en: "Yes", zh: "是" },
  false: { en: "No", zh: "否" },
  open: { en: "Open", zh: "打开" },
  closed: { en: "Closed", zh: "已关闭" },
  success: { en: "Success", zh: "成功" },
  failure: { en: "Failure", zh: "失败" },
  neutral: { en: "Neutral", zh: "中性" },
  cancelled: { en: "Cancelled", zh: "已取消" },
  skipped: { en: "Skipped", zh: "已跳过" },
  timed_out: { en: "Timed out", zh: "超时" },
  action_required: { en: "Action required", zh: "需要操作" },
  stale: { en: "Stale", zh: "已过期" },
  startup_failure: { en: "Startup failure", zh: "启动失败" },
  queued: { en: "Queued", zh: "排队中" },
  in_progress: { en: "In progress", zh: "进行中" },
  completed: { en: "Completed", zh: "已完成" },
  waiting: { en: "Waiting", zh: "等待中" },
  requested: { en: "Requested", zh: "已请求" },
  pending: { en: "Pending", zh: "待处理" },
  error: { en: "Error", zh: "错误" },
  inactive: { en: "Inactive", zh: "已失效" },
  User: { en: "User", zh: "用户" },
  Bot: { en: "Bot", zh: "机器人" },
  Organization: { en: "Organization", zh: "组织" },
  public: { en: "Public", zh: "公开" },
  private: { en: "Private", zh: "私有" },
  internal: { en: "Internal", zh: "内部" },
  branch: { en: "Branch", zh: "分支" },
  tag: { en: "Tag", zh: "标签" },
  approved: { en: "Approved", zh: "已批准" },
  changes_requested: { en: "Changes requested", zh: "要求修改" },
  commented: { en: "Commented", zh: "仅评论" },
  dismissed: { en: "Dismissed", zh: "已忽略" },
  not_planned: { en: "Not planned", zh: "不计划处理" },
  reopened: { en: "Reopened", zh: "重新打开" },
  fixed: { en: "Fixed", zh: "已修复" },
  auto_dismissed: { en: "Auto-dismissed", zh: "自动忽略" },
  low: { en: "Low", zh: "低" },
  medium: { en: "Medium", zh: "中" },
  high: { en: "High", zh: "高" },
  critical: { en: "Critical", zh: "严重" },
  none: { en: "None", zh: "无" },
  note: { en: "Note", zh: "提示" },
  warning: { en: "Warning", zh: "警告" },
  push: { en: "Push", zh: "推送" },
  pull_request: { en: "Pull request", zh: "拉取请求" },
  pull_request_target: { en: "Pull request (target)", zh: "拉取请求（目标仓库）" },
  schedule: { en: "Schedule", zh: "定时" },
  workflow_dispatch: { en: "Manual trigger", zh: "手动触发" },
  workflow_run: { en: "Another workflow", zh: "其他工作流" },
  merge_group: { en: "Merge queue", zh: "合并队列" },
  release: { en: "Release", zh: "发布" },
  repository_dispatch: { en: "repository_dispatch", zh: "repository_dispatch" },
};

const BOOL = ["true", "false"];
const CONCLUSIONS = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
];
const RUN_STATUSES = ["queued", "in_progress", "completed", "waiting", "requested", "pending"];
const OPEN_CLOSED = ["open", "closed"];
const ACCOUNT_TYPES = ["User", "Bot", "Organization"];

interface FieldPath {
  path: string;
  label: Bilingual;
  /** Events whose payload carries the path; omitted = every event. */
  events?: string[];
  /** Known values of the path. */
  values?: string[];
  /**
   * The path ends on an array. The server compares that array as a whole
   * (arrays are only expanded along the path), so `contains` matches an element.
   */
  array?: boolean;
}

const PR_EVENTS = ["pull_request", "pull_request_review", "pull_request_review_comment"];
const ISSUE_EVENTS = ["issues", "issue_comment"];

const FIELD_PATHS: FieldPath[] = [
  { path: "sender.login", label: { en: "Sender login", zh: "触发者登录名" } },
  {
    path: "sender.type",
    label: { en: "Sender account type", zh: "触发者账号类型" },
    values: ACCOUNT_TYPES,
  },
  { path: "repository.full_name", label: { en: "Repository full name", zh: "仓库全名" } },
  { path: "repository.name", label: { en: "Repository name", zh: "仓库名" } },
  { path: "repository.owner.login", label: { en: "Repository owner", zh: "仓库所有者" } },
  {
    path: "repository.private",
    label: { en: "Repository is private", zh: "是否私有仓库" },
    values: BOOL,
  },
  {
    path: "repository.visibility",
    label: { en: "Repository visibility", zh: "仓库可见性" },
    values: ["public", "private", "internal"],
  },
  {
    path: "repository.fork",
    label: { en: "Repository is a fork", zh: "是否复刻仓库" },
    values: BOOL,
  },
  {
    path: "repository.archived",
    label: { en: "Repository is archived", zh: "是否已归档" },
    values: BOOL,
  },
  { path: "repository.default_branch", label: { en: "Default branch", zh: "默认分支" } },
  {
    path: "repository.topics",
    label: { en: "Repository topics (match with “contains”)", zh: "仓库主题（用“包含”匹配）" },
    array: true,
  },
  { path: "organization.login", label: { en: "Organization", zh: "组织" } },
  {
    path: "installation.id",
    label: { en: "GitHub App installation ID", zh: "GitHub App 安装 ID" },
  },
  {
    path: "ref",
    label: { en: "Ref (refs/heads/… for push)", zh: "引用（push 为 refs/heads/…）" },
    events: ["push", "create", "delete"],
  },
  { path: "forced", label: { en: "Force push", zh: "强制推送" }, events: ["push"], values: BOOL },
  {
    path: "created",
    label: { en: "Ref created by the push", zh: "推送新建了引用" },
    events: ["push"],
    values: BOOL,
  },
  {
    path: "deleted",
    label: { en: "Ref deleted by the push", zh: "推送删除了引用" },
    events: ["push"],
    values: BOOL,
  },
  {
    path: "head_commit.message",
    label: { en: "Head commit message", zh: "最新提交说明" },
    events: ["push"],
  },
  {
    path: "commits.message",
    label: { en: "Any commit message", zh: "任一提交说明" },
    events: ["push"],
  },
  {
    path: "commits.modified",
    label: { en: "Modified files (match with “contains”)", zh: "修改的文件（用“包含”匹配）" },
    events: ["push"],
    array: true,
  },
  {
    path: "commits.added",
    label: { en: "Added files (match with “contains”)", zh: "新增的文件（用“包含”匹配）" },
    events: ["push"],
    array: true,
  },
  {
    path: "commits.removed",
    label: { en: "Removed files (match with “contains”)", zh: "删除的文件（用“包含”匹配）" },
    events: ["push"],
    array: true,
  },
  { path: "pusher.name", label: { en: "Pusher name", zh: "推送者" }, events: ["push"] },
  {
    path: "ref_type",
    label: { en: "Ref type", zh: "引用类型" },
    events: ["create", "delete"],
    values: ["branch", "tag"],
  },
  { path: "pull_request.title", label: { en: "PR title", zh: "PR 标题" }, events: PR_EVENTS },
  {
    path: "pull_request.state",
    label: { en: "PR state", zh: "PR 状态" },
    events: PR_EVENTS,
    values: OPEN_CLOSED,
  },
  {
    path: "pull_request.draft",
    label: { en: "PR is a draft", zh: "PR 是否为草稿" },
    events: PR_EVENTS,
    values: BOOL,
  },
  {
    path: "pull_request.merged",
    label: { en: "PR was merged", zh: "PR 是否已合并" },
    events: PR_EVENTS,
    values: BOOL,
  },
  { path: "pull_request.user.login", label: { en: "PR author", zh: "PR 作者" }, events: PR_EVENTS },
  {
    path: "pull_request.user.type",
    label: { en: "PR author account type", zh: "PR 作者账号类型" },
    events: PR_EVENTS,
    values: ACCOUNT_TYPES,
  },
  {
    path: "pull_request.base.ref",
    label: { en: "PR target branch", zh: "PR 目标分支" },
    events: PR_EVENTS,
  },
  {
    path: "pull_request.head.ref",
    label: { en: "PR source branch", zh: "PR 源分支" },
    events: PR_EVENTS,
  },
  {
    path: "pull_request.labels.name",
    label: { en: "Any PR label", zh: "任一 PR 标签" },
    events: PR_EVENTS,
  },
  {
    path: "pull_request.requested_reviewers.login",
    label: { en: "Any requested reviewer", zh: "任一被请求的审查者" },
    events: PR_EVENTS,
  },
  {
    path: "pull_request.changed_files",
    label: { en: "Changed file count", zh: "变更文件数" },
    events: ["pull_request"],
  },
  {
    path: "pull_request.additions",
    label: { en: "Added line count", zh: "新增行数" },
    events: ["pull_request"],
  },
  {
    path: "review.state",
    label: { en: "Review state", zh: "审查结论" },
    events: ["pull_request_review"],
    values: ["approved", "changes_requested", "commented", "dismissed"],
  },
  {
    path: "review.user.login",
    label: { en: "Reviewer", zh: "审查者" },
    events: ["pull_request_review"],
  },
  {
    path: "label.name",
    label: { en: "Label added or removed", zh: "被添加或移除的标签" },
    events: ["issues", "pull_request", "label", "discussion"],
  },
  { path: "issue.title", label: { en: "Issue title", zh: "议题标题" }, events: ISSUE_EVENTS },
  {
    path: "issue.state",
    label: { en: "Issue state", zh: "议题状态" },
    events: ISSUE_EVENTS,
    values: OPEN_CLOSED,
  },
  {
    path: "issue.state_reason",
    label: { en: "Issue close reason", zh: "议题关闭原因" },
    events: ISSUE_EVENTS,
    values: ["completed", "not_planned", "reopened"],
  },
  {
    path: "issue.labels.name",
    label: { en: "Any issue label", zh: "任一议题标签" },
    events: ISSUE_EVENTS,
  },
  { path: "issue.user.login", label: { en: "Issue author", zh: "议题作者" }, events: ISSUE_EVENTS },
  {
    path: "issue.assignees.login",
    label: { en: "Any issue assignee", zh: "任一议题负责人" },
    events: ISSUE_EVENTS,
  },
  {
    path: "issue.milestone.title",
    label: { en: "Issue milestone", zh: "议题里程碑" },
    events: ISSUE_EVENTS,
  },
  {
    path: "issue.pull_request",
    label: { en: "Issue is a PR (use “exists”)", zh: "议题是 PR（配合“存在”）" },
    events: ["issue_comment"],
  },
  {
    path: "comment.body",
    label: { en: "Comment text", zh: "评论内容" },
    events: [
      "issue_comment",
      "pull_request_review_comment",
      "commit_comment",
      "discussion_comment",
    ],
  },
  {
    path: "comment.user.login",
    label: { en: "Comment author", zh: "评论者" },
    events: [
      "issue_comment",
      "pull_request_review_comment",
      "commit_comment",
      "discussion_comment",
    ],
  },
  {
    path: "workflow_run.name",
    label: { en: "Workflow name", zh: "工作流名称" },
    events: ["workflow_run"],
  },
  {
    path: "workflow_run.path",
    label: { en: "Workflow file", zh: "工作流文件" },
    events: ["workflow_run"],
  },
  {
    path: "workflow_run.conclusion",
    label: { en: "Workflow conclusion", zh: "工作流结论" },
    events: ["workflow_run"],
    values: CONCLUSIONS,
  },
  {
    path: "workflow_run.status",
    label: { en: "Workflow status", zh: "工作流状态" },
    events: ["workflow_run"],
    values: RUN_STATUSES,
  },
  {
    path: "workflow_run.event",
    label: { en: "Workflow trigger", zh: "工作流触发方式" },
    events: ["workflow_run"],
    values: [
      "push",
      "pull_request",
      "pull_request_target",
      "schedule",
      "workflow_dispatch",
      "workflow_run",
      "merge_group",
      "release",
      "repository_dispatch",
    ],
  },
  {
    path: "workflow_run.head_branch",
    label: { en: "Workflow branch", zh: "工作流分支" },
    events: ["workflow_run"],
  },
  {
    path: "workflow_run.actor.login",
    label: { en: "Workflow actor", zh: "工作流触发者" },
    events: ["workflow_run"],
  },
  {
    path: "workflow_run.run_attempt",
    label: { en: "Run attempt", zh: "运行次数" },
    events: ["workflow_run"],
  },
  {
    path: "workflow_job.name",
    label: { en: "Job name", zh: "任务名称" },
    events: ["workflow_job"],
  },
  {
    path: "workflow_job.workflow_name",
    label: { en: "Job workflow name", zh: "任务所属工作流" },
    events: ["workflow_job"],
  },
  {
    path: "workflow_job.conclusion",
    label: { en: "Job conclusion", zh: "任务结论" },
    events: ["workflow_job"],
    values: CONCLUSIONS,
  },
  {
    path: "workflow_job.status",
    label: { en: "Job status", zh: "任务状态" },
    events: ["workflow_job"],
    values: RUN_STATUSES,
  },
  {
    path: "workflow_job.labels",
    label: { en: "Runner labels (match with “contains”)", zh: "运行器标签（用“包含”匹配）" },
    events: ["workflow_job"],
    array: true,
  },
  { path: "check_run.name", label: { en: "Check name", zh: "检查名称" }, events: ["check_run"] },
  {
    path: "check_run.conclusion",
    label: { en: "Check conclusion", zh: "检查结论" },
    events: ["check_run"],
    values: CONCLUSIONS,
  },
  {
    path: "check_run.status",
    label: { en: "Check status", zh: "检查状态" },
    events: ["check_run"],
    values: RUN_STATUSES,
  },
  {
    path: "check_run.app.slug",
    label: { en: "Check app", zh: "检查所属应用" },
    events: ["check_run"],
  },
  {
    path: "check_suite.conclusion",
    label: { en: "Check suite conclusion", zh: "检查套件结论" },
    events: ["check_suite"],
    values: CONCLUSIONS,
  },
  {
    path: "check_suite.status",
    label: { en: "Check suite status", zh: "检查套件状态" },
    events: ["check_suite"],
    values: RUN_STATUSES,
  },
  {
    path: "check_suite.app.slug",
    label: { en: "Check suite app", zh: "检查套件所属应用" },
    events: ["check_suite"],
  },
  {
    path: "state",
    label: { en: "Commit status state", zh: "提交状态" },
    events: ["status"],
    values: ["pending", "success", "failure", "error"],
  },
  {
    path: "context",
    label: { en: "Commit status context", zh: "提交状态来源" },
    events: ["status"],
  },
  {
    path: "branches.name",
    label: { en: "Any branch containing the commit", zh: "任一包含该提交的分支" },
    events: ["status"],
  },
  { path: "release.tag_name", label: { en: "Release tag", zh: "发布标签" }, events: ["release"] },
  { path: "release.name", label: { en: "Release title", zh: "发布标题" }, events: ["release"] },
  {
    path: "release.prerelease",
    label: { en: "Is a pre-release", zh: "是否预发行版" },
    events: ["release"],
    values: BOOL,
  },
  {
    path: "release.draft",
    label: { en: "Is a draft release", zh: "是否草稿发布" },
    events: ["release"],
    values: BOOL,
  },
  {
    path: "deployment.environment",
    label: { en: "Deployment environment", zh: "部署环境" },
    events: ["deployment", "deployment_status"],
  },
  {
    path: "deployment.ref",
    label: { en: "Deployed ref", zh: "部署的引用" },
    events: ["deployment", "deployment_status"],
  },
  {
    path: "deployment_status.state",
    label: { en: "Deployment state", zh: "部署状态" },
    events: ["deployment_status"],
    values: ["queued", "in_progress", "pending", "success", "failure", "error", "inactive"],
  },
  {
    path: "alert.state",
    label: { en: "Dependabot alert state", zh: "Dependabot 告警状态" },
    events: ["dependabot_alert"],
    values: ["open", "dismissed", "fixed", "auto_dismissed"],
  },
  {
    path: "alert.security_advisory.severity",
    label: { en: "Dependabot advisory severity", zh: "Dependabot 公告严重程度" },
    events: ["dependabot_alert"],
    values: ["low", "medium", "high", "critical"],
  },
  {
    path: "alert.dependency.package.ecosystem",
    label: { en: "Dependency ecosystem", zh: "依赖生态" },
    events: ["dependabot_alert"],
  },
  {
    path: "alert.dependency.package.name",
    label: { en: "Dependency name", zh: "依赖包名" },
    events: ["dependabot_alert"],
  },
  {
    path: "alert.rule.severity",
    label: { en: "Code scanning rule severity", zh: "代码扫描规则严重程度" },
    events: ["code_scanning_alert"],
    values: ["none", "note", "warning", "error"],
  },
  {
    path: "alert.tool.name",
    label: { en: "Code scanning tool", zh: "代码扫描工具" },
    events: ["code_scanning_alert"],
  },
  {
    path: "discussion.category.name",
    label: { en: "Discussion category", zh: "讨论分类" },
    events: ["discussion", "discussion_comment"],
  },
  {
    path: "milestone.title",
    label: { en: "Milestone title", zh: "里程碑标题" },
    events: ["milestone"],
  },
  {
    path: "member.login",
    label: { en: "Collaborator login", zh: "协作者登录名" },
    events: ["member"],
  },
  {
    path: "forkee.full_name",
    label: { en: "Fork full name", zh: "复刻仓库全名" },
    events: ["fork"],
  },
];

const PATH_GROUPS: Record<"scoped" | "common" | "other", Bilingual> = {
  scoped: { en: "For the selected events", zh: "当前事件可用" },
  common: { en: "All events", zh: "所有事件通用" },
  other: { en: "Other events", zh: "其他事件" },
};

/**
 * Field path suggestions: paths of `events` first, then the ones every event
 * carries, then the rest. Each option is also searchable by its events.
 */
export function fieldPathOptions(locale: Locale, events: string[]): ComboOption[] {
  const scoped: ComboOption[] = [];
  const common: ComboOption[] = [];
  const other: ComboOption[] = [];
  for (const f of FIELD_PATHS) {
    const opt = toOption(f.path, f.label, locale);
    opt.keywords = [...(opt.keywords ?? []), ...(f.events ?? [])];
    if (!f.events) common.push({ ...opt, group: PATH_GROUPS.common[locale] });
    else if (f.events.some((e) => events.includes(e)))
      scoped.push({ ...opt, group: PATH_GROUPS.scoped[locale] });
    else other.push({ ...opt, group: PATH_GROUPS.other[locale] });
  }
  return [...scoped, ...common, ...other];
}

/** Whether a suggested path ends on an array (compared as a whole on the server). */
export function isArrayFieldPath(path: string): boolean {
  return FIELD_PATHS.some((f) => f.path === path.trim() && f.array);
}

/** Known values of a field path (empty when the path is free-form). */
export function fieldValueOptions(locale: Locale, path: string): ComboOption[] {
  const values = FIELD_PATHS.find((f) => f.path === path.trim())?.values ?? [];
  return values.map((v) => toOption(v, VALUE_LABELS[v], locale));
}

// ---------------------------------------------------------------------------
// Actors and branches
// ---------------------------------------------------------------------------

const ACTOR_SUGGESTIONS: Array<[string, Bilingual]> = [
  ["*[bot]", { en: "Any bot account", zh: "所有机器人账号" }],
  ["dependabot[bot]", { en: "Dependabot", zh: "Dependabot" }],
  ["github-actions[bot]", { en: "GitHub Actions", zh: "GitHub Actions" }],
  ["renovate[bot]", { en: "Renovate", zh: "Renovate" }],
];

const BRANCH_SUGGESTIONS: Array<[string, Bilingual]> = [
  ["main", { en: "Default branch", zh: "默认分支" }],
  ["master", { en: "Legacy default branch", zh: "旧版默认分支" }],
  ["develop", { en: "Development branch", zh: "开发分支" }],
  ["release/*", { en: "Any release/ branch", zh: "所有 release/ 分支" }],
];

/**
 * Glob suggestions adapted to the substring operators, which compare text
 * literally: each becomes the text the glob implies (`release/*` →
 * `release/` for startsWith, `*[bot]` → `[bot]` for endsWith) or is dropped.
 */
function suggestionsFor(
  list: Array<[string, Bilingual]>,
  op: FilterOp,
): Array<[string, Bilingual]> {
  if (op !== "contains" && op !== "startsWith" && op !== "endsWith") return list;
  return list.flatMap(([value, label]): Array<[string, Bilingual]> => {
    if (!isGlob(value)) return [[value, label]];
    const prefix = /^[^*?]+\*$/.test(value) ? value.slice(0, -1) : null;
    const suffix = /^\*[^*?]+$/.test(value) ? value.slice(1) : null;
    const literal = op === "startsWith" ? prefix : op === "endsWith" ? suffix : (prefix ?? suffix);
    return literal ? [[literal, label]] : [];
  });
}

/**
 * A suggestion as a raw pattern: metacharacters escaped
 * (`dependabot\[bot\]`), `*`/`?` globs turned into `.*`/`.`, anchored at the
 * ends the glob fixes (`^main$`, `^release/`, `\[bot\]$`).
 */
function suggestionRegex(value: string): string {
  const body = value
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return `^${body}$`.replace(/^\^\.\*/, "").replace(/\.\*\$$/, "") || ".*";
}

/** Value suggestions for a leaf of `type` and `op` (`path` and `events` add context). */
export function valueOptions(
  locale: Locale,
  type: FilterType,
  op: FilterOp,
  path: string,
  events: string[],
): ComboOption[] {
  const options = typeValueOptions(locale, type, op, path, events);
  // `regex` reads a raw pattern: offer each suggestion as the regex it means.
  if (op === "regex") return options.map((o) => ({ ...o, value: suggestionRegex(o.value) }));
  // Comparison operators need numbers, which no suggestion is.
  if (op === "gt" || op === "gte" || op === "lt" || op === "lte")
    return options.filter((o) => Number.isFinite(Number(o.value)));
  return options;
}

function typeValueOptions(
  locale: Locale,
  type: FilterType,
  op: FilterOp,
  path: string,
  events: string[],
): ComboOption[] {
  switch (type) {
    case "event":
      return eventOptions(locale);
    case "action":
      return actionOptions(locale, events);
    case "actor":
      return suggestionsFor(ACTOR_SUGGESTIONS, op).map(([v, label]) => toOption(v, label, locale));
    case "branch":
      return suggestionsFor(BRANCH_SUGGESTIONS, op).map(([v, label]) => toOption(v, label, locale));
    case "field":
      return fieldValueOptions(locale, path);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Validation (mirrors server/lib/events/filter-ast.ts)
// ---------------------------------------------------------------------------

/** Glob and regex patterns longer than this never match on the server. */
const MAX_PATTERN_LENGTH = 200;

function isWrappedRegex(value: string): boolean {
  return value.length >= 2 && value.startsWith("/") && value.endsWith("/");
}

/**
 * Length of the `/regex/` that `text` starts with: up to the first closing
 * `/` followed by a comma or the end of the text, or -1 while it is still
 * open. Escaped slashes (`\/`) and slashes in a character class (`[/,]`)
 * never close it.
 */
function wrappedRegexLength(text: string): number {
  if (!text.startsWith("/")) return -1;
  let inClass = false;
  for (let i = 1; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") i++;
    else if (inClass) inClass = char !== "]";
    else if (char === "[") inClass = true;
    else if (char === "/" && /^\s*(?:,|$)/.test(text.slice(i + 1))) return i + 1;
  }
  return -1;
}

/**
 * Split typed or pasted text into match values: one per line and, unless
 * `commas` is off (the raw `regex` operator), one per comma. A `/regex/`
 * keeps its own commas (`/v{1,3}/`, `/[/,]/`).
 */
export function splitFilterValues(text: string, commas = true): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!commas) {
      out.push(line);
      continue;
    }
    let rest = line.trimStart();
    while (rest) {
      const regexLength = wrappedRegexLength(rest);
      const token = regexLength > 0 ? rest.slice(0, regexLength) : rest.split(",", 1)[0]!;
      out.push(token);
      rest = rest.slice(token.length).replace(/^\s*,/, "").trimStart();
    }
  }
  return out.map((v) => v.trim()).filter(Boolean);
}

/**
 * Whether a comma typed over `text[start, end)` ends the value being typed —
 * only when typed at its end (no selection) and outside an open `/regex/`.
 * Anywhere else the comma is part of the text; raw patterns (`commas` off)
 * keep every comma.
 */
export function commaEndsValue(text: string, start: number, end: number, commas = true): boolean {
  if (!commas || start !== end || text.slice(end).trim()) return false;
  const value = text.slice(0, start).trim();
  return !value.startsWith("/") || wrappedRegexLength(value) === value.length;
}

function isGlob(value: string): boolean {
  return value.includes("*") || value.includes("?");
}

function regexError(source: string): string | null {
  if (source.length > MAX_PATTERN_LENGTH) return "valid.tooLong";
  try {
    new RegExp(source, "i");
    return null;
  } catch {
    return "valid.regex";
  }
}

/**
 * Whether `value` can be part of a git ref name, which never contains ASCII
 * spaces/control characters or `~ ^ : \ [ * ?` (other Unicode, whitespace
 * included, is legal). Glob operands keep `*`/`?` as wildcards; `[` is
 * literal for every operator.
 */
function canBeInRef(value: string, glob: boolean): boolean {
  const forbidden = glob ? /[~^:\\[]/ : /[~^:\\[*?]/;
  return (
    !forbidden.test(value) &&
    ![...value].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f)
  );
}

/**
 * Validate one match value of a leaf filter. Returns an i18n key describing
 * why the value can never match on the server, or null when it can. Rules
 * follow the server matcher: `regex` takes a raw pattern, numeric operators
 * need numbers, substring operators compare literally, and the default
 * operators accept `*`/`?` globs, `/regex/` or an exact (case-insensitive)
 * value. Only values that cannot occur are rejected (an event name with
 * spaces, a ref with characters git never allows) — never merely unusual
 * ones.
 */
export function validateFilterValue(type: FilterType, op: FilterOp, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (type !== "keyword") {
    if (op === "regex") return regexError(value);
    if (op === "gt" || op === "gte" || op === "lt" || op === "lte")
      return Number.isFinite(Number(value)) ? null : "valid.number";
    if (op === "exists") return null;
    // Substring operators compare literally: nothing is a glob or regex here.
    if (op === "contains" || op === "startsWith" || op === "endsWith")
      return type === "branch" && !canBeInRef(value, false) ? "valid.branchLiteral" : null;
  }
  if (isWrappedRegex(value)) return regexError(value.slice(1, -1));
  if (isGlob(value) && value.length > MAX_PATTERN_LENGTH) return "valid.tooLong";
  switch (type) {
    // Repository and actor values stay free-form: custom webhooks carry
    // arbitrary `repository.full_name` / `sender.login` strings.
    case "event":
      // Event names come from forge headers (snake_case) or are `custom`.
      return /^[a-z0-9_*?]+$/i.test(value) ? null : "valid.event";
    case "branch":
      // `refs/...` stays valid (code scanning alerts carry the full ref).
      return canBeInRef(value, true) ? null : "valid.branch";
    default:
      return null;
  }
}
