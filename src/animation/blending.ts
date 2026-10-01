import { quat } from 'gl-matrix';
import { sampleTrack, type Clip } from './tracks';

export interface AnimationLayer {
  readonly clip: number;
  readonly time: number;
  readonly weight: number;
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
  constructor(
    private defaults: readonly LocalPose[],
    private clips: readonly Clip[],
  ) {
    this.scratch = clonePose(defaults);
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
    const total = this.validate(samples);
    // Pose supplies active and formerly active targets. Other local values already
    // equal defaults, so neither reset nor blending needs to scan the entire scene.
    const selected = indices ?? output.map((_, i) => i);
    const copy = (source: readonly LocalPose[], target: LocalPose[]) => {
      for (const i of selected)
        for (const path of paths)
          for (let c = 0; c < source[i][path].length; c++) target[i][path][c] = source[i][path][c];
    };
    copy(this.defaults, output);
    let accumulated = Math.max(0, 1 - total);
    for (const sample of samples) {
      if (!sample.weight) continue;
      if ('pose' in sample) copy(sample.pose, this.scratch);
      else {
        copy(this.defaults, this.scratch);
        for (const track of this.clips[sample.clip]?.tracks ?? [])
          sampleTrack(track, sample.time, this.scratch[track.node][track.path]);
      }
      if (!accumulated) copy(this.scratch, output);
      else {
        const fraction = sample.weight / (accumulated + sample.weight);
        for (const i of selected) {
          const node = output[i];
          const incoming = this.scratch[i];
          for (const path of ['translation', 'scale', 'weights'] as const)
            for (let c = 0; c < node[path].length; c++)
              node[path][c] += (incoming[path][c] - node[path][c]) * fraction;
          // Keep identical orientations exact (including q/-q). Stable interpolation
          // avoids dirtying unaffected nodes when only blend weights change.
          if (
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
        }
      }
      accumulated += sample.weight;
    }
  }
}
