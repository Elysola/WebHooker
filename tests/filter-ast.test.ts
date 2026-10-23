import { describe, expect, test } from "bun:test";
import type { FilterNode, WebhookEvent } from "../server/lib/types";
import {
  evaluateFilterNode,
  containsKeyword,
  explainFilter,
  explainFilterNode,
} from "../server/lib/events/filter-ast";
import { matchRoute } from "../server/lib/events/match";

function event(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    event: "pull_request",
    payload: {
      repository: { full_name: "acme/widget" },
      sender: { login: "alice" },
      action: "opened",
    },
    ...overrides,
  };
}

describe("filter-ast evaluateFilterNode", () => {
  test("leaf event matches", () => {
    expect(evaluateFilterNode({ type: "event", match: "pull_request" }, event())).toBe(true);
  });

  test("leaf repo mismatch", () => {
    expect(evaluateFilterNode({ type: "repo", match: "other/repo" }, event())).toBe(false);
  });

  test("all requires every child", () => {
    const node: FilterNode = {
      all: [
        { type: "event", match: "pull_request" },
        { type: "repo", match: "acme/widget" },
      ],
    };
    expect(evaluateFilterNode(node, event())).toBe(true);
  });

  test("all fails when one child fails", () => {
    const node: FilterNode = {
      all: [
        { type: "event", match: "pull_request" },
        { type: "repo", match: "nope/repo" },
      ],
    };
    expect(evaluateFilterNode(node, event())).toBe(false);
  });

  test("any passes when one child matches", () => {
    const node: FilterNode = {
      any: [
        { type: "repo", match: "nope/repo" },
        { type: "event", match: "pull_request" },
      ],
    };
    expect(evaluateFilterNode(node, event())).toBe(true);
  });

  test("not negates", () => {
    expect(evaluateFilterNode({ not: { type: "repo", match: "nope/repo" } }, event())).toBe(true);
  });

  test("nested structure", () => {
    const node: FilterNode = {
      all: [
        { type: "event", match: "pull_request" },
        {
          any: [
            { type: "repo", match: "acme/*" },
            { type: "repo", match: "x/*" },
          ],
        },
        { not: { type: "actor", match: "bob" } },
      ],
    };
    expect(evaluateFilterNode(node, event())).toBe(true);
  });
});

describe("filter-ast containsKeyword", () => {
  test("detects keyword leaf", () => {
    expect(containsKeyword({ type: "keyword", match: "TODO" })).toBe(true);
  });

  test("detects nested keyword", () => {
    expect(
      containsKeyword({
        all: [{ type: "event", match: "push" }, { not: { type: "keyword", match: "TODO" } }],
      }),
    ).toBe(true);
  });

  test("false without keyword", () => {
    expect(containsKeyword({ all: [{ type: "event", match: "push" }] })).toBe(false);
  });
});

describe("filter-ast explain", () => {
  test("explainFilter leaf", () => {
    expect(explainFilter({ type: "event", match: "push" })).toBe('event is "push"');
  });

  test("explainFilter array match", () => {
    expect(explainFilter({ type: "repo", match: ["a/*", "b/*"] })).toBe('repo is "a/*" or "b/*"');
  });

  test("explainFilter exclude", () => {
    expect(explainFilter({ type: "actor", match: "bob", exclude: true })).toBe(
      'not (actor is "bob")',
    );
  });

  test("explainFilterNode all", () => {
    expect(
      explainFilterNode({
        all: [
          { type: "event", match: "push" },
          { type: "repo", match: "acme/*" },
        ],
      }),
    ).toBe('(event is "push" and repo is "acme/*")');
  });

  test("explainFilterNode not", () => {
    expect(explainFilterNode({ not: { type: "event", match: "push" } })).toBe(
      'not (event is "push")',
    );
  });
});

describe("matchRoute AST integration", () => {
  const baseRoute = {
    id: "r1",
    name: "route",
    enabled: true,
    filters: [{ type: "event" as const, match: "pull_request" }],
    targets: [{ platform: "discord" as const, channelId: "c1" }],
  };

  test("flat filters act as AND", () => {
    const route = {
      ...baseRoute,
      filters: [
        { type: "event" as const, match: "pull_request" },
        { type: "repo" as const, match: "acme/widget" },
      ],
    };
    expect(matchRoute(route, event())).toBe(true);
  });

  test("ast overrides flat filters", () => {
    const route = {
      ...baseRoute,
      ast: {
        any: [
          { type: "repo" as const, match: "nope/*" },
          { type: "event" as const, match: "pull_request" },
        ],
      } as FilterNode,
    };
    expect(matchRoute(route, event())).toBe(true);
  });

  test("disabled route never matches", () => {
    expect(matchRoute({ ...baseRoute, enabled: false }, event())).toBe(false);
  });
});

describe("filter-ast pattern engine", () => {
  test("runs backtracking-prone patterns in linear time", () => {
    const started = Date.now();
    const text = `${"a".repeat(50_000)}!`;
    for (const match of ["/(a+)+$/", "/a+a+a+a+$/", "*a*a*a*a*b"]) {
      expect(
        evaluateFilterNode(
          { type: "field", path: "body", match },
          event({ payload: { body: text } }),
        ),
      ).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("keeps glob ? and * semantics", () => {
    const ev = event();
    expect(evaluateFilterNode({ type: "repo", match: "acme/w?dget" }, ev)).toBe(true);
    expect(evaluateFilterNode({ type: "repo", match: "acme/*" }, ev)).toBe(true);
    expect(evaluateFilterNode({ type: "repo", match: "acme" }, ev)).toBe(false);
  });
});

describe("filter-ast payload paths", () => {
  test("never reads inherited properties", () => {
    const node = { type: "field" as const, path: "constructor", match: "x" };
    expect(evaluateFilterNode(node, event())).toBe(false);
    expect(evaluateFilterNode({ type: "field", path: "__proto__", op: "exists" }, event())).toBe(
      false,
    );
  });
});
