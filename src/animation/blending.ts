import { quat } from 'gl-matrix';
import { sampleTrack, type Clip } from './tracks';

export interface AnimationLayer {
  readonly clip: number;
  readonly time: number;
  readonly weight: number;
  /** Explicit node indices; absent includes every node. Children are not implicit. */
  readonly mask?: readonly number[];
  readonly additive?: boolean;
  /** Additive reference pose is sampled from this same clip (default: time zero). */
  readonly referenceTime?: number;
  readonly speed?: number;
}

export interface LocalPose {
  translation: number[];
  rotation: number[];
  scale: number[];
  weights: number[];
}
export type BlendSample =
  AnimationLayer | { readonly pose: readonly LocalPose[]; readonly weight: number };
const paths = ['translation', 'rotation', 'scale', 'weights'] as const;

export function copyPose(source: readonly LocalPose[], target: LocalPose[]): void {
  source.forEach((node, i) => {
    for (const path of paths)
      for (let c = 0; c < node[path].length; c++) target[i][path][c] = node[path][c];
  });
}

export function clonePose(source: readonly LocalPose[]): LocalPose[] {
  return source.map((node) => ({
    translation: [...node.translation],
    rotation: [...node.rotation],
    scale: [...node.scale],
    weights: [...node.weights],
  }));
}

/** CPU local-pose mixing; no GPU resources or per-frame pose-array allocation.
 * Each clip starts from authored defaults, so missing channels cannot leak from
 * another clip. Weights below one leave room for defaults; larger totals normalize. */
export class PoseMixer {
  private scratch: LocalPose[];
  private reference: LocalPose[];
  private accumulated: Float64Array;
  private delta = quat.create();
  private rotation = quat.create();
  constructor(
    private defaults: readonly LocalPose[],
    private clips: readonly Clip[],
  ) {
    this.scratch = clonePose(defaults);
    this.reference = clonePose(defaults);
    this.accumulated = new Float64Array(defaults.length);
  }

  /** Validate before Pose changes its sparse target history. Failed requests must
   * leave previously animated properties available for default restoration. */
  validate(samples: readonly BlendSample[]): number {
    let total = 0;
    for (const sample of samples) {
      if (!Number.isFinite(sample.weight) || sample.weight < 0)
        throw new Error('Animation weight must be finite and nonnegative.');
      if (
        'clip' in sample &&
        (!Number.isFinite(sample.time) ||
          (sample.clip !== -1 && (!Number.isInteger(sample.clip) || !this.clips[sample.clip])))
      )
        throw new Error('Invalid animation clip or time.');
      if ('clip' in sample) {
        if (sample.mask?.some((node) => !Number.isInteger(node) || !this.defaults[node]))
          throw new Error('Invalid animation node mask.');
        if (
          sample.referenceTime !== undefined &&
          (!Number.isFinite(sample.referenceTime) || sample.referenceTime < 0)
        )
          throw new Error('Invalid additive reference time.');
        if (sample.additive && sample.weight > 1)
          throw new Error('Additive weight must be at most one.');
        if (sample.additive) {
          for (const track of this.clips[sample.clip]?.tracks ?? []) {
            if (track.path !== 'scale' || (sample.mask && !sample.mask.includes(track.node)))
              continue;
            const reference = [1, 1, 1],
              value = [1, 1, 1];
            sampleTrack(track, sample.referenceTime ?? 0, reference);
            sampleTrack(track, sample.time, value);
            if (reference.some((v, c) => v === 0 && value[c] !== 0))
              throw new Error('Additive reference scale must be nonzero.');
          }
        }
        if (
          sample.speed !== undefined &&
          (!Number.isFinite(sample.speed) || sample.speed < 0 || sample.speed > 8)
        )
          throw new Error('Animation speed must be between zero and eight.');
      }
      total += sample.weight;
    }
    if (!Number.isFinite(total)) throw new Error('Animation weight total must be finite.');
    return total;
  }

