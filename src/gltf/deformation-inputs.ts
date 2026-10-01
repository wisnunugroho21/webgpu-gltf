import { vec3 } from 'gl-matrix';
import { decodeAccessor } from './accessors';
import type { Asset, Primitive } from './types';

export interface DeformationStream {
  readonly semantic: 'POSITION' | 'NORMAL' | 'TANGENT';
  readonly width: number;
  readonly base: Float32Array;
  readonly targets: readonly (readonly number[] | undefined)[];
}
export interface SkinInfluences {
  readonly joints: readonly number[];
  readonly weights: readonly number[];
}
export interface DeformationInputs {
  readonly count: number;
  readonly targetCount: number;
  readonly streams: readonly DeformationStream[];
  readonly ranges: readonly { min: vec3; max: vec3 }[];
}

/** One cache per prepared scene/asset. Primitive identity, not node or skin identity,
 * determines immutable vertex data. Never mutate decoded arrays after caching them. */
export class DeformationInputCache {
  private vertices = new Map<Primitive, DeformationInputs>();
  private influences = new Map<Primitive, readonly SkinInfluences[]>();
  readonly noInfluences: readonly SkinInfluences[] = [];
  constructor(private asset: Asset) {}

  get(primitive: Primitive): DeformationInputs {
    const cached = this.vertices.get(primitive);
    if (cached) return cached;
    const asset = this.asset;
    const count = asset.gltf.accessors![primitive.attributes.POSITION].count;
    const streams: DeformationStream[] = [];
    for (const [semantic, width] of [
      ['POSITION', 3],
      ['NORMAL', 3],
      ['TANGENT', 4],
    ] as const) {
      const index = primitive.attributes[semantic];
      if (index === undefined) {
        if (primitive.targets?.some((target) => target[semantic] !== undefined))
          throw new Error(`Morph ${semantic} has no base attribute.`);
        continue;
      }
      const base = new Float32Array(decodeAccessor(asset, asset.gltf.accessors![index]));
      const targets = (primitive.targets ?? []).map((target) => {
        if (Object.keys(target).some((name) => !['POSITION', 'NORMAL', 'TANGENT'].includes(name)))
          throw new Error('Unsupported morph target attribute.');
        if (target[semantic] === undefined) return undefined;
        const accessor = asset.gltf.accessors?.[target[semantic]];
        if (
          !accessor ||
          accessor.type !== 'VEC3' ||
          accessor.componentType !== 5126 ||
          accessor.count !== count
        )
          throw new Error('Morph target must be a float VEC3 matching the base vertex count.');
        return decodeAccessor(asset, accessor);
      });
      streams.push({ semantic, width, base, targets });
    }
    // Bounds are immutable too; each node combines these intervals with its own weights.
    const ranges = [streams[0].base, ...streams[0].targets].map((values) => {
      const min = vec3.fromValues(Infinity, Infinity, Infinity);
      const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
      if (values)
        for (let i = 0; i < values.length; i++) {
          const c = i % 3;
          min[c] = Math.min(min[c], values[i]);
          max[c] = Math.max(max[c], values[i]);
        }
      else {
        vec3.zero(min);
        vec3.zero(max);
      }
      return { min, max };
    });
    const inputs = { count, targetCount: primitive.targets?.length ?? 0, streams, ranges };
    this.vertices.set(primitive, inputs);
    return inputs;
  }

  /** Decode only when a skinned node uses this primitive. Joint values index a node's
   * skin palette; palette-length validation therefore belongs to Deformation, not here. */
  getInfluences(primitive: Primitive): readonly SkinInfluences[] {
    const cached = this.influences.get(primitive);
    if (cached) return cached;
    const asset = this.asset,
      count = this.get(primitive).count;
    const sets = Object.keys(primitive.attributes)
      .filter((name) => /^JOINTS_\d+$/.test(name))
      .sort();
    if (!sets.includes('JOINTS_0'))
      throw new Error('Skinned primitive requires JOINTS_0 and WEIGHTS_0.');
    if (
      Object.keys(primitive.attributes).some(
        (name) => /^WEIGHTS_\d+$/.test(name) && !sets.includes(name.replace('WEIGHTS', 'JOINTS')),
      )
    )
      throw new Error('Weights have no matching joints.');
    const influences = sets.map((name) => {
      const joint = asset.gltf.accessors?.[primitive.attributes[name]];
      const weight =
        asset.gltf.accessors?.[primitive.attributes[name.replace('JOINTS', 'WEIGHTS')]];
      if (
        !joint ||
        !weight ||
        joint.type !== 'VEC4' ||
        weight.type !== 'VEC4' ||
        joint.count !== count ||
        weight.count !== count ||
        joint.normalized ||
        ![5121, 5123].includes(joint.componentType) ||
        !(
          weight.componentType === 5126 ||
          ([5121, 5123].includes(weight.componentType) && weight.normalized)
        )
      )
        throw new Error('Invalid skin joint/weight attributes.');
      const joints = decodeAccessor(asset, joint),
        weights = decodeAccessor(asset, weight);
      if (weights.some((w) => w < 0)) throw new Error('Skin influences are out of range.');
      return { joints, weights };
    });
    for (let v = 0; v < count; v++)
      if (
        influences.reduce(
          (sum, set) => sum + set.weights.slice(v * 4, v * 4 + 4).reduce((a, b) => a + b, 0),
          0,
        ) <= 0
      )
        throw new Error('Skin vertex has no positive joint weights.');
    this.influences.set(primitive, influences);
    return influences;
  }
}
