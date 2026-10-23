import type { NeutralMessage, NeutralAuthor } from "../types";
import { GITHUB_COLORS } from "./colors";
import {
  branchLink,
  emojiPrefix,
  MAX_COMMIT_SUBJECT,
  refUrl,
  tagLink,
  type T,
  buildMessage,
  repoBaseUrl,
  shortRef,
} from "./helpers";

export function formatPush(
  payload: Record<string, unknown>,
  repo: string | undefined,
  author: NeutralAuthor,
  t: T,
  showEmoji: boolean,
): NeutralMessage {
  const rawRef = (payload.ref as string) ?? "";
  const isTagPush = rawRef.startsWith("refs/tags/");
  // One prefix, read once: a branch may itself be named `refs/tags/x`.
  const ref = rawRef.startsWith("refs/tags/") ? `tag: ${shortRef(rawRef)}` : shortRef(rawRef);
  const commits = (payload.commits ?? []) as Array<{
    id?: string;
    message?: string;
    author?: { name?: string; email?: string; username?: string };
    added?: string[];
    removed?: string[];
    modified?: string[];
  }>;
  const count = commits.length;
  const compareUrl = payload.compare as string | undefined;
  const baseUrl = repoBaseUrl(payload, repo);
  const forced = payload.forced as boolean | undefined;
  const created = payload.created as boolean | undefined;
  const deleted = payload.deleted as boolean | undefined;
  const pusher = (payload.pusher as { name?: string } | undefined)?.name;
  const em = (e: string): string => emojiPrefix(e, showEmoji);

  // A branch/tag deletion pushed via `git push --delete` arrives as a push
  // event with `deleted: true` and no commits — render it like the `delete`
  // event instead of a confusing "0 commits pushed".
  if (deleted) {
    const refType = isTagPush ? "tag" : "branch";
    return buildMessage(
      {
        author,
        title: t("events.delete.title", {
          repo: repo ?? t("common.repository"),
          emoji: em(isTagPush ? "🏷️" : "🌿"),
          type: refType,
          ref,
        }),
        url: refUrl(baseUrl, shortRef(rawRef), refType),
        color: GITHUB_COLORS.delete,
      },
      t,
      repo,
    );
  }

  // A newly-created branch/tag pushed via `git push` arrives as a push event
  // with `created: true` and no commits — render it like the `create` event
  // instead of a confusing "0 commits pushed".
  if (created && count === 0) {
    const refType = isTagPush ? "tag" : "branch";
    const cleanRef = shortRef(rawRef);
    return buildMessage(
      {
        author,
        title: t("events.create.title", {
          repo: repo ?? t("common.repository"),
          emoji: em(isTagPush ? "🏷️" : "🌿"),
          type: refType,
          ref: cleanRef,
        }),
        url: refUrl(baseUrl, shortRef(rawRef), refType),
        color: GITHUB_COLORS.create,
      },
      t,
      repo,
    );
  }

  const descLines: string[] = [];

  if (forced) {
    descLines.push(em("⚠️") + t("events.push.force_push"));
  }
  if (created) {
    descLines.push(
      em("🆕") + t(isTagPush ? "events.push.tag_created" : "events.push.branch_created"),
    );
  }

  const commitsToShow = count <= 5 ? commits : commits.slice(0, 3);
  for (const c of commitsToShow) {
    const shortId = c.id?.slice(0, 7) ?? "???????";
    let msg =
      (c.message?.split("\n")[0] ?? "").slice(0, MAX_COMMIT_SUBJECT) || t("common.no_message");
    const commitAuthor = c.author?.username;
    const commitAuthorName = c.author?.name;
    if (commitAuthor && commitAuthor.toLowerCase() !== pusher?.toLowerCase()) {
      if (commitAuthor === "invalid-email-address") {
        if (commitAuthorName) msg += ` - ${commitAuthorName}`;
      } else {
        msg += ` - [${commitAuthor}](https://github.com/${encodeURIComponent(commitAuthor)})`;
      }
    }
    const url = baseUrl && c.id ? `${baseUrl}/commit/${c.id}` : null;
    const hash = url ? `[\`${shortId}\`](${url})` : `\`${shortId}\``;
    descLines.push(`${hash} ${msg}`);
  }
  if (count > 5) {
    descLines.push(t("common.and_n_more", { count: count - 3 }));
  }

  const added = commits.flatMap((c) => c.added ?? []);
  const removed = commits.flatMap((c) => c.removed ?? []);
  const modified = commits.flatMap((c) => c.modified ?? []);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  const changeParts: string[] = [];
  if (added.length > 0) changeParts.push(t("events.push.added", { count: added.length }));
  if (removed.length > 0) changeParts.push(t("events.push.removed", { count: removed.length }));
  if (modified.length > 0) changeParts.push(t("events.push.modified", { count: modified.length }));

  let changesValue = "";
  if (compareUrl) {
    changesValue = t("events.push.view_comparison", { url: compareUrl });
    if (changeParts.length > 0) {
      changesValue += " " + changeParts.join(" | ");
    }
  } else if (changeParts.length > 0) {
    changesValue = changeParts.join(" | ");
  }

  if (changesValue) {
    fields.push({
      name: t("fields.changes"),
      value: changesValue,
      inline: false,
    });
  }

  return buildMessage(
    {
      author,
      title: t("events.push.title", {
        count,
        s: count !== 1 ? "s" : "",
        repo: repo ?? t("common.repository"),
        ref: isTagPush
          ? tagLink(baseUrl, shortRef(rawRef), ref)
          : branchLink(baseUrl, shortRef(rawRef), ref),
      }),
      url: compareUrl,
      color: GITHUB_COLORS.push,
      description: descLines.join("\n"),
      fields: fields.length > 0 ? fields : undefined,
    },
    t,
    repo,
  );
}
