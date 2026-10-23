import { RE2JS } from "re2js";
import type { WebhookEvent, Filter, FilterNode, FilterOp } from "../types";

/** A compiled user pattern; `test` searches (like `RegExp#test`). */
interface Pattern {
  test(text: string): boolean;
}

const patternCache = new Map<string, Pattern | null>();
const keywordBodyCache = new WeakMap<WebhookEvent, string>();
const MAX_PATTERN_LENGTH = 200;
const MAX_CACHED_PATTERNS = 500;

function isWrappedRegex(pattern: string): boolean {
  return pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/");
}

/**
 * Compile with RE2 (re2js): matching runs in time linear in the input, so no
 * pattern — however it nests or repeats — can stall a Worker on a crafted
 * payload. RE2 has no backreferences or lookaround; such patterns are invalid.
 */
function compileRe2(source: string): Pattern {
  const re = RE2JS.compile(source, RE2JS.CASE_INSENSITIVE);
  return { test: (text: string): boolean => re.matcher(text).find() };
}

/**
 * Why a user-supplied regex cannot be used, or null when it is fine. Patterns
 * run on the linear-time RE2 engine, so only the length limit and the RE2
 * syntax (no backreferences or lookaround) constrain them.
 */
export function regexSafetyIssue(source: string): string | null {
  if (source.length > MAX_PATTERN_LENGTH) return "pattern is too long";
  try {
    compileRe2(source);
    return null;
  } catch {
    return "invalid or unsupported regular expression (RE2 syntax: no backreferences or lookaround)";
  }
}

function cached(key: string, build: () => Pattern | null): Pattern | null {
  if (patternCache.has(key)) {
    // Most recently used last: the oldest unused pattern is evicted first.
    const hit = patternCache.get(key) ?? null;
    patternCache.delete(key);
    patternCache.set(key, hit);
    return hit;
  }
  // Bounded: patterns come from every group's routes and test requests. One
  // pattern makes room at a time — clearing everything would recompile every
  // pattern in use once the limit is reached.
  if (patternCache.size >= MAX_CACHED_PATTERNS) {
    patternCache.delete(patternCache.keys().next().value!);
  }
  const re = build();
  patternCache.set(key, re);
  return re;
}

function compileRegex(pattern: string): Pattern | null {
  // Regex and glob entries live under distinct prefixes: the regex `a:foo*`
  // and the anchored glob `foo*` must never share a cache slot.
  return cached(`r:${pattern}`, () => {
    if (pattern.length > MAX_PATTERN_LENGTH) return null;
    try {
      return compileRe2(pattern);
    } catch {
      return null;
    }
  });
}

function compileGlob(pattern: string, anchored: boolean): Pattern | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return null;
  // Repeated `*` match the same as one; an unanchored search needs no leading
  // or trailing `*` at all.
  let glob = pattern.replace(/\*+/g, "*");
  if (!anchored) glob = glob.replace(/^\*+|\*+$/g, "");
  return cached(`${anchored ? "a" : "s"}:${glob}`, () => {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    // One pass: a sequential replace would rewrite the `?` of `(?s:` again.
    const body = escaped.replace(/[*?]/g, (c) => (c === "*" ? "(?s:.*)" : "(?s:.)"));
    try {
      return compileRe2(anchored ? `^${body}$` : body);
    } catch {
      return null;
    }
  });
}

function isGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

function matchField(pattern: string, value: string): boolean {
  if (isWrappedRegex(pattern)) {
    const re = compileRegex(pattern.slice(1, -1));
    return re ? re.test(value) : false;
  }
  if (isGlob(pattern)) {
    const re = compileGlob(pattern, true);
    return re ? re.test(value) : false;
  }
  return value.toLowerCase() === pattern.toLowerCase();
}

function matchKeyword(pattern: string, body: string): boolean {
  if (isWrappedRegex(pattern)) {
    const re = compileRegex(pattern.slice(1, -1));
    return re ? re.test(body) : false;
  }
  if (isGlob(pattern)) {
    const re = compileGlob(pattern, false);
    return re ? re.test(body) : false;
  }
  return body.includes(pattern.toLowerCase());
}

export function getKeywordBody(event: WebhookEvent): string {
  const cached = keywordBodyCache.get(event);
  if (cached !== undefined) return cached;
  const body = JSON.stringify(event.payload).toLowerCase();
  keywordBodyCache.set(event, body);
  return body;
}

