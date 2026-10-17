import { describe, it, expect } from "bun:test";
import { adminGroupPath, parseAdminPath } from "../app/utils/admin-path";

describe("parseAdminPath", () => {
  it("maps the console pages", () => {
    expect(parseAdminPath(undefined)).toEqual({ view: "overview", groupId: null });
    expect(parseAdminPath([])).toEqual({ view: "overview", groupId: null });
    expect(parseAdminPath("logs")).toEqual({ view: "logs", groupId: null });
    expect(parseAdminPath(["groups"])).toEqual({ view: "groups", groupId: null });
    expect(parseAdminPath(["metrics"])).toEqual({ view: "metrics", groupId: null });
  });

  it("opens a group's routes under /admin/groups/{groupId}", () => {
    expect(parseAdminPath(["groups", "inst-12345678"])).toEqual({
      view: "groups",
      groupId: "inst-12345678",
    });
    // A trailing slash adds an empty segment.
    expect(parseAdminPath(["groups", ""])).toEqual({ view: "groups", groupId: null });
    expect(parseAdminPath(["groups", "acme", ""])).toEqual({ view: "groups", groupId: "acme" });
  });

  it("rejects unknown pages and sub-pages", () => {
    expect(parseAdminPath(["foo"])).toBeNull();
    expect(parseAdminPath(["logs", "x"])).toBeNull();
    expect(parseAdminPath(["groups", "acme", "routes"])).toBeNull();
    expect(parseAdminPath(["constructor"])).toBeNull();
  });
});

describe("adminGroupPath", () => {
  it("encodes the group id", () => {
    expect(adminGroupPath("acme")).toBe("/admin/groups/acme");
    expect(adminGroupPath("a/b c")).toBe("/admin/groups/a%2Fb%20c");
  });
});
