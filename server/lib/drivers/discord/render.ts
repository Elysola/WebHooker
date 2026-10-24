import type { FormattedMessage, NeutralActionStyle, NeutralMessage } from "../../types";
import {
  cap,
  MAX_DESCRIPTION,
  MAX_FIELDS,
  MAX_FIELD_VALUE,
  MAX_FOOTER,
  MAX_TITLE,
  splitMessageTitle,
} from "../../formatters/helpers";

/** Discord's cap on the combined characters of all embeds in a message. */
const MAX_EMBED_TOTAL = 6000;
/** Discord's caps on a button's custom_id and label. */
const MAX_CUSTOM_ID = 100;
const MAX_BUTTON_LABEL = 80;

type Embed = NonNullable<FormattedMessage["embeds"]>[number];

function embedLength(embed: Embed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.author?.name.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}

/** Description length kept before any field is given up. */
const MIN_DESCRIPTION = 1024;

/** Shorten the description by `over` characters (never below `floor`); returns what is left over. */
function shrinkDescription(embed: Embed, over: number, floor: number): number {
  const text = embed.description;
  if (!text || over <= 0 || text.length <= floor) return over;
  const keep = Math.max(floor, text.length - over - 1);
  embed.description = keep > 0 ? `${text.slice(0, keep)}…` : undefined;
  return over - (text.length - (embed.description?.length ?? 0));
}

/**
 * Fit an embed into the 6000-character total so the request is never
 * rejected whole: a long description shrinks first (down to 1024 characters),
 * then trailing fields are dropped, then the description shrinks further.
 */
function fitEmbed(embed: Embed): Embed {
  let over = embedLength(embed) - MAX_EMBED_TOTAL;
  if (over <= 0) return embed;
  const out: Embed = { ...embed, fields: embed.fields ? [...embed.fields] : undefined };
  over = shrinkDescription(out, over, MIN_DESCRIPTION);
  while (over > 0 && out.fields && out.fields.length > 0) {
    const f = out.fields.pop()!;
    over -= f.name.length + f.value.length;
  }
  shrinkDescription(out, over, 0);
  return out;
}

function toStyle(style: NeutralActionStyle): number {
  switch (style) {
    case "primary":
      return 3;
    case "danger":
      return 4;
    default:
      return 2;
  }
}

/**
 * Most roles one message mentions: well within Discord's 100 allowed-mention
 * roles and 2000 content characters (a mention takes at most 24 with its
 * space). Routes are validated against it; this is the safety net.
 */
export const MAX_ROLE_MENTIONS = 50;

export function renderNeutralMessage(message: NeutralMessage): FormattedMessage {
  const roleIds = [...new Set(message.mentionRoleIds ?? [])].slice(0, MAX_ROLE_MENTIONS);
  const content = roleIds.length ? roleIds.map((id) => `<@&${id}>`).join(" ") : undefined;

  // Discord embed titles can only be linked as a whole, so only the repo head
  // goes into the title (linked to the event's object URL); the `: subject`
  // text is rendered as the first line of the description, unlinked.
  const { head, subject } = splitMessageTitle(message.title);
  const rawDescription = subject
    ? message.description
      ? `${subject}\n${message.description}`
      : subject
    : (message.description ?? "");

  // Safety net: clamp every embed part to the Discord API limits so a single
  // oversized formatter or custom payload can never hard-fail the request.
  const footerText = cap(
    [message.forge?.name, message.footer].filter(Boolean).join(" · "),
    MAX_FOOTER,
  );
  // Buttons whose id would exceed Discord's limit (very long repo names) are
  // left out rather than failing the whole message.
  const actions = (message.actions ?? []).filter((a) => a.id.length <= MAX_CUSTOM_ID);
  return {
    content,
    // Only the route's own roles may ping — never @everyone, @here or users,
    // whatever text ends up in the message.
    allowed_mentions: { parse: [], roles: roleIds },
    embeds: [
      fitEmbed({
        title: cap(head, MAX_TITLE),
        url: message.url,
        color: message.color,
        description: cap(rawDescription, MAX_DESCRIPTION) || undefined,
        author: message.author
          ? {
              name: cap(message.author.name, MAX_TITLE),
              icon_url: message.author.iconUrl,
              url: message.author.url,
            }
          : undefined,
        fields: message.fields?.slice(0, MAX_FIELDS).map((f) => ({
          name: cap(f.name, MAX_TITLE),
          value: cap(f.value, MAX_FIELD_VALUE),
          inline: f.inline,
        })),
        footer: footerText ? { text: footerText, icon_url: message.forge?.iconUrl } : undefined,
        timestamp: message.timestamp,
      }),
    ],
    components: actions.length
      ? [
          {
            type: 1,
            components: actions.map((action) => ({
              type: 2,
              style: toStyle(action.style),
              label: cap(action.label, MAX_BUTTON_LABEL),
              custom_id: action.id,
            })),
          },
        ]
      : undefined,
  };
}