  evaluate(
    samples: readonly BlendSample[],
    output: LocalPose[],
    indices?: readonly number[],
  ): void {
    this.validate(samples);
    // Pose supplies active and formerly active targets. Other local values already
    // equal defaults, so neither reset nor blending needs to scan the entire scene.
    const selected = indices ?? output.map((_, i) => i);
    const copy = (source: readonly LocalPose[], target: LocalPose[]) => {
      for (const i of selected)
        for (const path of paths)
          for (let c = 0; c < source[i][path].length; c++) target[i][path][c] = source[i][path][c];
    };
    copy(this.defaults, output);
    for (const i of selected) {
      const total = samples.reduce(
        (total, sample) =>
          total +
          ('pose' in sample || (!sample.additive && (!sample.mask || sample.mask.includes(i)))
            ? sample.weight
            : 0),
        0,
      );
      this.accumulated[i] = Math.max(0, 1 - total);
    }
    for (const sample of samples) {
      if (!sample.weight) continue;
      if ('clip' in sample && sample.additive) continue;
      if ('pose' in sample) copy(sample.pose, this.scratch);
      else {
        copy(this.defaults, this.scratch);
        for (const track of this.clips[sample.clip]?.tracks ?? [])
          sampleTrack(track, sample.time, this.scratch[track.node][track.path]);
      }
      for (const i of selected) {
        if ('clip' in sample && sample.mask && !sample.mask.includes(i)) continue;
        const fraction = sample.weight / (this.accumulated[i] + sample.weight);
        const node = output[i];
        const incoming = this.scratch[i];
        for (const path of ['translation', 'scale', 'weights'] as const)
          for (let c = 0; c < node[path].length; c++)
            node[path][c] =
              fraction === 1
                ? incoming[path][c]
                : node[path][c] + (incoming[path][c] - node[path][c]) * fraction;
        // Keep identical orientations exact (including q/-q). Stable interpolation
        // avoids dirtying unaffected nodes when only blend weights change.
        if (fraction === 1) {
          for (let c = 0; c < 4; c++) node.rotation[c] = incoming.rotation[c];
        } else if (
          !node.rotation.every((v, c) => v === incoming.rotation[c]) &&
          !node.rotation.every((v, c) => v === -incoming.rotation[c])
        ) {
          quat.slerp(
            node.rotation as quat,
            node.rotation as quat,
            incoming.rotation as quat,
            fraction,
          );
          quat.normalize(node.rotation as quat, node.rotation as quat);
        }
        this.accumulated[i] += sample.weight;
      }
    }
    // Additive samples are applied after all absolute layers, relative to their
    // reference keys. Never mutate shared defaults, tracks or captured snapshots.
    const delta = this.delta,
      rotation = this.rotation;
    for (const sample of samples) {
      if (!('clip' in sample) || !sample.additive || !sample.weight) continue;
      copy(this.defaults, this.scratch);
      copy(this.defaults, this.reference);
      for (const track of this.clips[sample.clip]?.tracks ?? []) {
        sampleTrack(track, sample.time, this.scratch[track.node][track.path]);
        sampleTrack(track, sample.referenceTime ?? 0, this.reference[track.node][track.path]);
      }
      for (const i of selected) {
        if (sample.mask && !sample.mask.includes(i)) continue;
        const out = output[i],
          value = this.scratch[i],
          ref = this.reference[i];
        for (const path of ['translation', 'weights'] as const)
          for (let c = 0; c < out[path].length; c++)
            out[path][c] += (value[path][c] - ref[path][c]) * sample.weight;
        // Scale deltas are multiplicative; zero reference scales cannot define a ratio.
        for (let c = 0; c < 3; c++) {
          if (ref.scale[c] === 0) {
            if (value.scale[c] !== 0) throw new Error('Additive reference scale must be nonzero.');
          } else out.scale[c] *= 1 + (value.scale[c] / ref.scale[c] - 1) * sample.weight;
        }
        if (
          value.rotation.every((v, c) => v === ref.rotation[c]) ||
          value.rotation.every((v, c) => v === -ref.rotation[c])
        )
          continue;
        quat.conjugate(delta, ref.rotation as quat);
        quat.multiply(delta, delta, value.rotation as quat);
        quat.slerp(rotation, [0, 0, 0, 1], delta, sample.weight);
        quat.multiply(out.rotation as quat, out.rotation as quat, rotation);
        quat.normalize(out.rotation as quat, out.rotation as quat);
      }
    }
  }
}
