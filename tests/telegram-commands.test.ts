import { describe, it, expect, afterEach } from "bun:test";
import { handleTelegramUpdate } from "../server/lib/drivers/telegram/commands";
import { handleTelegramWebhookRequest } from "../server/lib/drivers/telegram/updates";
import type { Env } from "../server/lib/types";

function mockFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    Promise.resolve(handler(String(input), init));
}

const restoredFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = restoredFetch;
});

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [] }),
  } as unknown as KVNamespace;
}

function createMockDB(): D1Database {
  const links = new Map<string, string>();
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async (): Promise<{ success: boolean }> => {
          const m = sql.match(
            /INSERT OR REPLACE INTO telegram_links \(telegram_user_id, github_user_id\) VALUES \(\?, \?\)/,
          );
          if (m) links.set(String(args[0]), String(args[1]));
          const del = sql.match(/DELETE FROM telegram_links WHERE telegram_user_id = \?/);
          if (del) links.delete(String(args[0]));
          return { success: true };
        },
        all: async (): Promise<{ results: Array<Record<string, unknown>> }> => {
          const sel = sql.match(
            /SELECT github_user_id FROM telegram_links WHERE telegram_user_id = \?/,
          );
          if (sel) {
            const val = links.get(String(args[0]));
            return { results: val ? [{ github_user_id: val }] : [] };
          }
          return { results: [] };
        },
        first: async () => null,
      }),
    }),
  } as unknown as D1Database;
}

function createEnv(): Env {
  return {
    GITHUB_WEBHOOK_SECRET: "secret",
    GITHUB_CLIENT_ID: "client-id",
    TELEGRAM_TOKEN: "tg-token",
    TELEGRAM_WEBHOOK_SECRET: "wh-secret",
    KV: createMockKV(),
    DB: createMockDB(),
  } as Env;
}

function reply(chatId: string, topicId?: number): Record<string, unknown> {
  return {
    message_id: 1,
    from: { id: 111, first_name: "Rhen" },
    chat: { id: chatId, type: "supergroup" },
    message_thread_id: topicId,
  };
}

