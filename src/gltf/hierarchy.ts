import type { Gltf } from './types';

type Node = NonNullable<Gltf['nodes']>[number];
export interface NodeForest {
  /** -1 marks a root; all other values are validated node indices. */
  parents: Int32Array;
  /** Authored root/child order, with every parent preceding its descendants. */
  order: number[];
}
export interface NodeHierarchyIssue {
  kind: 'children' | 'child' | 'multiple-parent' | 'cycle';
  /** The definition owning an invalid children list/reference, when applicable. */
  parent?: number;
}

/** Validate the complete indexed glTF forest, including unselected nodes. Metadata
 * decoding and Pose need the same topology contract, but supply their own diagnostics.
 * This does not select a scene or evaluate transforms. */
export function buildNodeForest(
  nodes: readonly Node[],
  reject: (issue: NodeHierarchyIssue) => never,
): NodeForest {
  const parents = new Int32Array(nodes.length).fill(-1);
  for (let parent = 0; parent < nodes.length; parent++) {
    const children = nodes[parent].children;
    if (children === undefined) continue;
    if (!Array.isArray(children)) reject({ kind: 'children', parent });
    for (const child of children) {
      if (!Number.isSafeInteger(child) || child < 0 || !nodes[child])
        reject({ kind: 'child', parent });
      if (parents[child] !== -1) reject({ kind: 'multiple-parent', parent });
      parents[child] = parent;
    }
  }
  const pending: number[] = [];
  for (let index = nodes.length - 1; index >= 0; index--)
    if (parents[index] === -1) pending.push(index);
  const order: number[] = [];
  while (pending.length) {
    const index = pending.pop()!;
    order.push(index);
    const children = nodes[index].children ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  // With one parent per node, a cycle cannot be reached from a root. Incomplete
  // coverage therefore identifies a disconnected cycle without a recursive DFS.
  if (order.length !== nodes.length) reject({ kind: 'cycle' });
  return { parents, order };
}

function sceneRoots(gltf: Gltf): readonly number[] {
  const nodes = gltf.nodes ?? [];
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  if (gltf.scenes?.length && !scene) throw new Error('Invalid default scene.');
  if (scene?.nodes !== undefined) return scene.nodes;
  if (gltf.scenes?.length) return [];
  const children = new Set(nodes.flatMap((node) => node.children ?? []));
  return nodes.map((_, i) => i).filter((i) => !children.has(i));
}

/** Visit only selected-scene membership. Repeated reachability is an error here,
 * unlike descendant expansion. Parent state is carried on the iterative stack so
 * mesh collection can accumulate matrices without storing worlds for unused nodes.
 * Each visitor returns the state to pass to its children; it owns state allocation. */
export function walkSelectedScene<T>(
  gltf: Gltf,
  rootState: T,
  visit: (index: number, parentState: T) => T,
): void {
  const nodes = gltf.nodes ?? [];
  const visited = new Set<number>();
  const pending = sceneRoots(gltf)
    .slice()
    .reverse()
    .map((index) => ({ index, state: rootState }));
  while (pending.length) {
    const { index, state } = pending.pop()!;
    const node = nodes[index];
    if (!Number.isSafeInteger(index) || index < 0 || !node || visited.has(index))
      throw new Error('Scene has an invalid node, cycle, or multiple parents.');
    visited.add(index);
    const childState = visit(index, state);
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--)
      pending.push({ index: children[i], state: childState });
  }
}
