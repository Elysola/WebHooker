import { describe, it, expect } from "bun:test";
import { blankNode, isBlankNode } from "../app/composables/useFilterNode";

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
  });
});
