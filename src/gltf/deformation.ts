import { mat4, vec3 } from 'gl-matrix';
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

/** Decode and validate immutable deformation inputs once. The CPU evaluator is a reference
 * for tests and exact initial framing only; playback uses the compute shader. */
export class Deformation {
  readonly streams: Stream[] = [];
  private joints: number[] = [];
  private inverseBind: mat4[] = [];
  readonly palette: mat4[] = [];
  readonly influences: { joints: number[]; weights: number[] }[] = [];
  private blend = mat4.create();
  private normal = mat4.create();
  readonly skinned: boolean;
  private ranges: { min: vec3; max: vec3 }[] = [];
  private boundMin = vec3.create();
  private boundMax = vec3.create();
  private corner = vec3.create();
  private unionMin = vec3.create();
  private unionMax = vec3.create();
  get weights(): number[] {
    return this.pose.nodes[this.node].weights;
  }
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
    const position = this.streams[0];
    // Separate delta intervals let positive and negative morph weights expand a conservative
    // envelope without walking vertices or reading GPU results during playback.
    for (const values of [position.base, ...position.targets]) {
      const min = vec3.fromValues(Infinity, Infinity, Infinity);
      const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
      if (values) {
        for (let i = 0; i < values.length; i++) {
          const c = i % 3;
          min[c] = Math.min(min[c], values[i]);
          max[c] = Math.max(max[c], values[i]);
        }
      } else {
        vec3.zero(min);
        vec3.zero(max);
      }
      this.ranges.push({ min, max });
    }
    this.update();
  }

  updatePalette(): void {
    this.joints.forEach((joint, i) =>
      mat4.multiply(this.palette[i], this.pose.nodes[joint].world, this.inverseBind[i]),
    );
  }

  /** A union of joint-transformed envelopes contains every normalized, nonnegative blend.
   * This trades exact transparent centers for no per-frame vertex work or GPU readback. */
  center(out: vec3): void {
    vec3.copy(this.boundMin, this.ranges[0].min);
    vec3.copy(this.boundMax, this.ranges[0].max);
    this.weights.forEach((weight, i) => {
      const range = this.ranges[i + 1];
      for (let c = 0; c < 3; c++) {
        this.boundMin[c] += weight * (weight < 0 ? range.max[c] : range.min[c]);
        this.boundMax[c] += weight * (weight < 0 ? range.min[c] : range.max[c]);
      }
    });
    if (!this.skinned) {
      vec3.scale(out, vec3.add(out, this.boundMin, this.boundMax), 0.5);
      return;
    }
    const min = this.unionMin,
      max = this.unionMax;
    vec3.set(min, Infinity, Infinity, Infinity);
    vec3.set(max, -Infinity, -Infinity, -Infinity);
    for (const matrix of this.palette)
      for (let i = 0; i < 8; i++) {
        for (let c = 0; c < 3; c++)
          this.corner[c] = i & (1 << c) ? this.boundMax[c] : this.boundMin[c];
        vec3.transformMat4(this.corner, this.corner, matrix);
        for (let c = 0; c < 3; c++) {
          min[c] = Math.min(min[c], this.corner[c]);
          max[c] = Math.max(max[c], this.corner[c]);
        }
      }
    for (let c = 0; c < 3; c++) out[c] = (min[c] + max[c]) * 0.5;
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

  /** CPU oracle used once for exact initial bounds, and by numeric GPU regression tests.
   * Never call this during playback: GpuDeformation.update uploads pose inputs instead. */
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
    this.updatePalette();
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
