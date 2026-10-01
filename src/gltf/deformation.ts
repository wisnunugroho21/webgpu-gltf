import { mat4 } from 'gl-matrix';
import { decodeAccessor } from './accessors';
import type { Asset, Primitive } from './types';
import type { Geometry, VertexBinding } from './geometry';
import type { Pose } from './animation';

interface Stream {
  semantic: string;
  width: number;
  base: Float32Array;
  values: Float32Array;
  targets: (number[] | undefined)[];
}

/** Node-specific CPU deformation intentionally lives outside draw submission. Source arrays
 * are immutable; reusable destination streams are uploaded only when a pose changes.
 * Morphing precedes linear blend skinning, as required by glTF. */
export class Deformation {
  readonly streams: Stream[] = [];
  private joints: number[] = [];
  private inverseBind: mat4[] = [];
  private palette: mat4[] = [];
  private influences: { joints: number[]; weights: number[] }[] = [];
  private blend = mat4.create();
  private normal = mat4.create();
  readonly skinned: boolean;
  constructor(
    asset: Asset,
    readonly primitive: Primitive,
    readonly node: number,
    private pose: Pose,
  ) {
    const definition = asset.gltf.nodes![node];
    this.skinned = definition.skin !== undefined;
    const count = asset.gltf.accessors![primitive.attributes.POSITION].count;
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
      const accessor = asset.gltf.accessors![index];
      const base = new Float32Array(decodeAccessor(asset, accessor));
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
      this.streams.push({ semantic, width, base, values: new Float32Array(base.length), targets });
    }
    if (this.skinned) {
      const skin = asset.gltf.skins?.[definition.skin!];
      if (
        !skin?.joints.length ||
        new Set(skin.joints).size !== skin.joints.length ||
        skin.joints.some((j) => !pose.nodes[j])
      )
        throw new Error('Invalid skin joint list.');
      this.joints = skin.joints;
      const accessor = asset.gltf.accessors?.[skin.inverseBindMatrices!];
      if (
        skin.inverseBindMatrices !== undefined &&
        (!accessor ||
          accessor.type !== 'MAT4' ||
          accessor.componentType !== 5126 ||
          accessor.count < skin.joints.length)
      )
        throw new Error('Invalid inverse-bind matrix accessor.');
      const matrices = accessor ? decodeAccessor(asset, accessor) : undefined;
      this.inverseBind = skin.joints.map((_, i) =>
        matrices ? mat4.clone(matrices.slice(i * 16, i * 16 + 16) as mat4) : mat4.create(),
      );
      this.palette = skin.joints.map(() => mat4.create());
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
      for (const name of sets) {
        const joint = asset.gltf.accessors?.[primitive.attributes[name]],
          weight = asset.gltf.accessors?.[primitive.attributes[name.replace('JOINTS', 'WEIGHTS')]];
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
        if (joints.some((j) => j >= skin.joints.length) || weights.some((w) => w < 0))
          throw new Error('Skin influences are out of range.');
        this.influences.push({ joints, weights });
      }
      for (let v = 0; v < count; v++)
        if (
          this.influences.reduce(
            (sum, set) => sum + set.weights.slice(v * 4, v * 4 + 4).reduce((a, b) => a + b, 0),
            0,
          ) <= 0
        )
          throw new Error('Skin vertex has no positive joint weights.');
    }
    this.update();
  }

  /** Replace only deformable attributes. UV/color streams retain their original layout. */
  geometry(base: Geometry): Geometry {
    const moving = new Set(
      this.streams.map(
        (stream) =>
          ({ POSITION: 0, NORMAL: 1, TANGENT: 4 })[
            stream.semantic as 'POSITION' | 'NORMAL' | 'TANGENT'
          ],
      ),
    );
    const bindings: VertexBinding[] = base.bindings.flatMap((binding) => {
      const attributes = [...binding.layout.attributes].filter(
        (attribute) => !moving.has(attribute.shaderLocation),
      );
      return attributes.length ? [{ ...binding, layout: { ...binding.layout, attributes } }] : [];
    });
    for (const stream of this.streams)
      bindings.push({
        source: stream.values,
        offset: 0,
        layout: {
          arrayStride: stream.width * 4,
          stepMode: 'vertex',
          attributes: [
            {
              shaderLocation: { POSITION: 0, NORMAL: 1, TANGENT: 4 }[
                stream.semantic as 'POSITION' | 'NORMAL' | 'TANGENT'
              ],
              offset: 0,
              format: `float32x${stream.width}` as GPUVertexFormat,
            },
          ],
        },
      });
    bindings.sort(
      (a, b) =>
        [...a.layout.attributes][0].shaderLocation - [...b.layout.attributes][0].shaderLocation,
    );
    return { ...base, bindings, positions: Array.from(this.streams[0].values) };
  }

  update(): void {
    const weights = this.pose.nodes[this.node].weights;
    for (const stream of this.streams) {
      stream.values.set(stream.base);
      stream.targets.forEach((target, index) => {
        const weight = weights[index];
        if (!target || !weight) return;
        for (let v = 0; v < stream.base.length / stream.width; v++)
          for (let c = 0; c < 3; c++)
            stream.values[v * stream.width + c] += weight * target[v * 3 + c];
      });
    }
    if (!this.skinned) return;
    this.joints.forEach((joint, i) =>
      mat4.multiply(this.palette[i], this.pose.nodes[joint].world, this.inverseBind[i]),
    );
    const count = this.streams[0].values.length / 3;
    for (let v = 0; v < count; v++) {
      for (let m = 0; m < 16; m++) this.blend[m] = 0;
      let total = 0;
      for (const set of this.influences)
        for (let c = 0; c < 4; c++) {
          const weight = set.weights[v * 4 + c],
            matrix = this.palette[set.joints[v * 4 + c]];
          total += weight;
          for (let m = 0; m < 16; m++) this.blend[m] += weight * matrix[m];
        }
      for (let m = 0; m < 16; m++) this.blend[m] /= total;
      if (!mat4.invert(this.normal, this.blend)) mat4.identity(this.normal);
      mat4.transpose(this.normal, this.normal);
      for (const stream of this.streams) {
        const offset = v * stream.width,
          x = stream.values[offset],
          y = stream.values[offset + 1],
          z = stream.values[offset + 2];
        const matrix = stream.semantic === 'NORMAL' ? this.normal : this.blend;
        const w = stream.semantic === 'POSITION' ? 1 : 0;
        for (let c = 0; c < 3; c++)
          stream.values[offset + c] =
            matrix[c] * x + matrix[4 + c] * y + matrix[8 + c] * z + matrix[12 + c] * w;
        if (stream.semantic === 'TANGENT' && mat4.determinant(this.blend) < 0)
          stream.values[offset + 3] *= -1;
      }
    }
  }
}
