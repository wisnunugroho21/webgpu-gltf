import { mat4, quat, vec3 } from 'gl-matrix';
import type { Gltf, Primitive } from './types';

export interface Instance {
  node: number;
  world: mat4;
  normal: mat4;
  mirrored: boolean;
}

function sceneRoots(gltf: Gltf): number[] {
  const nodes = gltf.nodes ?? [];
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  if (gltf.scenes?.length && !scene) throw new Error('Invalid default scene.');
  const children = new Set(nodes.flatMap((node) => node.children ?? []));
  return (
    scene?.nodes ??
    (gltf.scenes?.length ? [] : nodes.map((_, i) => i).filter((i) => !children.has(i)))
  );
}

/** Lights and meshes must use exactly the same selected-scene membership rules. */
export function selectedSceneNodes(gltf: Gltf): number[] {
  const result: number[] = [],
    visited = new Set<number>();
  const pending = sceneRoots(gltf).slice().reverse();
  while (pending.length) {
    const index = pending.pop()!;
    const node = gltf.nodes?.[index];
    if (!node || visited.has(index))
      throw new Error('Scene has an invalid node, cycle, or multiple parents.');
    visited.add(index);
    result.push(index);
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  return result;
}

/** Traverse only the selected scene, accumulating parent * local transforms once.
 * Mesh references, rather than geometry copies, become primitive instance lists. */
export function collectInstances(gltf: Gltf): Map<Primitive, Instance[]> {
  const nodes = gltf.nodes ?? [];
  const roots = sceneRoots(gltf);
  const result = new Map<Primitive, Instance[]>();
  const visited = new Set<number>();
  // Each stack entry retains the accumulated parent transform; no JS call-stack
  // depth is consumed, and reverse pushes preserve authored traversal order.
  const pending = roots.map((index) => ({ index, parent: mat4.create() })).reverse();
  while (pending.length) {
    const { index, parent } = pending.pop()!;
    const node = nodes[index];
    if (!node || visited.has(index))
      throw new Error('Scene has an invalid node, cycle, or multiple parents.');
    visited.add(index);
    const local = node.matrix
      ? mat4.clone(node.matrix as mat4)
      : mat4.fromRotationTranslationScale(
          mat4.create(),
          (node.rotation ?? [0, 0, 0, 1]) as quat,
          (node.translation ?? [0, 0, 0]) as vec3,
          (node.scale ?? [1, 1, 1]) as vec3,
        );
    const world = mat4.multiply(mat4.create(), parent, local);
    const inverse = mat4.invert(mat4.create(), world);
    // Mesh-node transforms do not affect skinning; joints may also pass through zero scale.
    if (!inverse && node.mesh !== undefined && node.skin === undefined)
      throw new Error('A node has a singular transform (for example zero scale).');
    const normal = inverse ?? mat4.create();
    mat4.transpose(normal, normal);
    const instance = { node: index, world, normal, mirrored: mat4.determinant(world) < 0 };
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes?.[node.mesh];
      if (!mesh) throw new Error('Node references a missing mesh.');
      for (const primitive of mesh.primitives) {
        const list = result.get(primitive) ?? [];
        list.push(instance);
        result.set(primitive, list);
      }
    }
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--)
      pending.push({ index: children[i], parent: world });
  }
  return result;
}