describe("telegram-commands /gh login", () => {
  it("only hands out the OAuth link in the private chat", async () => {
    let sentBody: Record<string, unknown> | undefined;
    mockFetch((_url, init) => {
      sentBody = JSON.parse(String(init!.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });

    const env = createEnv();
    await handleTelegramUpdate(env, {
      message: { ...reply("-100123"), text: "/gh login" },
    });
    expect(sentBody?.chat_id).toBe("-100123");
    expect(String(sentBody?.text)).not.toContain("github.com/login/oauth/authorize");

    await handleTelegramUpdate(env, {
      message: {
        ...reply("42"),
        chat: { id: 42, type: "private" },
        text: "/gh login",
      },
    });
    expect(sentBody?.chat_id).toBe("42");
    expect(String(sentBody?.text)).toContain("github.com/login/oauth/authorize");
  });

  it("runs a redelivered update only once", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    const env = createEnv();
    const update = { update_id: 99, message: { ...reply("-100123"), text: "/gh logout" } };
    await handleTelegramUpdate(env, update);
    await handleTelegramUpdate(env, update);
    expect(calls).toBe(1);
  });
});

describe("telegram-commands /gh logout", () => {
  it("replies bound/unbound message", async () => {
    let sentText = "";
    mockFetch((_url, init) => {
      sentText = String((JSON.parse(String(init!.body)) as Record<string, unknown>).text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });

    const env = createEnv();
    await handleTelegramUpdate(env, {
      message: { ...reply("-100123"), text: "/gh logout" },
    });

    expect(sentText).toContain("已解绑");
  });
});

describe("telegram-commands /gh comment", () => {
  it("replies when no reply_to_message link present", async () => {
    let sentText = "";
    mockFetch((_url, init) => {
      sentText = String((JSON.parse(String(init!.body)) as Record<string, unknown>).text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });

    const env = createEnv();
    await handleTelegramUpdate(env, {
      message: { ...reply("-100123"), text: "/gh comment hello" },
    });

    expect(sentText).toContain("还没有绑定");
  });

  it("parses the replied-to GitHub link as target", async () => {
    const env = createEnv();
    const { saveTelegramLink } = await import("../server/lib/github/store");
    await saveTelegramLink(env.DB, "111", "111980217");
    await env.KV.put(
      "token:111980217",
      JSON.stringify({
        userId: "111980217",
        accessToken: "ghu_test",
        expiresAt: Date.now() + 3600_000,
      }),
    );

    const calls: Array<{ url: string; body: string }> = [];
    mockFetch((url, init) => {
      calls.push({ url, body: String(init!.body) });
      if (String(url).endsWith("/sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ html_url: "https://github.com/acme/widget/issues/7#issuecomment-9" }),
        { status: 200 },
      );
    });

    await handleTelegramUpdate(env, {
      message: {
        ...reply("-100123"),
        text: "/gh comment hello",
        reply_to_message: {
          ...reply("-100123"),
          text: "acme/widget#7: Add feature",
          entities: [{ type: "text_link", url: "https://github.com/acme/widget/issues/7" }],
        },
      },
    });

    const ghCall = calls.find((c) => c.url.includes("/repos/"));
    expect(ghCall).toBeDefined();
    expect(ghCall!.url).toContain("/repos/acme/widget/issues/7/comments");
    const ghBody = JSON.parse(ghCall!.body) as Record<string, unknown>;
    expect(ghBody.body).toBe("hello");
  });
});

describe("telegram-updates webhook", () => {
  it("rejects requests without the secret token", async () => {
    const env = createEnv();
    const res = await handleTelegramWebhookRequest(
      new Request("https://example.com/telegram/webhook", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("accepts requests with the correct secret token", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    );
    const env = createEnv();
    const res = await handleTelegramWebhookRequest(
      new Request("https://example.com/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-secret" },
        body: JSON.stringify({ update_id: 1 }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("telegram-commands addressed by bot name", () => {
  it("runs `/gh@ThisBot` and ignores a command addressed to another bot", async () => {
    const sent: string[] = [];
    mockFetch((url, init) => {
      if (url.endsWith("/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { username: "ReviewBot" } }), {
          status: 200,
        });
      }
      sent.push(String((JSON.parse(String(init!.body)) as Record<string, unknown>).text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    const env = createEnv();
    await handleTelegramUpdate(env, {
      message: { ...reply("-100123"), text: "/gh@reviewbot logout" },
    });
    expect(sent).toHaveLength(1);
    await handleTelegramUpdate(env, {
      message: { ...reply("-100123"), text: "/gh@OtherBot logout" },
    });
    expect(sent).toHaveLength(1);
  });
});

describe("telegram-commands replies", () => {
  it("gives an update back when its reply could not be sent", async () => {
    let sends = 0;
    mockFetch(() => {
      sends++;
      return new Response(JSON.stringify({ ok: false, description: "Bad Gateway" }), {
        status: 502,
      });
    });
    const env = createEnv();
    const update = {
      update_id: 501,
      message: { ...reply("42"), chat: { id: 42, type: "private" }, text: "/gh login" },
    };
    await expect(handleTelegramUpdate(env, update)).rejects.toThrow();
    mockFetch(() => {
      sends++;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    // Telegram's redelivery runs it again: the link is sent this time.
    await handleTelegramUpdate(env, update);
    expect(sends).toBeGreaterThan(1);
  });

  it("keeps a comment's line breaks and indentation", async () => {
    const env = createEnv();
    const { saveTelegramLink } = await import("../server/lib/github/store");
    await saveTelegramLink(env.DB, "111", "111980217");
    await env.KV.put(
      "token:111980217",
      JSON.stringify({
        userId: "111980217",
        accessToken: "ghu_test",
        expiresAt: Date.now() + 3600_000,
      }),
    );
    const calls: Array<{ url: string; body: string }> = [];
    mockFetch((url, init) => {
      calls.push({ url, body: String(init!.body) });
      if (String(url).endsWith("/sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ html_url: "https://github.com/acme/widget/issues/7#issuecomment-9" }),
        { status: 200 },
      );
    });
    await handleTelegramUpdate(env, {
      message: {
        ...reply("-100123"),
        text: "/gh comment first line\n  indented\n\n- item",
        reply_to_message: {
          ...reply("-100123"),
          text: "acme/widget#7: Add feature",
          entities: [{ type: "text_link", url: "https://github.com/acme/widget/issues/7" }],
        },
      },
    });
    const ghCall = calls.find((c) => c.url.includes("/repos/"));
    expect((JSON.parse(ghCall!.body) as { body: string }).body).toBe(
      "first line\n  indented\n\n- item",
    );
  });
});

describe("telegram-commands refusals and whitespace", () => {
  it("gives back a command GitHub never ran when its error reply fails", async () => {
    const env = createEnv();
    const { saveTelegramLink } = await import("../server/lib/github/store");
    // Linked, but no token: refused before any GitHub request.
    await saveTelegramLink(env.DB, "111", "111980217");
    let replies = 0;
    let github = 0;
    mockFetch((url) => {
      if (new URL(url).hostname === "api.github.com") github++;
      replies++;
      return new Response(JSON.stringify({ ok: false, description: "Bad Gateway" }), {
        status: 502,
      });
    });
    const update = {
      update_id: 777,
      message: {
        ...reply("-100123"),
        text: "/gh comment hello",
        reply_to_message: {
          ...reply("-100123"),
          text: "acme/widget#7: Add feature",
          entities: [{ type: "text_link", url: "https://github.com/acme/widget/issues/7" }],
        },
      },
    };
    await expect(handleTelegramUpdate(env, update)).rejects.toThrow();
    // Not confirmed: the redelivery runs it (and replies) again.
    await expect(handleTelegramUpdate(env, update)).rejects.toThrow();
    expect(github).toBe(0);
    expect(replies).toBeGreaterThan(1);
  });

  it("keeps an indented first line of a comment", async () => {
    const env = createEnv();
    const { saveTelegramLink } = await import("../server/lib/github/store");
    await saveTelegramLink(env.DB, "111", "111980217");
    await env.KV.put(
      "token:111980217",
      JSON.stringify({
        userId: "111980217",
        accessToken: "ghu_test",
        expiresAt: Date.now() + 3600_000,
      }),
    );
    const calls: Array<{ url: string; body: string }> = [];
    mockFetch((url, init) => {
      calls.push({ url, body: String(init!.body) });
      if (String(url).endsWith("/sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ html_url: "https://github.com/acme/widget/issues/7#issuecomment-9" }),
        { status: 200 },
      );
    });
    await handleTelegramUpdate(env, {
      message: {
        ...reply("-100123"),
        text: "/gh comment\n    code()",
        reply_to_message: {
          ...reply("-100123"),
          text: "acme/widget#7: Add feature",
          entities: [{ type: "text_link", url: "https://github.com/acme/widget/issues/7" }],
        },
      },
    });
    const ghCall = calls.find((c) => c.url.includes("/repos/"));
    expect((JSON.parse(ghCall!.body) as { body: string }).body).toBe("    code()");
  });
});

describe("telegram-commands done before the write", () => {
  it("records the command as done before GitHub is written to", async () => {
    const env = createEnv();
    const { saveTelegramLink } = await import("../server/lib/github/store");
    await saveTelegramLink(env.DB, "111", "111980217");
    await env.KV.put(
      "token:111980217",
      JSON.stringify({
        userId: "111980217",
        accessToken: "ghu_test",
        expiresAt: Date.now() + 3600_000,
      }),
    );
    let doneAtWrite: unknown = "unset";
    // Storage touches of the "done" record (each is a quota operation).
    let doneTouches = 0;
    const kvGet = env.KV.get.bind(env.KV);
    env.KV.get = (async (key: string, ...rest: unknown[]) => {
      if (key === "accepted:bot:telegram:tg-token:888") doneTouches++;
      return (kvGet as (...a: unknown[]) => Promise<unknown>)(key, ...rest);
    }) as KVNamespace["get"];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      if (url.includes("/comments") && method === "POST") {
        doneAtWrite = await kvGet("accepted:bot:telegram:tg-token:888");
      }
      if (url.endsWith("/sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          login: "a",
          html_url: "https://github.com/acme/widget/issues/7#issuecomment-9",
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    await handleTelegramUpdate(env, {
      update_id: 888,
      message: {
        ...reply("-100123"),
        text: "/gh comment hello",
        reply_to_message: {
          ...reply("-100123"),
          text: "acme/widget#7: Add feature",
          entities: [{ type: "text_link", url: "https://github.com/acme/widget/issues/7" }],
        },
      },
    });
    // A lost confirmation afterwards can no longer let a redelivery write again.
    expect(doneAtWrite).not.toBeNull();
    expect(doneAtWrite).not.toBe("unset");
    // Written once, before the write — not confirmed a second time after it
    // (which would touch the record once more).
    expect(doneTouches).toBe(3);
  });
});

describe("telegram-commands outlived claims", () => {
  it("writes nothing once another run finished the same update", async () => {
    const env = createEnv();
    const { saveTelegramLink } = await import("../server/lib/github/store");
    await saveTelegramLink(env.DB, "111", "111980217");
    await env.KV.put(
      "token:111980217",
      JSON.stringify({
        userId: "111980217",
        accessToken: "ghu_test",
        expiresAt: Date.now() + 3600_000,
      }),
    );
    let posted = 0;
    // Meanwhile (this run outlived its claim, reading its token) another run
    // finished it.
    const kvGet = env.KV.get.bind(env.KV);
    env.KV.get = (async (key: string, ...rest: unknown[]) => {
      if (key === "token:111980217")
        await env.KV.put("accepted:bot:telegram:tg-token:999", "other-run");
      return (kvGet as (...a: unknown[]) => Promise<unknown>)(key, ...rest);
    }) as KVNamespace["get"];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      if (url.includes("/comments") && method === "POST") posted++;
      if (url.endsWith("/sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          login: "a",
          html_url: "https://github.com/acme/widget/issues/7#issuecomment-9",
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    await handleTelegramUpdate(env, {
      update_id: 999,
      message: {
        ...reply("-100123"),
        text: "/gh comment hello",
        reply_to_message: {
          ...reply("-100123"),
          text: "acme/widget#7: Add feature",
          entities: [{ type: "text_link", url: "https://github.com/acme/widget/issues/7" }],
        },
      },
    });
    expect(posted).toBe(0);
    // The other run's "done" stays.
    expect(await env.KV.get("accepted:bot:telegram:tg-token:999")).toBe("other-run");
  });
});

describe("telegram-commands foreign done markers", () => {
  it("never gives back a done another run wrote, even when its own read failed", async () => {
    const env = createEnv();
    const { saveTelegramLink } = await import("../server/lib/github/store");
    await saveTelegramLink(env.DB, "111", "111980217");
    await env.KV.put(
      "token:111980217",
      JSON.stringify({
        userId: "111980217",
        accessToken: "ghu_test",
        expiresAt: Date.now() + 3600_000,
      }),
    );
    // Another run finished meanwhile; this run's token read then fails
    // (before anything is written).
    const kvGet = env.KV.get.bind(env.KV);
    env.KV.get = (async (key: string, ...rest: unknown[]) => {
      if (key === "token:111980217") {
        await env.KV.put("accepted:bot:telegram:tg-token:1001", "other-run");
        throw new Error("KV down");
      }
      return (kvGet as (...a: unknown[]) => Promise<unknown>)(key, ...rest);
    }) as KVNamespace["get"];
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
      });
    }) as typeof fetch;
    await expect(
      handleTelegramUpdate(env, {
        update_id: 1001,
        message: {
          ...reply("-100123"),
          text: "/gh comment hello",
          reply_to_message: {
            ...reply("-100123"),
            text: "acme/widget#7: Add feature",
            entities: [{ type: "text_link", url: "https://github.com/acme/widget/issues/7" }],
          },
        },
      }),
    ).rejects.toThrow();
    expect(await env.KV.get("accepted:bot:telegram:tg-token:1001")).toBe("other-run");
  });
});

describe("telegram-commands logout and bot identity", () => {
  it("never unlinks twice when the logout reply failed", async () => {
    const env = createEnv();
    const { saveTelegramLink, getTelegramLink } = await import("../server/lib/github/store");
    await saveTelegramLink(env.DB, "111", "old");
    mockFetch(
      () => new Response(JSON.stringify({ ok: false, description: "down" }), { status: 502 }),
    );
    const update = { update_id: 4242, message: { ...reply("-100123"), text: "/gh logout" } };
    await expect(handleTelegramUpdate(env, update)).rejects.toThrow();
    // Linked again since; the redelivered logout must leave the new link alone.
    await saveTelegramLink(env.DB, "111", "new");
    mockFetch(
      () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    );
    await handleTelegramUpdate(env, update);
    expect(await getTelegramLink(env.DB, "111")).toBe("new");
  });

  it("tells two bots' updates with the same number apart", async () => {
    let sends = 0;
    mockFetch(() => {
      sends++;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    const update = { update_id: 77, message: { ...reply("-100123"), text: "/gh logout" } };
    const kv = createMockKV();
    const db = createMockDB();
    await handleTelegramUpdate({ ...createEnv(), KV: kv, DB: db, TELEGRAM_TOKEN: "1:a" }, update);
    await handleTelegramUpdate({ ...createEnv(), KV: kv, DB: db, TELEGRAM_TOKEN: "2:b" }, update);
    expect(sends).toBe(2);
  });
});

describe("telegram-commands reply failure after the write", () => {
  it("keeps the command done when the reply fails after the comment was written", async () => {
    const env = createEnv();
    const { saveTelegramLink } = await import("../server/lib/github/store");
    await saveTelegramLink(env.DB, "111", "111980217");
    await env.KV.put(
      "token:111980217",
      JSON.stringify({
        userId: "111980217",
        accessToken: "ghu_test",
        expiresAt: Date.now() + 3600_000,
      }),
    );
    let comments = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      if (url.endsWith("/sendMessage")) return new Response("Bad Gateway", { status: 502 });
      if (url.includes("/comments") && method === "POST") comments++;
      return new Response(
        JSON.stringify({
          user: { login: "a" },
          html_url: "https://github.com/acme/widget/issues/7#issuecomment-9",
        }),
        { status: 201 },
      );
    }) as typeof fetch;
    const update = {
      update_id: 2024,
      message: {
        ...reply("-100123"),
        text: "/gh comment hello",
        reply_to_message: {
          ...reply("-100123"),
          text: "acme/widget#7: Add feature",
          entities: [{ type: "text_link", url: "https://github.com/acme/widget/issues/7" }],
        },
      },
    };
    // The reply fails: Telegram redelivers the update.
    await handleTelegramUpdate(env, update).catch(() => undefined);
    await handleTelegramUpdate(env, update).catch(() => undefined);
    expect(comments).toBe(1);
  });
});
