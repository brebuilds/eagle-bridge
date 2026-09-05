import { describe, it, expect } from "vitest";
import { flattenFolders } from "../src/folders/flatten.js";

describe("flattenFolders", () => {
  it("maps a top-level folder to itself as root", () => {
    const out = flattenFolders([{ id: "f1", name: "OIB Guide" }]);
    expect(out).toEqual([{ id: "f1", name: "OIB Guide", rootId: "f1", rootName: "OIB Guide" }]);
  });

  it("resolves a nested folder to its ROOT ancestor, not its parent", () => {
    const out = flattenFolders([
      { id: "f1", name: "OIB Guide", children: [
        { id: "f2", name: "Summer", children: [{ id: "f3", name: "2026" }] },
      ] },
    ]);
    expect(out.find((f) => f.id === "f3")).toEqual({
      id: "f3", name: "2026", rootId: "f1", rootName: "OIB Guide",
    });
  });

  it("keeps sibling roots independent", () => {
    const out = flattenFolders([
      { id: "a", name: "OIB Guide", children: [{ id: "a1", name: "Sub" }] },
      { id: "b", name: "Threads for Heads", children: [{ id: "b1", name: "Sub" }] },
    ]);
    expect(out.find((f) => f.id === "a1")!.rootName).toBe("OIB Guide");
    expect(out.find((f) => f.id === "b1")!.rootName).toBe("Threads for Heads");
  });

  it("returns an empty array for an empty tree", () => {
    expect(flattenFolders([])).toEqual([]);
  });

  it("does not infinitely recurse on a cyclic tree", () => {
    const a: any = { id: "a", name: "A" };
    a.children = [a];
    expect(() => flattenFolders([a])).not.toThrow();
    expect(flattenFolders([a]).length).toBe(1);
  });
});
