import type { Filter, FilterNode, FilterOp, FilterType } from "~/types";

export interface LeafForm {
  type: FilterType;
  path: string;
  op: FilterOp;
  values: string[];
  exclude: boolean;
}

export type NodeKind = "leaf" | "all" | "any" | "not";

export interface NodeForm {
  kind: NodeKind;
  leaf: LeafForm;
  children: NodeForm[];
  child: NodeForm | null;
}

export function blankLeafForm(): LeafForm {
  return { type: "event", path: "", op: "eq", values: [], exclude: false };
}

export function blankNode(kind: NodeKind): NodeForm {
  return {
    kind,
    leaf: blankLeafForm(),
    children: kind === "all" || kind === "any" ? [blankNode("leaf")] : [],
    child: kind === "not" ? blankNode("leaf") : null,
  };
}

function matchToValues(match: string | string[] | undefined): string[] {
  if (match === undefined || match === null) return [];
  return Array.isArray(match) ? [...match] : [match];
}

function leafToForm(f: Filter): LeafForm {
  return {
    type: f.type,
    path: f.path ?? "",
    op: f.op ?? "eq",
    values: matchToValues(f.match),
    exclude: !!f.exclude,
  };
}

export function nodeToForm(node: FilterNode): NodeForm {
  if ("all" in node) {
    return { kind: "all", leaf: blankLeafForm(), children: node.all.map(nodeToForm), child: null };
  }
  if ("any" in node) {
    return { kind: "any", leaf: blankLeafForm(), children: node.any.map(nodeToForm), child: null };
  }
  if ("not" in node) {
    return { kind: "not", leaf: blankLeafForm(), children: [], child: nodeToForm(node.not) };
  }
  return { kind: "leaf", leaf: leafToForm(node), children: [], child: null };
}

export function formToLeaf(lf: LeafForm): Filter | null {
  const values = lf.values.map((v) => v.trim()).filter((v) => v.length > 0);
  if (lf.op !== "exists" && values.length === 0) return null;
  if (lf.type === "field" && lf.path.trim().length === 0) return null;
  const filter: Filter = { type: lf.type };
  if (lf.type === "field") filter.path = lf.path.trim();
  if (lf.op !== "eq") filter.op = lf.op;
  if (lf.op !== "exists") filter.match = values.length === 1 ? values[0] : values;
  if (lf.exclude) filter.exclude = true;
  return filter;
}

export function formToNode(nf: NodeForm): FilterNode | null {
  if (nf.kind === "leaf") return formToLeaf(nf.leaf);
  if (nf.kind === "all" || nf.kind === "any") {
    const children = nf.children.map(formToNode).filter((c): c is FilterNode => c !== null);
    if (children.length === 0) return null;
    return nf.kind === "all" ? { all: children } : { any: children };
  }
  if (nf.kind === "not") {
    const child = nf.child ? formToNode(nf.child) : null;
    if (!child) return null;
    return { not: child };
  }
  return null;
}

export function isTrivialNode(nf: NodeForm): boolean {
  if (nf.kind === "leaf") {
    return nf.leaf.type !== "field" && nf.leaf.op === "eq" && !nf.leaf.exclude;
  }
  if (nf.kind === "all") return nf.children.every(isTrivialNode);
  return false;
}

export function flattenLeaves(nf: NodeForm): Filter[] {
  const out: Filter[] = [];
  const walk = (n: NodeForm): void => {
    if (n.kind === "leaf") {
      const f = formToLeaf(n.leaf);
      if (f) out.push(f);
      return;
    }
    if (n.kind === "all" || n.kind === "any") n.children.forEach(walk);
    else if (n.kind === "not" && n.child) walk(n.child);
  };
  walk(nf);
  return out;
}

export function nodeFormToRouteFilters(nf: NodeForm): { filters: Filter[]; ast?: FilterNode } {
  if (isTrivialNode(nf)) {
    return { filters: flattenLeaves(nf) };
  }
  const ast = formToNode(nf);
  return { filters: [], ast: ast ?? undefined };
}

/**
 * Whether a node holds nothing worth confirming before it is removed: an
 * untouched condition (default operator, no path, no values, not negated) or
 * groups made only of those. A changed operator counts as content, since
 * e.g. `exists` is a complete condition without values.
 */
export function isBlankNode(nf: NodeForm): boolean {
  if (nf.kind === "leaf") {
    const { exclude, op, path, values } = nf.leaf;
    return !exclude && op === "eq" && !path.trim() && values.every((v) => !v.trim());
  }
  if (nf.kind === "all" || nf.kind === "any") return nf.children.every(isBlankNode);
  return !nf.child || isBlankNode(nf.child);
}

export function collectEvents(node: FilterNode): string[] {
  const out: string[] = [];
  const walk = (n: FilterNode): void => {
    if ("all" in n) {
      n.all.forEach(walk);
      return;
    }
    if ("any" in n) {
      n.any.forEach(walk);
      return;
    }
    if ("not" in n) {
      walk(n.not);
      return;
    }
    if (n.type === "event") {
      const m = n.match;
      if (Array.isArray(m)) out.push(...m);
      else if (typeof m === "string" && m) out.push(m);
    }
  };
  walk(node);
  return out;
}

export function describeLeaf(f: Filter, t: (key: string) => string): string {
  const label = f.type === "field" ? (f.path ?? f.type) : t("filter." + f.type);
  const op = f.op ?? "eq";
  const match = f.match;
  const values = match === undefined ? [] : Array.isArray(match) ? match : [match];
  const value = values.map((v) => JSON.stringify(v)).join(` ${t("filterNode.or")} `) || "\u2205";
  let base: string;
  if (f.type === "keyword") {
    base = `${label} ${t("filterNode.matches")} ${value}`;
  } else if (op === "exists") {
    base = `${label} ${t("filterOp.exists")}`;
  } else if (op === "eq") {
    base = `${label} ${t("filterNode.is")} ${value}`;
  } else {
    base = `${label} ${t("filterOp." + op)} ${value}`;
  }
  return f.exclude ? `${t("filterNode.not")} (${base})` : base;
}

export function describeNode(node: FilterNode, t: (key: string) => string): string {
  if ("all" in node) {
    return node.all
      .map((c) => describeNode(c, t))
      .filter((s) => s.length)
      .join(` ${t("filterNode.and")} `);
  }
  if ("any" in node) {
    const parts = node.any.map((c) => describeNode(c, t)).filter((s) => s.length);
    return parts.length ? `(${parts.join(` ${t("filterNode.or")} `)})` : "";
  }
  if ("not" in node) {
    return `${t("filterNode.not")} (${describeNode(node.not, t)})`;
  }
  return describeLeaf(node, t);
}
