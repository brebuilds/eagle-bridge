import type { EagleFolder } from "../eagle/client.js";

export interface FlatFolder {
  id: string;
  name: string;
  rootId: string;
  rootName: string;
}

/**
 * Eagle returns folders as a tree. Brand routing keys on the ROOT folder name,
 * so an asset filed in "OIB Guide / Summer / 2026" still routes to OIB.Guide.
 * `seen` guards against a cyclic tree, which would otherwise hang the request.
 */
export function flattenFolders(tree: EagleFolder[]): FlatFolder[] {
  const out: FlatFolder[] = [];
  const seen = new Set<string>();

  const walk = (node: EagleFolder, rootId: string, rootName: string): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    out.push({ id: node.id, name: node.name, rootId, rootName });
    for (const child of node.children ?? []) walk(child, rootId, rootName);
  };

  for (const root of tree) walk(root, root.id, root.name);
  return out;
}
