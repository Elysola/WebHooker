import { describe, it, expect, afterEach } from "bun:test";
import { sendMessage, sendPhoto } from "../server/lib/drivers/telegram/rest";
import { renderNeutralMessage } from "../server/lib/drivers/telegram/render";
import { TelegramDriver } from "../server/lib/drivers/telegram";
import type { NeutralMessage } from "../server/lib/types";

function mockFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    Promise.resolve(handler(String(input), init));
}

const restoredFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = restoredFetch;
});

describe("telegram renderNeutralMessage", () => {
  it("renders title, fields and footer as HTML", () => {
    const message: NeutralMessage = {
      title: "acme/widget: Add feature",
      url: "https://github.com/acme/widget",
      fields: [{ name: "Status", value: "success" }],
      footer: "acme/widget",
    };
    const out = renderNeutralMessage(message);
    expect(out).toContain(
      '<b><a href="https://github.com/acme/widget">acme/widget</a>: Add feature</b>',
    );
    expect(out).toContain("<b>Status</b>: success");
    expect(out).toContain("<i>acme/widget</i>");
  });

  it("renders the forge source as a linked name in the footer", () => {
    const out = renderNeutralMessage({
      title: "acme/widget: Add feature",
      footer: "acme/widget",
      forge: {
        name: "GitHub",
        url: "https://github.com",
        iconUrl: "https://github.com/favicon.ico",
      },
    });
    expect(out).toContain('<i><a href="https://github.com">GitHub</a> · acme/widget</i>');

    const gitea = renderNeutralMessage({
      title: "org/repo: Add feature",
      forge: { name: "git.example.com", url: "https://git.example.com" },
    });
    expect(gitea).toContain('<i><a href="https://git.example.com">git.example.com</a></i>');
  });

  it("escapes HTML special characters", () => {
    const out = renderNeutralMessage({
      title: 'a <b> & "c"',
      fields: [{ name: "body", value: "<script>alert(1)</script>" }],
    });
    expect(out).not.toContain("<b>acme");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("converts Discord markdown to Telegram HTML", () => {
    const out = renderNeutralMessage({
      title: "acme/widget#7: Add feature",
      description:
        "**1** commit pushed to `main`\n[View comparison](https://github.com/acme/widget/compare/a...b)",
      fields: [{ name: "Status", value: "**ok** and `done`" }],
    });
    expect(out).toContain("<b>1</b> commit pushed to <code>main</code>");
    expect(out).toContain(
      '<a href="https://github.com/acme/widget/compare/a...b">View comparison</a>',
    );
    expect(out).toContain("<b>Status</b>: <b>ok</b> and <code>done</code>");
  });

  it("renders a code-formatted commit hash inside a link", () => {
    const out = renderNeutralMessage({
      title: "acme/widget: Pushed 1 commit",
      fields: [
        {
          name: "\u200b",
          value: "[`abcd123`](https://github.com/acme/widget/commit/abcd1234ef) fix stuff",
        },
      ],
    });
    expect(out).toContain(
      '<a href="https://github.com/acme/widget/commit/abcd1234ef"><code>abcd123</code></a> fix stuff',
    );
  });

  it("keeps query strings and parens intact in link URLs", () => {
    const out = renderNeutralMessage({
      title: "acme/widget: t",
      description:
        "[View](https://github.com/acme/widget/compare/a?w=1&diff=split) and " +
        "[wiki](https://en.wikipedia.org/wiki/Foo_(bar))",
    });
    expect(out).toContain(
      '<a href="https://github.com/acme/widget/compare/a?w=1&amp;diff=split">View</a>',
    );
    expect(out).toContain('<a href="https://en.wikipedia.org/wiki/Foo_(bar)">wiki</a>');
    expect(out).not.toContain("&amp;amp;");
  });

  it("formats ISO timestamps into a readable UTC string", () => {
    const out = renderNeutralMessage({
      title: "acme/widget: t",
      timestamp: "2026-08-02T21:26:04.042Z",
    });
    expect(out).toContain("<i>2026-08-02 21:26 UTC</i>");
  });
});

describe("telegram-rest sendMessage", () => {
  it("posts to the bot API with chat_id and parse_mode", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200,
      });
    });

    const result = await sendMessage("token-abc", "-100123", "hello");

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("42");
    expect(capturedUrl).toBe("https://api.telegram.org/bottoken-abc/sendMessage");
    const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
    expect(body.chat_id).toBe("-100123");
    expect(body.parse_mode).toBe("HTML");
    expect(body.message_thread_id).toBeUndefined();
  });

  it("includes message_thread_id when topicId is given", async () => {
    let capturedInit: RequestInit | undefined;
    mockFetch((_url, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
      });
    });

    await sendMessage("t", "-100123", "hello", "999");
    const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
    expect(body.message_thread_id).toBe(999);
  });

  it("returns error on non-ok response", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 }),
    );
    const result = await sendMessage("t", "-100123", "hello");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("chat not found");
  });

  it("returns error when token is missing", async () => {
    const result = await sendMessage("", "-100123", "hello");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NO_TOKEN");
  });
});

