import { mat4, vec3 } from 'gl-matrix';
import type { Entity } from '../entity';
import type { Point3 } from './contracts';

/** Call world.updateTransforms() before converting. Physics positions are global;
 * entity translations are local, including rotated/scaled parents. The upright
 * controller keeps its world capsule orientation; local facing is visual only. */
export function writePhysicsPosition(entity: Entity, position: Point3, parent?: Entity): void {
  const local = vec3.fromValues(...position);
  if (parent) {
    const inverse = mat4.invert(mat4.create(), parent.worldMatrix);
    if (!inverse) throw new Error('Physics parent transform must be invertible.');
    vec3.transformMat4(local, local, inverse);
  }
  entity.setTransform({ translation: [local[0], local[1], local[2]] }, 'physics');
}
