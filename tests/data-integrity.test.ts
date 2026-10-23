import { describe, it, expect, beforeEach } from "bun:test";
import type { H3Event } from "h3";
import {
  adminApiGroupsGet,
  adminApiGroupsPut,
  adminGroupCreate,
  adminGroupDelete,
  adminGroupFragmentsGet,
  adminGroupFragmentsPut,
  adminGroupInvitesPost,
  adminInviteDelete,
  adminGroupRename,
  adminGroupRoutesGet,
  adminGroupRoutesPut,
  adminGroupUpdate,
  adminGroupWebhookRegenerate,
  channelFreeGuard,
  roleGuard,
} from "../server/lib/web/admin";
import { ConfigConflictError } from "../server/lib/storage/config-store";
import { createAdminSession, adminCookie } from "../server/lib/web/session";
import {
  createGroup,
  ensureInstallationGroup,
  loadGroups,
  updateGroup,
} from "../server/lib/web/groups";
import {
  initConfigStore,
  loadRoutes,
  resetConfigStore,
  saveGroupRoutes,
} from "../server/lib/config";
import { saveToken, findUserIdByToken } from "../server/lib/github/store";
import { makeEvent, responseStatus } from "./helpers";
import { resolveGroupAlias } from "../server/lib/web/group-lifecycle";
import { acceptInvite, getInvite } from "../server/lib/web/invites";
import { createMemoryKV, createSqliteD1 } from "./d1-sqlite";
import type { Env, Group, Route } from "../server/lib/types";
import type { Database } from "bun:sqlite";

let env: Env;
let sqlite: Database;

function group(id: string, owner: string, extra: Partial<Group> = {}): Group {
  return { id, name: id, adminIds: [owner], members: [{ login: owner, role: "owner" }], ...extra };
}

function route(id: string, extra: Partial<Route> = {}): Route {
  return {
    id,
    name: id,
    enabled: true,
    filters: [{ type: "event", match: "push" }],
    targets: [{ platform: "discord", channelId: "1" }],
    ...extra,
  };
}

async function cookieFor(userId: string, login: string): Promise<string> {
  return adminCookie(await createAdminSession(env.KV, userId, login));
}

/** Delete a group the way the console does: confirmed on its shown revisions. */
async function deleteAs(cookie: string, id: string): Promise<void> {
  const routes = (await adminGroupRoutesGet(
    call(`/admin/api/groups/${id}/routes`, cookie),
    id,
  )) as {
    revision: string;
    version: number;
  };
  const listed = (await adminApiGroupsGet(call("/admin/api/groups", cookie))) as {
    groups: Array<{ id: string; revision: string }>;
  };
  const rev = listed.groups.find((g) => g.id === id)!.revision;
  const del = call(
    `/admin/api/groups/${id}?revision=${rev}&routesRevision=${routes.revision}&version=${routes.version}`,
    cookie,
    "DELETE",
  );
  await adminGroupDelete(del, id);
  expect(responseStatus(del)).toBe(200);
}

function call(path: string, cookie: string, method = "GET", body?: unknown): H3Event {
  return makeEvent(path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    env,
  });
}

beforeEach(async () => {
  const d1 = createSqliteD1();
  sqlite = d1.sqlite;
  const { kv } = createMemoryKV();
  env = { GITHUB_WEBHOOK_SECRET: "s", KV: kv, DB: d1.db, ADMIN_USER_IDS: "1" };
  resetConfigStore(kv);
  initConfigStore(env);
  await createGroup(kv, group("alpha", "alice"));
  await createGroup(
    kv,
    group("beta", "bob", {
      members: [
        { login: "bob", role: "owner" },
        { login: "alice", role: "viewer" },
      ],
    }),
  );
});

