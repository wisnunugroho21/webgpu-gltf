import { vec3 } from 'gl-matrix';
import { selectedSceneNodes } from '../gltf/scene';
import type { PunctualLight } from '../gltf/types';
import type { Pose } from './pose';

export const maxPunctualLights = 32;
export interface LightInstance {
  node: number;
  type: PunctualLight['type'];
  position: vec3;
  direction: vec3;
  color: number[];
  intensity: number;
  range: number;
  inner: number;
  outer: number;
  revision: number;
}

function finite(value: number, min: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > 3.402823466e38)
    throw new Error(`Invalid light ${label}.`);
  return value;
}

/** Definitions are immutable; only selected light nodes' world revisions update these
 * instances. A definition referenced twice produces two independently positioned lights. */
export class PunctualLights {
  readonly instances: LightInstance[];
  readonly authored: boolean;
  constructor(private pose: Pose) {
    const gltf = pose.asset.gltf;
    this.instances = selectedSceneNodes(gltf).flatMap((node) => {
      const index = gltf.nodes![node].extensions?.KHR_lights_punctual?.light;
      if (index === undefined) return [];
      const definition = gltf.extensions?.KHR_lights_punctual?.lights[index];
      if (!Number.isInteger(index) || !definition)
        throw new Error('Node references a missing punctual light.');
      if (!['directional', 'point', 'spot'].includes(definition.type))
        throw new Error('Invalid punctual light type.');
      const color = definition.color ?? [1, 1, 1];
      if (color.length !== 3 || color.some((c) => !Number.isFinite(c) || c < 0 || c > 1))
        throw new Error('Invalid light color.');
      const intensity = finite(definition.intensity ?? 1, 0, 'intensity');
      const range =
        definition.range === undefined ? 0 : finite(definition.range, Number.MIN_VALUE, 'range');
      if (definition.type === 'directional' && definition.range !== undefined)
        throw new Error('Directional lights cannot have range.');
      if (definition.type === 'spot' && !definition.spot)
        throw new Error('Spot light requires spot parameters.');
      const inner = finite(definition.spot?.innerConeAngle ?? 0, 0, 'inner cone');
      const outer = finite(definition.spot?.outerConeAngle ?? Math.PI / 4, 0, 'outer cone');
      if (definition.type === 'spot' && (inner >= outer || outer > Math.PI / 2))
        throw new Error('Invalid spotlight cone angles.');
      return [
        {
          node,
          type: definition.type,
          position: vec3.create(),
          direction: vec3.create(),
          color: [...color],
          intensity,
          range,
          inner,
          outer,
          revision: -1,
        },
      ];
    });
    if (this.instances.length > maxPunctualLights)
      throw new Error(`At most ${maxPunctualLights} punctual light instances are supported.`);
    this.authored = this.instances.length > 0;
    if (!this.authored)
      this.instances.push({
        node: -1,
        type: 'directional',
        position: vec3.create(),
        direction: vec3.normalize(vec3.create(), vec3.fromValues(-0.4, -0.8, -0.6)),
        color: [1, 1, 1],
        intensity: 3,
        range: 0,
        inner: 0,
        outer: Math.PI / 4,
        revision: 0,
      });
    this.update();
  }
  update(): boolean {
    let changed = false;
    for (const light of this.instances) {
      if (light.node < 0) continue;
      const node = this.pose.nodes[light.node];
      if (light.revision === node.worldRevision) continue;
      light.revision = node.worldRevision;
      changed = true;
      vec3.set(light.position, node.world[12], node.world[13], node.world[14]);
      vec3.set(light.direction, -node.world[8], -node.world[9], -node.world[10]);
      if (vec3.length(light.direction) < 1e-8) vec3.set(light.direction, 0, 0, -1);
      else vec3.normalize(light.direction, light.direction);
    }
    return changed;
  }
}

/** CPU counterparts used for attenuation regression tests. Range is in world units,
 * independent of node scale; the smooth fourth-power cutoff follows the glTF guidance. */
export function distanceAttenuation(distance: number, range = 0): number {
  return (
    Math.max(1 - (range > 0 ? (distance / range) ** 4 : 0), 0) /
    Math.max(distance * distance, 0.0001)
  );
}
export function spotAttenuation(cosine: number, inner: number, outer: number): number {
  const value = Math.max(
    0,
    Math.min(1, (cosine - Math.cos(outer)) / Math.max(Math.cos(inner) - Math.cos(outer), 0.001)),
  );
  return value * value;
}
