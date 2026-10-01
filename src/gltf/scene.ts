import { mat4, quat, vec3 } from 'gl-matrix';
import type { Gltf, Primitive } from './types';

export interface Instance {
  node: number;
  world: mat4;
  normal: mat4;
  mirrored: boolean;
}

/** Traverse only the selected scene, accumulating parent * local transforms once.
 * Mesh references, rather than geometry copies, become primitive instance lists. */
export function collectInstances(gltf: Gltf): Map<Primitive, Instance[]> {
  const nodes = gltf.nodes ?? [];
  const children = new Set(nodes.flatMap((node) => node.children ?? []));
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  if (gltf.scenes?.length && !scene) throw new Error('Invalid default scene.');
  const roots =
    scene?.nodes ??
    (gltf.scenes?.length
      ? []
      : nodes.map((_, index) => index).filter((index) => !children.has(index)));
  const result = new Map<Primitive, Instance[]>();
  const visited = new Set<number>();
  const visit = (index: number, parent: mat4) => {
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
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const root of roots) visit(root, mat4.create());
  return result;
}
