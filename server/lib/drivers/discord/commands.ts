import { log } from "../../lib/log";
import type { Env } from "../../types";

const DISCORD_API = "https://discord.com/api/v10";

const COMMAND_TYPE = { CHAT_INPUT: 1, MESSAGE: 3 } as const;
const OPTION_TYPE = { SUB_COMMAND: 1, SUB_COMMAND_GROUP: 2, STRING: 3 } as const;

export const MSG_CMD_ADD = "GitHub: 添加评论";
export const MSG_CMD_EDIT = "GitHub: 编辑评论";
export const MSG_CMD_DEL = "GitHub: 删除评论";

export const APP_COMMANDS = [
  {
    name: "gh",
    type: COMMAND_TYPE.CHAT_INPUT,
    description: "GitHub 集成",
    options: [
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "login",
        description: "绑定你的 GitHub 账号以用本人身份评论",
      },
      { type: OPTION_TYPE.SUB_COMMAND, name: "logout", description: "解绑你的 GitHub 账号" },
      {
        type: OPTION_TYPE.SUB_COMMAND_GROUP,
        name: "comment",
        description: "对 issue/PR 评论进行增删改",
        options: [
          {
            type: OPTION_TYPE.SUB_COMMAND,
            name: "add",
            description: "在 issue/PR 下新增评论",
            options: [
              {
                type: OPTION_TYPE.STRING,
                name: "link",
                description: "issue/PR 链接",
                required: true,
              },
            ],
          },
          {
            type: OPTION_TYPE.SUB_COMMAND,
            name: "edit",
            description: "编辑一条评论",
            options: [
              {
                type: OPTION_TYPE.STRING,
                name: "link",
                description: "评论链接（含 #issuecomment-）",
                required: true,
              },
            ],
          },
          {
            type: OPTION_TYPE.SUB_COMMAND,
            name: "del",
            description: "删除一条评论",
            options: [
              {
                type: OPTION_TYPE.STRING,
                name: "link",
                description: "评论链接（含 #issuecomment-）",
                required: true,
              },
            ],
          },
        ],
      },
    ],
  },
  { name: MSG_CMD_ADD, type: COMMAND_TYPE.MESSAGE },
  { name: MSG_CMD_EDIT, type: COMMAND_TYPE.MESSAGE },
  { name: MSG_CMD_DEL, type: COMMAND_TYPE.MESSAGE },
];

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Registration markers are kept per application (and guild) and hold the hash
 * of the command definitions last registered there: another application, or
 * definitions that differ from the registered ones — newer or rolled back —
 * register again instead of being skipped.
 */
function commandsHash(): Promise<string> {
  return shortHash(JSON.stringify(APP_COMMANDS));
}

const applicationIds = new Map<string, string>();

export async function getApplicationId(env: Env): Promise<string | null> {
  if (env.DISCORD_APPLICATION_ID) return env.DISCORD_APPLICATION_ID;
  const token = env.DISCORD_TOKEN ?? "";
  if (!token) return null;
  // Cached per bot token: a token of another application never gets the
  // id resolved for the previous one. Held in memory too (one KV read per
  // isolate, not one per sync run).
  const cacheKey = `config:discord-app-id:${await shortHash(token)}`;
  const known = applicationIds.get(cacheKey);
  if (known) return known;
  try {
    const cached = await env.KV.get(cacheKey);
    if (cached) {
      applicationIds.set(cacheKey, cached);
      return cached;
    }
  } catch {
    // fall through to the API
  }
  const res = await fetch(`${DISCORD_API}/oauth2/applications/@me`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    log.warn({ status: res.status }, "Failed to fetch Discord application id");
    return null;
  }
  const app = (await res.json()) as { id?: string };
  if (app.id) {
    try {
      applicationIds.set(cacheKey, app.id);
      await env.KV.put(cacheKey, app.id);
    } catch {
      // cache is best-effort
    }
    return app.id;
  }
  return null;
}

export async function registerGlobalCommands(env: Env): Promise<void> {
  const token = env.DISCORD_TOKEN ?? "";
  if (!token) return;
  const appId = await getApplicationId(env);
  if (!appId) return;
  const marker = `cmd:registered:global:${appId}`;
  const hash = await commandsHash();
  try {
    if ((await env.KV.get(marker)) === hash) return;
  } catch {
    // fall through and register
  }
  const res = await fetch(`${DISCORD_API}/applications/${appId}/commands`, {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(APP_COMMANDS),
  });
  if (res.ok) {
    try {
      await env.KV.put(marker, hash, { expirationTtl: 86400 });
    } catch {
      // best-effort
    }
    log.info("Registered global application commands");
  } else {
    const err = await res.text();
    log.warn({ status: res.status, err }, "Global command registration failed");
  }
}

