import { describe, it, expect } from "bun:test";
import {
  actionOptions,
  commaEndsValue,
  splitFilterValues,
  eventOptions,
  fieldPathOptions,
  fieldValueOptions,
  isArrayFieldPath,
  validateFilterValue,
  valueOptions,
} from "../app/utils/filter-catalog";

function values(opts: { value: string }[]): string[] {
  return opts.map((o) => o.value);
}

describe("filter catalog options", () => {
  it("lists every event once, formatted events first and Gitea-only events last", () => {
    const opts = eventOptions("en");
    const names = values(opts);
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe("push");
    expect(names).toContain("custom");
    expect(names).toContain("merge_group");
    expect(names.slice(-3)).toEqual(["pull_request_approved", "pull_request_rejected", "wiki"]);
  });

  it("describes every option in both languages and shows the active one", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const opt of [
        ...eventOptions(locale),
        ...actionOptions(locale, []),
        ...fieldPathOptions(locale, []),
      ]) {
        expect(opt.hint).toBeTruthy();
        expect(opt.keywords?.length).toBeGreaterThanOrEqual(2);
        expect(opt.keywords).toContain(opt.hint!);
      }
    }
    const push = eventOptions("zh").find((o) => o.value === "push")!;
    expect(push.hint).toBe("推送提交到分支或标签");
    expect(push.keywords).toContain("Commits pushed to a branch or tag");
  });

  it("puts the actions of the route's events first without duplicates", () => {
    const opts = actionOptions("en", ["pull_request"]);
    const names = values(opts);
    expect(new Set(names).size).toBe(names.length);
    expect(opts[0]!.group).toBe("For the selected events");
    expect(names.indexOf("synchronize")).toBeLessThan(names.indexOf("published"));
    // Actions stay searchable by the events that send them.
    expect(opts.find((o) => o.value === "published")!.keywords).toContain("release");
  });

  it("offers the full action list when no event is known", () => {
    const opts = actionOptions("en", []);
    expect(opts.every((o) => o.group === undefined)).toBe(true);
    expect(values(opts)).toContain("label_updated");
  });

  it("ranks field paths of the route's events first", () => {
    const opts = fieldPathOptions("en", ["workflow_run"]);
    const names = values(opts);
    expect(new Set(names).size).toBe(names.length);
    expect(opts[0]!.value.startsWith("workflow_run.")).toBe(true);
    expect(opts.find((o) => o.value === "sender.login")!.group).toBe("All events");
  });

  it("knows the values of enumerated fields", () => {
    expect(values(fieldValueOptions("en", "workflow_run.conclusion"))).toContain("failure");
    expect(values(fieldValueOptions("en", " pull_request.draft "))).toEqual(["true", "false"]);
    expect(fieldValueOptions("en", "comment.body")).toEqual([]);
    for (const path of ["review.state", "deployment_status.state", "alert.rule.severity"]) {
      expect(fieldValueOptions("zh", path).every((o) => !!o.hint)).toBe(true);
    }
  });

  it("suggests values per filter type and none for free-form ones", () => {
    expect(values(valueOptions("en", "actor", "eq", "", []))).toContain("*[bot]");
    expect(values(valueOptions("en", "branch", "eq", "", []))).toContain("main");
    expect(valueOptions("en", "repo", "eq", "", [])).toEqual([]);
    expect(valueOptions("en", "keyword", "eq", "", [])).toEqual([]);
  });

  it("ignores typed event names that are not catalog entries", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      const opts = actionOptions("en", [name]);
      expect(opts.every((o) => typeof o.value === "string")).toBe(true);
      expect(opts.every((o) => o.group === undefined)).toBe(true);
    }
  });
});

