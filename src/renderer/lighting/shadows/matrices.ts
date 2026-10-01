import { mat4, vec3 } from 'gl-matrix';
import type { LightInstance } from '../../../scene/lights';
import type { Bounds } from '../../scene/frustum';

const axes = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const ups = [
  [0, -1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, -1, 0],
  [0, -1, 0],
];
export function pointShadowFace(ray: ArrayLike<number>): number {
  const x = Math.abs(ray[0]),
    y = Math.abs(ray[1]),
    z = Math.abs(ray[2]);
  return x >= y && x >= z
    ? ray[0] >= 0
      ? 0
      : 1
    : y >= z
      ? ray[1] >= 0
        ? 2
        : 3
      : ray[2] >= 0
        ? 4
        : 5;
}

/** Camera-independent fitting includes receivers and off-camera casters. A single
 * directional map covers the scene envelope; point maps follow the same cube face
 * convention as the fragment shader. All projections use WebGPU's [0,1] depth. */
export function shadowMatrices(light: LightInstance, bounds: Bounds): mat4[] {
  const center = vec3.scale(vec3.create(), vec3.add(vec3.create(), bounds.min, bounds.max), 0.5);
  const radius = Math.max(vec3.distance(bounds.min, bounds.max) * 0.5, 0.01);
  const up =
    Math.abs(light.direction[1]) > 0.99 ? vec3.fromValues(0, 0, 1) : vec3.fromValues(0, 1, 0);
  if (light.type === 'directional') {
    const padding = radius * 0.05 + 0.001;
    const distance = radius + padding;
    const eye = vec3.scaleAndAdd(vec3.create(), center, light.direction, -distance);
    const view = mat4.lookAt(mat4.create(), eye, center, up);
    const projection = mat4.orthoZO(
      mat4.create(),
      -distance,
      distance,
      -distance,
      distance,
      0.001,
      2 * distance + padding,
    );
    return [mat4.multiply(mat4.create(), projection, view)];
  }
  const far = light.range || Math.max(vec3.distance(light.position, center) + radius * 1.05, 0.01);
  // Avoid an excessively tiny near plane: perspective depth would otherwise collapse
  // distant receiver/caster separation beneath even a modest comparison bias.
  const near = Math.max(far * 0.001, Math.min(0.01, far * 0.01));
  const projection = mat4.perspectiveZO(
    mat4.create(),
    light.type === 'point' ? Math.PI / 2 : Math.min(2 * light.outer, Math.PI - 0.001),
    1,
    near,
    far,
  );
  const directions = light.type === 'point' ? axes : [light.direction];
  return directions.map((direction, i) => {
    const target = vec3.add(vec3.create(), light.position, direction as vec3);
    const view = mat4.lookAt(
      mat4.create(),
      light.position,
      target,
      light.type === 'point' ? (ups[i] as vec3) : up,
    );
    return mat4.multiply(mat4.create(), projection, view);
  });
}