describe("delivery targets", () => {
  it("never lets a tenant aim its routes at a channel another group delivers to", async () => {
    await saveGroupRoutes(env.KV, "beta", [
      route("b1", { groupId: "beta", targets: [{ platform: "discord", channelId: "beta-ch" }] }),
    ]);
    const alice = await cookieFor("2", "alice");
    const hijack = call("/admin/api/groups/alpha/routes", alice, "PUT", {
      routes: [route("a1", { targets: [{ platform: "discord", channelId: "beta-ch" }] })],
    });
    await adminGroupRoutesPut(hijack, "alpha");
    expect(responseStatus(hijack)).toBe(403);
    // Nor through another spelling of the same channel (a URL path alias).
    const alias = call("/admin/api/groups/alpha/routes", alice, "PUT", {
      routes: [route("a1", { targets: [{ platform: "discord", channelId: "x/../beta-ch" }] })],
    });
    await adminGroupRoutesPut(alias, "alpha");
    expect(responseStatus(alias)).toBe(400);
    for (const target of [
      { platform: "telegram", chatId: "-0100" },
      // Wraps around to an existing chat in Telegram's 64-bit parsing.
      { platform: "telegram", chatId: "-18446744073709652393" },
      { platform: "discord", channelId: "0123" },
    ]) {
      const padded = call("/admin/api/groups/alpha/routes", alice, "PUT", {
        routes: [route("a1", { targets: [target as never] })],
      });
      await adminGroupRoutesPut(padded, "alpha");
      expect(responseStatus(padded)).toBe(400);
    }
    const username = call("/admin/api/groups/alpha/routes", alice, "PUT", {
      routes: [route("a1", { targets: [{ platform: "telegram", chatId: "@beta_channel" }] })],
    });
    await adminGroupRoutesPut(username, "alpha");
    expect(responseStatus(username)).toBe(400);
    // A channel nobody else uses is fine; so is one the writer also manages.
    const own = call("/admin/api/groups/alpha/routes", alice, "PUT", {
      routes: [route("a1", { targets: [{ platform: "discord", channelId: "alpha-ch" }] })],
    });
    await adminGroupRoutesPut(own, "alpha");
    expect(responseStatus(own)).toBe(200);
    const root = await cookieFor("1", "root");
    const shared = call("/admin/api/groups/alpha/routes", root, "PUT", {
      routes: [route("a1", { targets: [{ platform: "discord", channelId: "beta-ch" }] })],
    });
    await adminGroupRoutesPut(shared, "alpha");
    expect(responseStatus(shared)).toBe(200);
  });
});

