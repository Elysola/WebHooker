import { describe, it, expect } from "bun:test";
import {
  blankNode,
  formToLeaf,
  hasPendingDraft,
  isBlankNode,
  nodeKey,
  nodeToForm,
  scopeEvents,
} from "../app/composables/useFilterNode";
import type { LeafForm } from "../app/composables/useFilterNode";

function leaf(overrides: Partial<LeafForm>): LeafForm {
  return {
    type: "event",
    path: "",
    op: "eq",
    values: [],
    exclude: false,
    draft: "",
    ...overrides,
  };
}

describe("scopeEvents", () => {
  it("collects exact event names the route positively filters on", () => {
    const form = nodeToForm({
      all: [
        { type: "event", match: ["pull_request", "Issues"] },
        {
          any: [
            { type: "event", match: "release" },
            { type: "repo", match: "acme/*" },
          ],
        },
        { type: "event", match: "push", exclude: true },
        { not: { type: "event", match: "star" } },
        { type: "event", match: "check_*" },
        { type: "event", op: "ne", match: "fork" },
      ],
    });
    expect(scopeEvents(form).sort()).toEqual(["issues", "pull_request", "release"]);
  });
});

describe("isBlankNode", () => {
  it("treats untouched conditions and groups as blank", () => {
    expect(isBlankNode(blankNode("leaf"))).toBe(true);
    expect(isBlankNode(blankNode("all"))).toBe(true);
    expect(isBlankNode(blankNode("not"))).toBe(true);
  });

  it("treats any value, path or negation as content", () => {
    const withValue = blankNode("all");
    withValue.children[0]!.leaf.values = ["push"];
    expect(isBlankNode(withValue)).toBe(false);
    const negated = blankNode("leaf");
    negated.leaf.exclude = true;
    expect(isBlankNode(negated)).toBe(false);
    const withPath = blankNode("leaf");
    withPath.leaf.path = "sender.login";
    expect(isBlankNode(withPath)).toBe(false);
    // `exists` is a complete condition without any value.
    const exists = blankNode("all");
    exists.children[0]!.leaf.type = "branch";
    exists.children[0]!.leaf.op = "exists";
    expect(isBlankNode(exists)).toBe(false);
    // Typed text not added yet is content as well.
    const typed = blankNode("not");
    typed.child!.leaf.draft = "my_event";
    expect(isBlankNode(typed)).toBe(false);
  });
});

describe("hasPendingDraft", () => {
  it("finds unadded text anywhere in the tree", () => {
    const form = nodeToForm({ all: [{ type: "event", match: "push" }, { not: { type: "repo" } }] });
    expect(hasPendingDraft(form)).toBe(false);
    form.children[1]!.child!.leaf.draft = "  ";
    expect(hasPendingDraft(form)).toBe(false);
    form.children[1]!.child!.leaf.draft = "acme/*";
    expect(hasPendingDraft(form)).toBe(true);
  });

  it("follows the leaf when a NOT is unwrapped or the root is wrapped", () => {
    const not = blankNode("not");
    not.child!.leaf.draft = "my_event";
    // What FilterNodeEditor's unwrap and RouteEditor's fragment insert do.
    const unwrapped = { ...not, kind: not.child!.kind, leaf: not.child!.leaf };
    expect(hasPendingDraft(unwrapped)).toBe(true);
    const wrapped = { ...blankNode("all"), children: [unwrapped, blankNode("leaf")] };
    expect(hasPendingDraft(wrapped)).toBe(true);
  });
});

describe("formToLeaf", () => {
  it("never stores an operator on keyword filters", () => {
    expect(formToLeaf(leaf({ type: "keyword", op: "exists", values: ["hotfix"] }))).toEqual({
      type: "keyword",
      match: "hotfix",
    });
  });

  it("keeps operators on other filters", () => {
    expect(formToLeaf(leaf({ type: "field", path: "pull_request.draft", op: "exists" }))).toEqual({
      type: "field",
      path: "pull_request.draft",
      op: "exists",
    });
  });
});

describe("nodeKey", () => {
  it("is stable per node and unique across nodes", () => {
    const a = blankNode("leaf");
    const b = blankNode("leaf");
    expect(nodeKey(a)).toBe(nodeKey(a));
    expect(nodeKey(a)).not.toBe(nodeKey(b));
  });
});
