import { describe, it, expect } from "bun:test";
import handler from "../server/routes/admin/api/[...slug]";
import { makeEvent, responseHeader, responseStatus } from "./helpers";

describe("admin API route", () => {
  it("never lets a response be cached", async () => {
    const event = makeEvent("/admin/api/nope", { env: { GITHUB_WEBHOOK_SECRET: "s" } as never });
    event.context.params = { slug: "nope" };
    const res = await handler(event);
    expect(responseStatus(event)).toBe(404);
    expect(res).toEqual({ error: "Not found" });
    expect(responseHeader(event, "cache-control")).toBe("no-store");
  });
});