describe("shared and aliased targets", () => {
  it("compares a stored Telegram @username by the chat id it names", async () => {
    env.TELEGRAM_TOKEN = "bot";
    // Stored before only numeric ids were accepted.
    await saveGroupRoutes(env.KV, "beta", [
      route("b1", { groupId: "beta", targets: [{ platform: "telegram", chatId: "@beta_chat" }] }),
    ]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      expect(String(input)).toContain("getChat?chat_id=%40beta_chat");
      return new Response(JSON.stringify({ ok: true, result: { id: -100777 } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const alice = await cookieFor("2", "alice");
      const same = call("/admin/api/groups/alpha/routes", alice, "PUT", {
        routes: [route("a1", { targets: [{ platform: "telegram", chatId: "-100777" }] })],
      });
      await adminGroupRoutesPut(same, "alpha");
      expect(responseStatus(same)).toBe(403);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("looks up no Telegram usernames for a save without Telegram targets", async () => {
    env.TELEGRAM_TOKEN = "bot";
    await saveGroupRoutes(env.KV, "beta", [
      route("b1", { groupId: "beta", targets: [{ platform: "telegram", chatId: "@beta_chat" }] }),
    ]);
    let lookups = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      lookups++;
      return new Response(JSON.stringify({ ok: true, result: { id: -100777 } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const alice = await cookieFor("2", "alice");
      const discord = call("/admin/api/groups/alpha/routes", alice, "PUT", {
        routes: [route("a1", { targets: [{ platform: "discord", channelId: "alpha-ch" }] })],
      });
      await adminGroupRoutesPut(discord, "alpha");
      expect(responseStatus(discord)).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(lookups).toBe(0);
  });

  it("keeps a channel shared from older data only where it already was", async () => {
    const shared = [{ platform: "discord" as const, channelId: "shared-ch" }];
    await saveGroupRoutes(env.KV, "alpha", [route("a1", { groupId: "alpha", targets: shared })]);
    await saveGroupRoutes(env.KV, "beta", [route("b1", { groupId: "beta", targets: shared })]);
    const alice = await cookieFor("2", "alice");
    // Unchanged: fine.
    const same = call("/admin/api/groups/alpha/routes", alice, "PUT", {
      routes: [route("a1", { targets: shared })],
    });
    await adminGroupRoutesPut(same, "alpha");
    expect(responseStatus(same)).toBe(200);
    // Another topic/thread of the shared channel on the same route: refused.
    const thread = call("/admin/api/groups/alpha/routes", alice, "PUT", {
      routes: [
        route("a1", {
          targets: [...shared, { platform: "discord", channelId: "shared-ch", threadId: "t2" }],
        }),
      ],
    });
    await adminGroupRoutesPut(thread, "alpha");
    expect(responseStatus(thread)).toBe(403);
    // A new route sending more into the shared channel: refused.
    const more = call("/admin/api/groups/alpha/routes", alice, "PUT", {
      routes: [route("a1", { targets: shared }), route("a2", { targets: shared })],
    });
    await adminGroupRoutesPut(more, "alpha");
    expect(responseStatus(more)).toBe(403);
  });
});

describe("webhook secrets", () => {
  it("keeps the secret with the group, re-checked at commit and never sent to clients", async () => {
    const { rotateTenantSecret, getTenantSecret } = await import("../server/lib/web/tenants");
    const alice = await cookieFor("2", "alice");
    const rotate = call("/admin/api/groups/alpha/webhook/regenerate", alice, "POST");
    const { secret } = (await adminGroupWebhookRegenerate(rotate, "alpha")) as { secret: string };
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const stored = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "alpha")!;
    expect(await getTenantSecret(env.KV, stored)).toBe(secret);
    // Never in what clients read.
    const listed = await adminApiGroupsGet(call("/admin/api/groups", alice));
    expect(JSON.stringify(listed)).not.toContain(secret);
    // A rotation whose writer lost the right meanwhile changes nothing.
    await expect(
      rotateTenantSecret(env.KV, "alpha", () => {
        throw new Error("no longer an owner");
      }),
    ).rejects.toThrow();
    const after = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "alpha")!;
    expect(after.webhookSecret).toBe(secret);
    // A plain group edit keeps it.
    await updateGroup(env.KV, "alpha", (g) => ({
      ...g,
      name: "Renamed",
      webhookSecret: undefined,
    }));
    const edited = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "alpha")!;
    expect(edited.webhookSecret).toBe(secret);
  });

  it("creates groups with their members bound to their accounts", async () => {
    await saveToken(env.KV, "1", "root-token", 3600);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 77, login: "bob" }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      const root = await cookieFor("1", "root");
      const create = call("/admin/api/groups", root, "POST", { group: group("delta", "bob") });
      await adminGroupCreate(create);
      expect(responseStatus(create)).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
    const delta = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "delta")!;
    expect(delta.members).toEqual([{ login: "bob", role: "owner", userId: "77" }]);
  });
});

describe("sources and links", () => {
  it("accepts and keeps the custom source restriction", async () => {
    const alice = await cookieFor("2", "alice");
    const listed = (await adminApiGroupsGet(call("/admin/api/groups", alice))) as {
      groups: Group[];
    };
    const alpha = listed.groups.find((g) => g.id === "alpha")!;
    const save = call("/admin/api/groups/alpha", alice, "PUT", {
      group: { ...alpha, providers: ["github", "custom"] },
    });
    await adminGroupUpdate(save, "alpha");
    expect(responseStatus(save)).toBe(200);
    const stored = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "alpha")!;
    expect(stored.providers).toEqual(["github", "custom"]);
  });

  it("uses an account-link confirmation once", async () => {
    const { handleLinkConfirm } = await import("../server/lib/web/oauth");
    const nonce = "0123456789abcdef0123456789abcdef";
    const link = JSON.stringify({
      platform: "discord",
      userId: "d1",
      githubUserId: "42",
      login: "alice",
    });
    await env.KV.put(`link:${nonce}`, link);
    const confirm = (): H3Event =>
      makeEvent("/auth/github/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce }),
        env,
      });
    await handleLinkConfirm(confirm());
    // Replayed later (a stale KV copy elsewhere still has the confirmation).
    await env.KV.put(`link:${nonce}`, link);
    const again = confirm();
    await handleLinkConfirm(again);
    expect(responseStatus(again)).toBe(400);
  });
});

describe("repairing unreadable routes", () => {
  it("lets an admin explicitly replace a group whose stored route cannot be read", async () => {
    await saveGroupRoutes(env.KV, "alpha", [route("broken", { groupId: "alpha" })]);
    sqlite.exec("UPDATE d1_routes SET targets = '{oops' WHERE id = 'broken'");
    const alice = await cookieFor("2", "alice");
    const shown = (await adminGroupRoutesGet(
      call("/admin/api/groups/alpha/routes", alice),
      "alpha",
    )) as { unreadable: boolean };
    expect(shown.unreadable).toBe(true);
    // A plain save is refused (the unseen row would be lost)...
    const plain = call("/admin/api/groups/alpha/routes", alice, "PUT", { routes: [route("a1")] });
    await adminGroupRoutesPut(plain, "alpha");
    expect(responseStatus(plain)).not.toBe(200);
    // ...an explicit repair goes through.
    const repair = call("/admin/api/groups/alpha/routes", alice, "PUT", {
      routes: [route("a1")],
      discardUnreadable: true,
    });
    await adminGroupRoutesPut(repair, "alpha");
    expect(responseStatus(repair)).toBe(200);
    expect(sqlite.query("SELECT id FROM d1_routes WHERE group_id = 'alpha'").all()).toEqual([
      { id: "a1" },
    ]);
  });
});

describe("authorization at commit time", () => {
  it("refuses a route write by someone removed from the group meanwhile", async () => {
    const alice = await cookieFor("2", "alice");
    const write = call("/admin/api/groups/alpha/routes", alice, "PUT", {
      routes: [route("a1", { targets: [{ platform: "discord", channelId: "fresh" }] })],
    });
    // Authorized now (the request's access check runs and is kept)...
    const { requireAnyAccess } = await import("../server/lib/web/auth");
    await requireAnyAccess(write);
    // ...but an owner removes alice before the write lands.
    await updateGroup(env.KV, "alpha", (g) => ({
      ...g,
      members: [{ login: "carol", role: "owner" }],
      adminIds: ["carol"],
    }));
    // The write itself re-checks the role at commit.
    await expect(
      saveGroupRoutes(env.KV, "alpha", [route("a1", { groupId: "alpha" })], {
        guards: roleGuard(write, "alpha", "admin"),
      }),
    ).rejects.toBeInstanceOf(ConfigConflictError);
    expect((await loadRoutes(env.KV, { fresh: true })).some((r) => r.id === "a1")).toBe(false);
  });

  it("voids an invite whose issuing owner was removed before it was used", async () => {
    const owner = await cookieFor("2", "alice");
    const created = (await adminGroupInvitesPost(
      call("/admin/api/groups/alpha/invites", owner, "POST", { role: "admin" }),
      "alpha",
    )) as { token: string };
    await updateGroup(env.KV, "alpha", (g) => ({
      ...g,
      members: [{ login: "carol", role: "owner" }],
      adminIds: ["carol"],
    }));
    expect(await acceptInvite(env, created.token, "9", "mallory")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses a filter node that mixes condition kinds", async () => {
    const alice = await cookieFor("2", "alice");
    const mixed = call("/admin/api/groups/alpha/routes", alice, "PUT", {
      routes: [route("a1", { ast: { all: 0, any: [{ type: "event", match: "push" }] } as never })],
    });
    await adminGroupRoutesPut(mixed, "alpha");
    expect(responseStatus(mixed)).toBe(400);
  });

  it("refuses a glob longer than the matcher can run", async () => {
    const alice = await cookieFor("2", "alice");
    const long = call("/admin/api/groups/alpha/routes", alice, "PUT", {
      routes: [
        route("a1", { filters: [{ type: "branch", match: `${"a".repeat(201)}*`, exclude: true }] }),
      ],
    });
    await adminGroupRoutesPut(long, "alpha");
    expect(responseStatus(long)).toBe(400);
  });

  it("never accepts an invite revoked after it was read", async () => {
    const owner = await cookieFor("2", "alice");
    const created = (await adminGroupInvitesPost(
      call("/admin/api/groups/alpha/invites", owner, "POST", { role: "admin" }),
      "alpha",
    )) as { token: string };
    const { revokeInvite } = await import("../server/lib/web/invites");
    // Revoked with its D1 record; the KV copy another isolate may still read
    // is put back to stand for that stale read.
    const raw = await env.KV.get(`invite:${created.token}`);
    await revokeInvite(env.KV, created.token, env.DB);
    await env.KV.put(`invite:${created.token}`, raw!);
    expect(await acceptInvite(env, created.token, "9", "mallory")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("delivery target claims at commit time", () => {
  it("aborts a write whose new channel another group took meanwhile", async () => {
    // The pre-check passed; then beta committed a route and a log target.
    await saveGroupRoutes(env.KV, "beta", [
      route("b1", { groupId: "beta", targets: [{ platform: "telegram", chatId: "-100" }] }),
    ]);
    await updateGroup(env.KV, "beta", (g) => ({
      ...g,
      logTarget: { platform: "discord", channelId: "log-ch" },
    }));
    for (const channel of ["telegram:-100", "discord:log-ch"]) {
      await expect(
        saveGroupRoutes(env.KV, "alpha", [route("a1", { groupId: "alpha" })], {
          guards: (db) => [channelFreeGuard(db, channel, ["alpha"])],
        }),
      ).rejects.toBeInstanceOf(ConfigConflictError);
    }
    // Same platform id on another platform, or a group the writer may edit: free.
    await saveGroupRoutes(env.KV, "alpha", [route("a1", { groupId: "alpha" })], {
      guards: (db) => [
        channelFreeGuard(db, "discord:-100", ["alpha"]),
        channelFreeGuard(db, "telegram:-100", ["alpha", "beta"]),
      ],
    });
    expect((await loadRoutes(env.KV, { fresh: true })).some((r) => r.id === "a1")).toBe(true);
  });
});

describe("member binding", () => {
  it("binds a member added by login to the account holding it now", async () => {
    await saveToken(env.KV, "2", "alice-token", 3600);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      expect(String(input)).toBe("https://api.github.com/users/bob");
      return new Response(JSON.stringify({ id: 99, login: "bob" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const cookie = await cookieFor("2", "alice");
      const listed = (await adminApiGroupsGet(call("/admin/api/groups", cookie))) as {
        groups: Group[];
      };
      const alpha = listed.groups.find((g) => g.id === "alpha")!;
      const event = call("/admin/api/groups/alpha", cookie, "PUT", {
        group: { ...alpha, members: [...alpha.members!, { login: "bob", role: "viewer" }] },
      });
      await adminGroupUpdate(event, "alpha");
      expect(responseStatus(event)).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
    const stored = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "alpha")!;
    expect(stored.members).toContainEqual({ login: "bob", role: "viewer", userId: "99" });
  });
});

describe("group writes", () => {
  it("an owner of one group can update it while viewing another", async () => {
    const cookie = await cookieFor("2", "alice");
    const listed = (await adminApiGroupsGet(call("/admin/api/groups", cookie))) as {
      groups: Group[];
    };
    const alpha = listed.groups.find((g) => g.id === "alpha")!;
    const event = call("/admin/api/groups/alpha", cookie, "PUT", {
      group: { ...alpha, name: "Alpha!" },
    });
    await adminGroupUpdate(event, "alpha");
    expect(responseStatus(event)).toBe(200);
    expect((await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "alpha")!.name).toBe(
      "Alpha!",
    );

    // The legacy bulk API accepts the visible-but-not-owned group unchanged.
    const again = (await adminApiGroupsGet(call("/admin/api/groups", cookie))) as {
      groups: Group[];
    };
    const bulk = call("/admin/api/groups", cookie, "PUT", { groups: again.groups });
    await adminApiGroupsPut(bulk);
    expect(responseStatus(bulk)).toBe(200);
  });

  it("refuses an update built on a stale copy", async () => {
    const cookie = await cookieFor("2", "alice");
    const listed = (await adminApiGroupsGet(call("/admin/api/groups", cookie))) as {
      groups: Group[];
    };
    const alpha = listed.groups.find((g) => g.id === "alpha")!;
    const first = call("/admin/api/groups/alpha", cookie, "PUT", {
      group: { ...alpha, name: "first" },
    });
    await adminGroupUpdate(first, "alpha");
    const second = call("/admin/api/groups/alpha", cookie, "PUT", {
      group: { ...alpha, lang: "zh" },
    });
    await adminGroupUpdate(second, "alpha");
    expect(responseStatus(second)).toBe(409);
    const stored = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "alpha")!;
    expect(stored.name).toBe("first");
    expect(stored.lang).toBeUndefined();
  });

  it("owners cannot change the source-isolation fields", async () => {
    await createGroup(env.KV, group("u-2", "alice", { isolated: true, installationId: 5 }));
    const cookie = await cookieFor("2", "alice");
    const event = call("/admin/api/groups/u-2", cookie, "PUT", {
      group: { ...group("u-2", "alice"), owners: [], isolated: false, installationId: 99 },
    });
    await adminGroupUpdate(event, "u-2");
    const stored = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "u-2")!;
    expect(stored.isolated).toBe(true);
    expect(stored.installationId).toBe(5);
  });

  it("a stale bulk save no longer reverts or drops another group", async () => {
    const admin = await cookieFor("1", "root");
    const snapshot = (await adminApiGroupsGet(call("/admin/api/groups", admin))) as {
      groups: Group[];
    };
    // Someone else edits beta and creates gamma afterwards.
    const bob = await cookieFor("3", "bob");
    const beta = snapshot.groups.find((g) => g.id === "beta")!;
    await adminGroupUpdate(
      call("/admin/api/groups/beta", bob, "PUT", { group: { ...beta, name: "Beta v2" } }),
      "beta",
    );
    // The super admin saves an alpha change from the old snapshot (old beta).
    const edited = snapshot.groups.map((g) => (g.id === "alpha" ? { ...g, lang: "zh" } : g));
    const bulk = call("/admin/api/groups", admin, "PUT", { groups: edited });
    await adminApiGroupsPut(bulk);
    expect(responseStatus(bulk)).toBe(200);
    const stored = await loadGroups(env.KV, { fresh: true });
    expect(stored.find((g) => g.id === "alpha")!.lang).toBe("zh");
    // beta came back unedited from the old snapshot: bob's change survives.
    expect(stored.find((g) => g.id === "beta")!.name).toBe("Beta v2");
  });

  it("a bulk save based on an outdated list is refused", async () => {
    const admin = await cookieFor("1", "root");
    const snapshot = (await adminApiGroupsGet(call("/admin/api/groups", admin))) as {
      groups: Group[];
      revision: string;
    };
    await adminGroupCreate(
      call("/admin/api/groups", admin, "POST", { group: group("gamma", "carol") }),
    );
    const bulk = call("/admin/api/groups", admin, "PUT", {
      groups: snapshot.groups,
      revision: snapshot.revision,
    });
    await adminApiGroupsPut(bulk);
    expect(responseStatus(bulk)).toBe(409);
    expect((await loadGroups(env.KV, { fresh: true })).map((g) => g.id)).toContain("gamma");
  });

  it("never deletes what was added to a group after its deletion was confirmed", async () => {
    const cookie = await cookieFor("2", "alice");
    const shown = (await adminGroupRoutesGet(
      call("/admin/api/groups/alpha/routes", cookie),
      "alpha",
    )) as { revision: string; version: number };
    const groups = (await adminApiGroupsGet(call("/admin/api/groups", cookie))) as {
      groups: Array<{ id: string; revision: string }>;
    };
    const rev = groups.groups.find((g) => g.id === "alpha")!.revision;
    // A filter fragment saved meanwhile (the routes are unchanged).
    const frag = call("/admin/api/groups/alpha/fragments", cookie, "PUT", {
      fragments: [{ id: "f1", name: "F", node: { type: "event", match: "push" } }],
    });
    await adminGroupFragmentsPut(frag, "alpha");
    expect(responseStatus(frag)).toBe(200);
    const del = call(
      `/admin/api/groups/alpha?revision=${rev}&routesRevision=${shown.revision}&version=${shown.version}`,
      cookie,
      "DELETE",
    );
    await adminGroupDelete(del, "alpha");
    expect(responseStatus(del)).toBe(409);
  });

  it("deleting a group detaches its history and retires its id", async () => {
    sqlite.exec(
      "INSERT INTO send_logs (ts, route_id, group_id, event, target, ok) VALUES (1, 'r', 'alpha', 'push', 't', 1)",
    );
    const cookie = await cookieFor("2", "alice");
    // Confirmed on the group and its routes as shown.
    const shown = (await adminGroupRoutesGet(
      call("/admin/api/groups/alpha/routes", cookie),
      "alpha",
    )) as { revision: string; version: number };
    const groups = (await adminApiGroupsGet(call("/admin/api/groups", cookie))) as {
      groups: Array<{ id: string; revision: string }>;
    };
    const rev = groups.groups.find((g) => g.id === "alpha")!.revision;
    const del = call(
      `/admin/api/groups/alpha?revision=${rev}&routesRevision=${shown.revision}&version=${shown.version}`,
      cookie,
      "DELETE",
    );
    await adminGroupDelete(del, "alpha");
    expect(responseStatus(del)).toBe(200);
    expect(sqlite.query("SELECT group_id FROM send_logs").get()).toEqual({ group_id: null });

    const admin = await cookieFor("1", "root");
    const recreate = call("/admin/api/groups", admin, "POST", { group: group("alpha", "eve") });
    await adminGroupCreate(recreate);
    expect(responseStatus(recreate)).toBe(409);
  });

  it("renaming moves routes and history in one go", async () => {
    sqlite.exec(
      "INSERT INTO send_logs (ts, route_id, group_id, event, target, ok) VALUES (1, 'r', 'alpha', 'push', 't', 1)",
    );
    const cookie = await cookieFor("2", "alice");
    await adminGroupRoutesPut(
      call("/admin/api/groups/alpha/routes", cookie, "PUT", { routes: [route("r1")] }),
      "alpha",
    );
    const event = call("/admin/api/groups/alpha/rename", cookie, "PUT", { newId: "omega" });
    await adminGroupRename(event, "alpha");
    expect(responseStatus(event)).toBe(200);
    expect((await loadRoutes(env.KV, { fresh: true })).map((r) => r.groupId)).toEqual(["omega"]);
    expect(sqlite.query("SELECT group_id FROM send_logs").get()).toEqual({ group_id: "omega" });
    expect(await resolveGroupAlias(env, "alpha")).toBe("omega");
  });
});

describe("route writes", () => {
  it("refuses a save built on routes changed meanwhile", async () => {
    const cookie = await cookieFor("2", "alice");
    const loaded = (await adminGroupRoutesGet(
      call("/admin/api/groups/alpha/routes", cookie),
      "alpha",
    )) as { revision: string };
    const first = call("/admin/api/groups/alpha/routes", cookie, "PUT", {
      routes: [route("a")],
      revision: loaded.revision,
    });
    const saved = (await adminGroupRoutesPut(first, "alpha")) as { revision: string };
    expect(responseStatus(first)).toBe(200);
    const stale = call("/admin/api/groups/alpha/routes", cookie, "PUT", {
      routes: [route("b")],
      revision: loaded.revision,
    });
    await adminGroupRoutesPut(stale, "alpha");
    expect(responseStatus(stale)).toBe(409);
    const fresh = call("/admin/api/groups/alpha/routes", cookie, "PUT", {
      routes: [route("a"), route("b")],
      revision: saved.revision,
    });
    await adminGroupRoutesPut(fresh, "alpha");
    expect(responseStatus(fresh)).toBe(200);
  });

  it("rejects regexes RE2 cannot run and non-snowflake role ids", async () => {
    const cookie = await cookieFor("2", "alice");
    const backref = call("/admin/api/groups/alpha/routes", cookie, "PUT", {
      routes: [route("x", { filters: [{ type: "keyword", match: "/(a)\\1/" }] })],
    });
    await adminGroupRoutesPut(backref, "alpha");
    expect(responseStatus(backref)).toBe(400);
    const mention = call("/admin/api/groups/alpha/routes", cookie, "PUT", {
      routes: [route("x", { discordRoleIds: ["1> @everyone <@&2"] })],
    });
    await adminGroupRoutesPut(mention, "alpha");
    expect(responseStatus(mention)).toBe(400);
  });
});

describe("fragment writes", () => {
  it("replaces only the group's own fragments and detects stale saves", async () => {
    sqlite.exec(
      "INSERT INTO d1_fragments (id, group_id, name, node, created_at, updated_at) VALUES ('keep', 'beta', 'K', '{\"type\":\"event\",\"match\":\"push\"}', 1, 1)",
    );
    const cookie = await cookieFor("2", "alice");
    const loaded = (await adminGroupFragmentsGet(
      call("/admin/api/groups/alpha/fragments", cookie),
      "alpha",
    )) as { revision: string };
    const node = { type: "event", match: "push" };
    const save = call("/admin/api/groups/alpha/fragments", cookie, "PUT", {
      fragments: [{ id: "f1", name: "F1", node }],
      revision: loaded.revision,
    });
    await adminGroupFragmentsPut(save, "alpha");
    expect(responseStatus(save)).toBe(200);
    const stale = call("/admin/api/groups/alpha/fragments", cookie, "PUT", {
      fragments: [],
      revision: loaded.revision,
    });
    await adminGroupFragmentsPut(stale, "alpha");
    expect(responseStatus(stale)).toBe(409);
    expect(sqlite.query("SELECT group_id, id FROM d1_fragments ORDER BY group_id").all()).toEqual([
      { group_id: "alpha", id: "f1" },
      { group_id: "beta", id: "keep" },
    ]);
  });
});

describe("token rotation", () => {
  it("stops an old token from authenticating after re-authorization", async () => {
    await saveToken(env.KV, "42", "old-token", 3600);
    expect(await findUserIdByToken(env.KV, "old-token")).toBe("42");
    await saveToken(env.KV, "42", "new-token", 3600);
    expect(await findUserIdByToken(env.KV, "old-token")).toBeNull();
    expect(await findUserIdByToken(env.KV, "new-token")).toBe("42");
  });

  it("rejects a token whose reverse key outlived its replacement", async () => {
    await saveToken(env.KV, "42", "old-token", 3600);
    const reverse = [...(await env.KV.list({ prefix: "token-reverse:" })).keys][0]!.name;
    const value = await env.KV.get(reverse);
    await saveToken(env.KV, "42", "new-token", 3600);
    await env.KV.put(reverse, value!);
    expect(await findUserIdByToken(env.KV, "old-token")).toBeNull();
  });
});

describe("reserved and squatted installation ids", () => {
  it("does not let owners rename into the system id space", async () => {
    const cookie = await cookieFor("2", "alice");
    const event = call("/admin/api/groups/alpha/rename", cookie, "PUT", { newId: "inst-555" });
    await adminGroupRename(event, "alpha");
    expect(responseStatus(event)).toBe(400);
  });

  it("never binds an installation to an unbound group that merely has its name", async () => {
    await createGroup(env.KV, group("inst-777", "mallory"));
    const bound = await ensureInstallationGroup(env.KV, 777, "victim-org");
    expect(bound).toBeNull();
    const stored = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "inst-777")!;
    expect(stored.installationId).toBeUndefined();
  });
});

describe("round-2 regressions", () => {
  it("keeps a legacy personal group isolated when it is renamed", async () => {
    sqlite.exec(
      `INSERT INTO d1_groups (id, name, data, version, created_at, updated_at) VALUES ('u-42', 'me', '{"id":"u-42","name":"me","adminIds":["alice"],"members":[{"login":"alice","role":"owner"}]}', 1, 0, 0)`,
    );
    const cookie = await cookieFor("2", "alice");
    const event = call("/admin/api/groups/u-42/rename", cookie, "PUT", { newId: "team" });
    await adminGroupRename(event, "u-42");
    expect(responseStatus(event)).toBe(200);
    const team = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "team")!;
    expect(team.isolated).toBe(true);
  });

  it("never lets an old invite join a group re-created under the same id", async () => {
    const owner = await cookieFor("2", "alice");
    const created = (await adminGroupInvitesPost(
      call("/admin/api/groups/alpha/invites", owner, "POST", { role: "admin" }),
      "alpha",
    )) as { token: string };
    await deleteAs(owner, "alpha");
    // The invite's KV record survived (as if its cleanup had failed).
    await env.KV.put(
      `invite:${created.token}`,
      JSON.stringify({
        groupId: "alpha",
        role: "admin",
        expiresAt: Date.now() + 86400_000,
        createdBy: "alice",
        groupInstance: "gone",
      }),
    );
    sqlite.exec("DELETE FROM dedup_keys");
    await createGroup(env.KV, group("alpha", "eve"));
    const result = await acceptInvite(env, created.token, "9", "mallory");
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("never lets a second person in on an invite whose first use committed unseen", async () => {
    const owner = await cookieFor("2", "alice");
    const created = (await adminGroupInvitesPost(
      call("/admin/api/groups/alpha/invites", owner, "POST", { role: "admin" }),
      "alpha",
    )) as { token: string };
    // The first acceptance committed, but its answer was lost: its claim was
    // given back while the "used" record stayed.
    sqlite.exec(
      `INSERT INTO dedup_keys (key, claimed_at, expires_at) VALUES ('accepted:invite-used:${created.token}', 0, ${Date.now() + 86400_000})`,
    );
    expect(await acceptInvite(env, created.token, "9", "mallory")).toEqual({
      ok: false,
      reason: "invalid",
    });
    const alpha = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === "alpha")!;
    expect(alpha.members!.some((m) => m.login === "mallory")).toBe(false);
  });

  it("never records an invite as used by a member write that changed nothing", async () => {
    // What the "used" record is conditioned on: the write right before it.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE d1_groups SET version = version + 1 WHERE id = ? AND version = ?",
      ).bind("alpha", -1),
      env.DB.prepare(
        "INSERT INTO dedup_keys (key, claimed_at, expires_at) SELECT 'probe', 0, 1 WHERE changes() > 0",
      ),
    ]);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM dedup_keys WHERE key = 'probe'").get()).toEqual({
      n: 0,
    });
  });

  it("confirms the invite as used in the transaction that adds the member", async () => {
    const owner = await cookieFor("2", "alice");
    const created = (await adminGroupInvitesPost(
      call("/admin/api/groups/alpha/invites", owner, "POST", { role: "viewer" }),
      "alpha",
    )) as { token: string };
    const result = await acceptInvite(env, created.token, "9", "mallory");
    expect(result).toMatchObject({ ok: true, groupId: "alpha" });
    expect(
      sqlite
        .query("SELECT COUNT(*) AS n FROM dedup_keys WHERE key = ?")
        .get(`accepted:invite-used:${created.token}`),
    ).toEqual({ n: 1 });
  });
});

describe("deletion confirmed on a former group", () => {
  it("never deletes a later group that reused the id, however alike", async () => {
    const owner = await cookieFor("2", "alice");
    const routes = (await adminGroupRoutesGet(
      call("/admin/api/groups/alpha/routes", owner),
      "alpha",
    )) as { revision: string; version: number };
    const listed = (await adminApiGroupsGet(call("/admin/api/groups", owner))) as {
      groups: Array<{ id: string; revision: string }>;
    };
    const rev = listed.groups.find((g) => g.id === "alpha")!.revision;
    await deleteAs(owner, "alpha");
    // Past the retirement: the id is taken again, by a group alike in every
    // field the console shows (and at the same version).
    sqlite.exec("DELETE FROM dedup_keys");
    await createGroup(env.KV, group("alpha", "alice"));
    const del = call(
      `/admin/api/groups/alpha?revision=${rev}&routesRevision=${routes.revision}&version=${routes.version}`,
      owner,
      "DELETE",
    );
    await adminGroupDelete(del, "alpha");
    expect(responseStatus(del)).toBe(409);
    expect((await loadGroups(env.KV, { fresh: true })).some((g) => g.id === "alpha")).toBe(true);
  });
});

describe("bulk deletion and unreadable fragments", () => {
  it("never deletes a group whose fragments cannot be read", async () => {
    sqlite.exec(
      `INSERT INTO d1_fragments (id, group_id, name, node, created_at, updated_at) VALUES ('f', 'alpha', 'f', '{', 0, 0)`,
    );
    const owner = await cookieFor("2", "alice");
    const listed = (await adminApiGroupsGet(call("/admin/api/groups", owner))) as {
      groups: Array<Group & { revision: string }>;
      revision: string;
    };
    const event = call("/admin/api/groups", owner, "PUT", {
      groups: listed.groups.filter((g) => g.id !== "alpha"),
      revision: listed.revision,
    });
    await adminApiGroupsPut(event);
    expect(responseStatus(event)).toBe(409);
    expect((await loadGroups(env.KV, { fresh: true })).some((g) => g.id === "alpha")).toBe(true);
  });
});

describe("invite revocation at commit time", () => {
  it("refuses a revocation whose owner was removed before it committed", async () => {
    const owner = await cookieFor("2", "alice");
    const created = (await adminGroupInvitesPost(
      call("/admin/api/groups/alpha/invites", owner, "POST", { role: "admin" }),
      "alpha",
    )) as { token: string };
    // Alice is removed while her request is under way (after its checks).
    const kvGet = env.KV.get.bind(env.KV);
    let reads = 0;
    env.KV.get = (async (key: string, ...rest: unknown[]) => {
      if (key === `invite:${created.token}` && ++reads === 2) {
        sqlite.exec(
          `UPDATE d1_groups SET data = json_set(data, '$.members', json('[{"login":"bob","role":"owner"}]'), '$.adminIds', json('["bob"]')) WHERE id = 'alpha'`,
        );
      }
      return (kvGet as (...a: unknown[]) => Promise<unknown>)(key, ...rest);
    }) as KVNamespace["get"];
    const del = call(`/admin/api/invites/${created.token}`, owner, "DELETE");
    await adminInviteDelete(del, created.token);
    env.KV.get = kvGet;
    expect(responseStatus(del)).toBe(403);
    expect(await getInvite(env.KV, created.token)).not.toBeNull();
  });
});