describe("telegram-rest sendPhoto", () => {
  it("posts to the bot API with photo, caption and thread id", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        status: 200,
      });
    });

    const result = await sendPhoto("t", "-100123", "https://avatars/1.png", "caption here", "999");

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("7");
    expect(capturedUrl).toBe("https://api.telegram.org/bott/sendPhoto");
    const body = JSON.parse(String(capturedInit!.body)) as Record<string, unknown>;
    expect(body.chat_id).toBe("-100123");
    expect(body.photo).toBe("https://avatars/1.png");
    expect(body.caption).toBe("caption here");
    expect(body.message_thread_id).toBe(999);
  });
});

describe("TelegramDriver", () => {
  it("uses a plain-text title for the rich header preview", async () => {
    let capturedInit: RequestInit | undefined;
    mockFetch((_url, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
    });

    const driver = new TelegramDriver();
    await driver.send(
      {
        title:
          "OnionSchool/YangYiSongRequest: [CI — running](https://github.com/OnionSchool/YangYiSongRequest/actions)",
        author: { name: "alice", iconUrl: "https://avatars.githubusercontent.com/u/1" },
      },
      { platform: "telegram", chatId: "-100123" },
      {
        TELEGRAM_TOKEN: "t",
        BASE_URL: "https://webhooker.example.com",
        KV: {} as never,
        DB: {} as never,
        GITHUB_WEBHOOK_SECRET: "s",
      },
    );

    const body = JSON.parse(String(capturedInit!.body)) as {
      link_preview_options: { url: string };
    };
    const previewUrl = new URL(body.link_preview_options.url);
    expect(previewUrl.searchParams.get("content")).toBe(
      "OnionSchool/YangYiSongRequest: CI — running",
    );
  });

  it("shows a small avatar (s=64) as the link preview of a text message", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl = "";
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
    });

    const driver = new TelegramDriver();
    const result = await driver.send(
      {
        title: "acme/widget: Add feature",
        author: { name: "alice", iconUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
      },
      { platform: "telegram", chatId: "-100123" },
      { TELEGRAM_TOKEN: "t", KV: {} as never, DB: {} as never, GITHUB_WEBHOOK_SECRET: "s" },
    );

    expect(result.ok).toBe(true);
    // A text message (never a captioned photo), so later edits keep the full
    // 4096-character budget.
    expect(capturedUrl).toContain("/sendMessage");
    const body = JSON.parse(String(capturedInit!.body)) as {
      link_preview_options?: { url?: string };
    };
    expect(body.link_preview_options?.url).toBe(
      "https://avatars.githubusercontent.com/u/1?v=4&s=64",
    );
  });

  it("sends a plain message when the author has no icon", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
        status: 200,
      });
    });

    const driver = new TelegramDriver();
    const result = await driver.send(
      { title: "acme/widget: Add feature" },
      { platform: "telegram", chatId: "-100123" },
      { TELEGRAM_TOKEN: "t", KV: {} as never, DB: {} as never, GITHUB_WEBHOOK_SECRET: "s" },
    );

    expect(result.ok).toBe(true);
    expect(capturedUrl).toContain("/sendMessage");
  });
});