function extractBranch(event: WebhookEvent): string | undefined {
  const p = event.payload;
  switch (event.event) {
    case "push":
      return typeof p.ref === "string" ? p.ref.replace(/^refs\/heads\//, "") : undefined;
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_comment":
      return (p.pull_request as { head?: { ref?: string } } | undefined)?.head?.ref;
    case "create":
    case "delete":
      return typeof p.ref === "string" ? p.ref : undefined;
    case "workflow_run":
      return (p.workflow_run as { head_branch?: string } | undefined)?.head_branch;
    case "check_suite":
      return (p.check_suite as { head_branch?: string } | undefined)?.head_branch;
    case "check_run":
      return (p.check_run as { check_suite?: { head_branch?: string } } | undefined)?.check_suite
        ?.head_branch;
    case "workflow_job":
      return (p.workflow_job as { head_branch?: string } | undefined)?.head_branch;
    case "deployment":
    case "deployment_status": {
      // The deployed ref lives on the deployment object (a top-level `ref` is
      // only read as a fallback).
      const ref = (p.deployment as { ref?: unknown } | undefined)?.ref ?? p.ref;
      return typeof ref === "string" ? ref.replace(/^refs\/heads\//, "") : undefined;
    }
    case "commit_comment":
      return undefined;
    case "code_scanning_alert":
      return typeof p.ref === "string" ? p.ref.replace(/^refs\/heads\//, "") : undefined;
    default:
      return undefined;
  }
}

function toPatterns(filter: Filter): string[] {
  if (filter.match === undefined || filter.match === null) return [];
  return Array.isArray(filter.match) ? filter.match : [filter.match];
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function resolvePath(value: unknown, path: string): unknown[] {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return [value];
  const out: unknown[] = [];
  walkPath(value, parts, 0, out);
  return out;
}

function walkPath(node: unknown, parts: string[], index: number, out: unknown[]): void {
  if (index >= parts.length) {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walkPath(item, parts, index, out);
    return;
  }
  if (node === null || node === undefined || typeof node !== "object") return;
  const next = (node as Record<string, unknown>)[parts[index]!];
  walkPath(next, parts, index + 1, out);
}

function valueList(filter: Filter, event: WebhookEvent): unknown[] {
  const p = event.payload;
  switch (filter.type) {
    case "event":
      return [event.event];
    case "repo":
      return [(p.repository as { full_name?: string } | undefined)?.full_name];
    case "actor":
      return [(p.sender as { login?: string } | undefined)?.login];
    case "action":
      return [typeof p.action === "string" ? p.action : undefined];
    case "branch":
      return [extractBranch(event)];
    case "field":
      return resolvePath(p, filter.path ?? "");
    default:
      return [];
  }
}

function valueMatches(value: unknown, op: FilterOp, patterns: string[]): boolean {
  const text = stringify(value);
  switch (op) {
    case "exists":
      return value !== undefined && value !== null;
    case "ne":
      return !patterns.some((p) => matchField(p, text));
    case "contains":
      return patterns.some((p) => text.toLowerCase().includes(p.toLowerCase()));
    case "startsWith":
      return patterns.some((p) => text.toLowerCase().startsWith(p.toLowerCase()));
    case "endsWith":
      return patterns.some((p) => text.toLowerCase().endsWith(p.toLowerCase()));
    case "regex":
      return patterns.some((p) => {
        const re = compileRegex(p);
        return re ? re.test(text) : false;
      });
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const n = toNumber(value);
      if (n === null) return false;
      return patterns.some((p) => {
        const pn = toNumber(p);
        if (pn === null) return false;
        if (op === "gt") return n > pn;
        if (op === "gte") return n >= pn;
        if (op === "lt") return n < pn;
        return n <= pn;
      });
    }
    case "eq":
    case "in":
    default:
      return patterns.some((p) => matchField(p, text));
  }
}

function matchFilter(filter: Filter, event: WebhookEvent, keywordBody?: string): boolean {
  if (filter.type === "keyword") {
    const body = keywordBody ?? getKeywordBody(event);
    const patterns = toPatterns(filter);
    const matches = patterns.some((p) => matchKeyword(p, body));
    return filter.exclude ? !matches : matches;
  }

  const op = filter.op ?? "eq";
  const patterns = toPatterns(filter);
  const matches = valueList(filter, event).some((v) => valueMatches(v, op, patterns));
  return filter.exclude ? !matches : matches;
}

export function containsKeyword(node: FilterNode): boolean {
  if ("all" in node) return node.all.some(containsKeyword);
  if ("any" in node) return node.any.some(containsKeyword);
  if ("not" in node) return containsKeyword(node.not);
  return node.type === "keyword";
}

export function evaluateFilterNode(
  node: FilterNode,
  event: WebhookEvent,
  keywordBody?: string,
): boolean {
  if ("all" in node) return node.all.every((n) => evaluateFilterNode(n, event, keywordBody));
  if ("any" in node) return node.any.some((n) => evaluateFilterNode(n, event, keywordBody));
  if ("not" in node) return !evaluateFilterNode(node.not, event, keywordBody);
  return matchFilter(node, event, keywordBody);
}

export function explainFilter(filter: Filter): string {
  const patterns = toPatterns(filter);
  const value = patterns.map((m) => JSON.stringify(m)).join(" or ");
  const label = filter.type === "field" ? (filter.path ?? "field") : filter.type;
  const op = filter.op ?? "eq";
  let base: string;
  if (filter.type === "keyword") {
    base = `${label} matches ${value}`;
  } else if (op === "exists") {
    base = `${label} exists`;
  } else if (op === "eq") {
    base = `${label} is ${value}`;
  } else {
    base = `${label} ${op} ${value}`;
  }
  return filter.exclude ? `not (${base})` : base;
}

export function explainFilterNode(node: FilterNode): string {
  if ("all" in node) return `(${node.all.map(explainFilterNode).join(" and ")})`;
  if ("any" in node) return `(${node.any.map(explainFilterNode).join(" or ")})`;
  if ("not" in node) return `not (${explainFilterNode(node.not)})`;
  return explainFilter(node);
}