const GUILD_PAGE_SIZE = 200;
/**
 * Discord calls one run makes for guild commands — pages listed and
 * registrations together — well within a Worker invocation's subrequest
 * limit (50 on the Free plan, shared with the run's other work). A run picks
 * up where the previous one stopped, so a bot in any number of guilds keeps
 * making progress.
 */
const GUILD_CALLS_PER_RUN = 30;

/** Per application: which guild holds which definitions, and where the walk is. */
interface GuildRecord {
  hashes: Record<string, string>;
  /** The guild after which the next run continues ("" from the start). */
  after: string;
}

export async function syncGuildCommands(env: Env): Promise<void> {
  const token = env.DISCORD_TOKEN ?? "";
  if (!token) return;
  const appId = await getApplicationId(env);
  if (!appId) return;
  const hash = await commandsHash();
  // One KV record per application, read and written once per run (not one
  // read per guild).
  const recordKey = `cmd:guilds:${appId}`;
  const stored = await env.KV.get<GuildRecord | Record<string, string>>(recordKey, "json").catch(
    () => null,
  );
  const record: GuildRecord =
    stored && typeof stored === "object" && "hashes" in stored
      ? {
          hashes: { ...(stored as GuildRecord).hashes },
          after: (stored as GuildRecord).after ?? "",
        }
      : { hashes: { ...((stored as Record<string, string> | null) ?? {}) }, after: "" };
  const startedAfter = record.after;
  let calls = GUILD_CALLS_PER_RUN;
  let changed = false;
  /** Stopped at a guild still to register: where to resume must be kept. */
  let pending = false;
  /** A guild needed registering this run (successful or not). */
  let attempted = false;
  walk: while (calls > 0) {
    calls--;
    const res = await fetch(
      `${DISCORD_API}/users/@me/guilds?limit=${GUILD_PAGE_SIZE}${record.after ? `&after=${record.after}` : ""}`,
      { headers: { Authorization: `Bot ${token}` } },
    );
    if (!res.ok) {
      const err = await res.text();
      log.warn({ status: res.status, err }, "Failed to list guilds");
      break;
    }
    const page = (await res.json()) as Array<{ id: string }>;
    for (const guild of page) {
      if (record.hashes[guild.id] !== hash) {
        attempted = true;
        // Out of calls: the next run resumes at this guild.
        if (calls <= 0) {
          pending = true;
          break walk;
        }
        calls--;
        try {
          const r = await fetch(
            `${DISCORD_API}/applications/${appId}/guilds/${guild.id}/commands`,
            {
              method: "PUT",
              headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify(APP_COMMANDS),
            },
          );
          if (r.ok) {
            record.hashes[guild.id] = hash;
            changed = true;
            log.info({ guildId: guild.id }, "Registered guild application commands");
          } else {
            const err = await r.text();
            log.warn({ guildId: guild.id, status: r.status, err }, "Command registration failed");
          }
        } catch (err) {
          log.warn({ guildId: guild.id, err: String(err) }, "Command registration failed");
        }
      }
      record.after = guild.id;
    }
    if (page.length < GUILD_PAGE_SIZE) {
      // The end of the list: the next run starts over (picking up guilds
      // joined meanwhile, and redoing ones whose registration failed).
      record.after = "";
      break;
    }
  }
  // Out of calls right after a full page, with work found on the way: the
  // walk must resume past it (or the guilds after it would never be reached).
  if (calls <= 0 && record.after !== "" && attempted) pending = true;
  // Written only when something changed — a registration, a walk stopped
  // with work left, or the cursor reset after one: a run that only checked
  // writes nothing (KV writes are scarce; this runs every few minutes).
  if (changed || pending || (record.after === "" && startedAfter !== "")) {
    await env.KV.put(recordKey, JSON.stringify(record)).catch((err: unknown) =>
      log.warn({ err: String(err) }, "Failed to record guild command registrations"),
    );
  }
}

export async function syncCommands(env: Env): Promise<void> {
  if (!env.DISCORD_TOKEN) return;
  await registerGlobalCommands(env);
  await syncGuildCommands(env);
}