describe("validateFilterValue", () => {
  it("accepts event names, globs and regexes", () => {
    expect(validateFilterValue("event", "eq", "pull_request")).toBeNull();
    expect(validateFilterValue("event", "eq", "pull_request*")).toBeNull();
    expect(validateFilterValue("event", "eq", "/^issue/")).toBeNull();
    expect(validateFilterValue("event", "eq", "pull request")).toBe("valid.event");
    expect(validateFilterValue("event", "eq", "/(/")).toBe("valid.regex");
  });

  it("keeps repository and actor values free-form (custom webhooks carry any string)", () => {
    expect(validateFilterValue("repo", "eq", "acme/widget")).toBeNull();
    expect(validateFilterValue("repo", "eq", "monitoring/production cluster")).toBeNull();
    expect(validateFilterValue("actor", "eq", "*[bot]*")).toBeNull();
    expect(validateFilterValue("actor", "eq", "CI Agent")).toBeNull();
  });

  it("checks branches and numbers", () => {
    expect(validateFilterValue("branch", "eq", "release/*")).toBeNull();
    expect(validateFilterValue("branch", "eq", "refs/tags/v*")).toBeNull();
    // code_scanning_alert carries the full ref, so refs/heads/... can match.
    expect(validateFilterValue("branch", "eq", "refs/heads/main")).toBeNull();
    expect(validateFilterValue("branch", "eq", "a:b")).toBe("valid.branch");
    expect(validateFilterValue("branch", "eq", "feature x")).toBe("valid.branch");
    expect(validateFilterValue("branch", "eq", "fix\tbug")).toBe("valid.branch");
    // Git allows non-ASCII whitespace inside refs.
    expect(validateFilterValue("branch", "eq", "release/版本\u30001")).toBeNull();
    expect(validateFilterValue("branch", "eq", "topic\u00a0a")).toBeNull();
    // `[` is literal for every operator; substring operators read `*`/`?` literally too.
    expect(validateFilterValue("branch", "eq", "release/[0-9]")).toBe("valid.branch");
    expect(validateFilterValue("branch", "eq", "/^release\\/[0-9]+$/")).toBeNull();
    expect(validateFilterValue("branch", "startsWith", "release/")).toBeNull();
    expect(validateFilterValue("branch", "startsWith", "release/*")).toBe("valid.branchLiteral");
    expect(validateFilterValue("branch", "contains", "a b")).toBe("valid.branchLiteral");
    expect(validateFilterValue("repo", "contains", "a*b")).toBeNull();
    expect(validateFilterValue("field", "gte", "10")).toBeNull();
    expect(validateFilterValue("field", "lt", "ten")).toBe("valid.number");
  });

  it("treats the regex operator as a raw pattern and keyword as free text", () => {
    expect(validateFilterValue("repo", "regex", "^acme/")).toBeNull();
    expect(validateFilterValue("repo", "regex", "(")).toBe("valid.regex");
    expect(validateFilterValue("keyword", "exists", "any text")).toBeNull();
    expect(validateFilterValue("keyword", "eq", "/[/")).toBe("valid.regex");
    expect(validateFilterValue("action", "eq", "Deploy Docs")).toBeNull();
  });

  it("rejects patterns the server would never match", () => {
    expect(validateFilterValue("event", "eq", "a*".repeat(101))).toBe("valid.tooLong");
    expect(validateFilterValue("field", "regex", "a".repeat(201))).toBe("valid.tooLong");
  });
});

describe("splitFilterValues", () => {
  it("splits on commas and lines", () => {
    expect(splitFilterValues("push, issues\nrelease,")).toEqual(["push", "issues", "release"]);
    expect(splitFilterValues(" , \r\n ")).toEqual([]);
  });

  it("keeps the commas of a wrapped regex", () => {
    expect(splitFilterValues("main,/release-[0-9]{1,3}/")).toEqual([
      "main",
      "/release-[0-9]{1,3}/",
    ]);
    expect(splitFilterValues("/a,b/ , /c/d,e/,f")).toEqual(["/a,b/", "/c/d,e/", "f"]);
    // An unterminated regex is ordinary text.
    expect(splitFilterValues("/a{1,2")).toEqual(["/a{1", "2"]);
  });

  it("never closes a regex at an escaped slash or inside a character class", () => {
    expect(splitFilterValues("/[/,]/")).toEqual(["/[/,]/"]);
    expect(splitFilterValues("/a\\/,b/,c")).toEqual(["/a\\/,b/", "c"]);
    expect(splitFilterValues("/[\\]/,]x/")).toEqual(["/[\\]/,]x/"]);
  });

  it("splits raw regex patterns on lines only", () => {
    expect(splitFilterValues("^v{1,3}$\n[a,b]", false)).toEqual(["^v{1,3}$", "[a,b]"]);
  });
});

describe("commaEndsValue", () => {
  it("ends a value only when the comma is typed at its end", () => {
    expect(commaEndsValue("push", 4, 4)).toBe(true);
    expect(commaEndsValue("push ", 5, 5)).toBe(true);
    expect(commaEndsValue("push", 2, 2)).toBe(false);
    // Typing over a selection replaces it, like any other character.
    expect(commaEndsValue("push", 0, 4)).toBe(false);
  });

  it("keeps commas inside a regex that is still open", () => {
    expect(commaEndsValue("/a{1", 4, 4)).toBe(false);
    expect(commaEndsValue("/[/", 3, 3)).toBe(false);
    expect(commaEndsValue("/a{1,3}/", 8, 8)).toBe(true);
    // Editing a finished regex: the caret sits inside it.
    expect(commaEndsValue("/a{13}/", 4, 4)).toBe(false);
  });

  it("never ends raw patterns", () => {
    expect(commaEndsValue("^v{1", 4, 4, false)).toBe(false);
  });
});

describe("isArrayFieldPath", () => {
  it("flags suggested paths that end on an array", () => {
    expect(isArrayFieldPath("commits.modified")).toBe(true);
    expect(isArrayFieldPath(" repository.topics ")).toBe(true);
    expect(isArrayFieldPath("commits.message")).toBe(false);
    expect(isArrayFieldPath("build status")).toBe(false);
  });
});
