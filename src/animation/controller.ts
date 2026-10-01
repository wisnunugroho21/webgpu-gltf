import type { Pose } from '../scene/pose';
import type { AnimationLayer, BlendSample, LocalPose } from './blending';
export type { AnimationLayer } from './blending';

type Layer = { clip: number; time: number; weight: number };
export interface AnimationTransition {
  readonly duration: number;
  readonly elapsed: number;
  readonly progress: number;
}
export interface AnimationState {
  readonly clips: readonly string[];
  readonly clip: number;
  readonly time: number;
  readonly playing: boolean;
  readonly duration: number;
  readonly layers: readonly AnimationLayer[];
  readonly transition?: AnimationTransition;
}

/** CPU playback policy. The renderer retains separate pose-upload, compute and render
 * phases and uploads only when the final mixed pose actually changes. */
export class AnimationController {
  private pose?: Pose;
  private clips: string[] = [];
  private layers: Layer[] = [{ clip: -1, time: 0, weight: 1 }];
  private fade?: {
    duration: number;
    elapsed: number;
    source: Layer[];
    snapshot?: LocalPose[];
    samples: BlendSample[];
  };
  private playing = true;
  private lastTimestamp?: number;
  private dirty = false;
  private initialize = false;
  onChange?: () => void;

  get state(): AnimationState {
    const primary = this.layers[0];
    return {
      clips: [...this.clips],
      clip: primary?.clip ?? -1,
      time: primary?.time ?? 0,
      playing: this.playing,
      duration: this.pose?.clips[primary?.clip ?? -1]?.duration ?? 0,
      layers: this.layers.map((layer) => ({ ...layer })),
      transition: this.fade
        ? {
            duration: this.fade.duration,
            elapsed: this.fade.elapsed,
            progress: this.fade.elapsed / this.fade.duration,
          }
        : undefined,
    };
  }

  /** Attach after successful scene preparation; replacement clears every blend. */
  setPose(pose: Pose): void {
    this.pose = pose;
    this.initialize = true;
    this.clips = pose.clips.map((clip) => clip.name);
    this.playing = true;
    this.select(pose.clips.length ? 0 : -1);
  }

  private validateClip(index: number): void {
    if (index !== -1 && (!Number.isInteger(index) || !this.pose?.clips[index]))
      throw new Error('Unknown animation clip.');
  }

  /** Immediate switch, preserving the original API. -1 selects authored defaults. */
  select(index: number): void {
    this.validateClip(index);
    this.layers = [{ clip: index, time: 0, weight: 1 }];
    this.fade = undefined;
    this.invalidate();
  }

  /** Independent looping clocks; totals below one include authored defaults, while
   * totals above one normalize. Copy inputs so callers cannot mutate playback state. */
  setLayers(layers: readonly AnimationLayer[]): void {
    let total = 0;
    const next = layers.map((layer) => {
      this.validateClip(layer.clip);
      if (!Number.isFinite(layer.time)) throw new Error('Animation time must be finite.');
      if (!Number.isFinite(layer.weight) || layer.weight < 0)
        throw new Error('Animation weight must be finite and nonnegative.');
      total += layer.weight;
      return {
        ...layer,
        time: Math.max(0, Math.min(this.pose?.clips[layer.clip]?.duration ?? 0, layer.time)),
      };
    });
    if (!Number.isFinite(total)) throw new Error('Animation weight total must be finite.');
    this.layers = next;
    this.fade = undefined;
    this.invalidate();
  }

  /** Fade to a new clip starting at zero. Ordinary outgoing clips keep advancing.
   * Interruptions freeze the currently displayed mixed pose to prevent a visual jump. */
  crossFadeTo(index: number, seconds = 0.3): void {
    this.validateClip(index);
    if (!Number.isFinite(seconds) || seconds < 0)
      throw new Error('Crossfade duration must be finite and nonnegative.');
    if (!seconds) {
      this.select(index);
      return;
    }
    const snapshot = this.fade ? this.pose?.capture() : undefined;
    const total = this.layers.reduce((sum, layer) => sum + layer.weight, 0);
    const source = this.layers.map((layer) => ({
      ...layer,
      weight: layer.weight / Math.max(1, total),
    }));
    this.layers = [{ clip: index, time: 0, weight: 1 }];
    this.fade = {
      duration: seconds,
      elapsed: 0,
      source,
      snapshot,
      samples: snapshot
        ? [
            { pose: snapshot, weight: 1 },
            { clip: index, time: 0, weight: 0 },
          ]
        : [...source.map((layer) => ({ ...layer })), { clip: index, time: 0, weight: 0 }],
    };
    this.invalidate();
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.lastTimestamp = undefined; // Exclude paused wall time on resume.
    this.onChange?.();
  }

  /** Scrubbing ends a transition at its destination; manual layers seek only their
   * primary clock and retain the others. Restart follows the same policy. */
  seek(seconds: number): void {
    if (!Number.isFinite(seconds)) throw new Error('Animation time must be finite.');
    if (this.layers[0]) this.layers[0].time = Math.max(0, Math.min(this.state.duration, seconds));
    this.fade = undefined;
    this.invalidate();
  }

  private invalidate(): void {
    this.dirty = true;
    this.lastTimestamp = undefined;
    this.onChange?.();
  }

  private samples(): readonly BlendSample[] {
    const fade = this.fade;
    if (!fade) return this.layers;
    const progress = fade.elapsed / fade.duration;
    if (fade.snapshot) (fade.samples[0] as { weight: number }).weight = 1 - progress;
    else
      fade.source.forEach((layer, i) => {
        Object.assign(fade.samples[i], layer, { weight: layer.weight * (1 - progress) });
      });
    Object.assign(fade.samples[fade.samples.length - 1], this.layers[0], { weight: progress });
    return fade.samples;
  }

  update(timestamp: number): boolean {
    if (!this.pose) return false;
    const delta =
      this.lastTimestamp === undefined ? 0 : Math.max(0, (timestamp - this.lastTimestamp) / 1000);
    this.lastTimestamp = timestamp;
    if (this.playing) {
      const advance = (layers: Layer[]) =>
        layers.forEach((layer) => {
          const duration = this.pose!.clips[layer.clip]?.duration ?? 0;
          if (duration > 0) {
            layer.time = (layer.time + delta) % duration;
            this.dirty = true;
          }
        });
      advance(this.layers);
      if (this.fade) {
        advance(this.fade.source);
        this.fade.elapsed = Math.min(this.fade.duration, this.fade.elapsed + delta);
        this.dirty = true;
        if (this.fade.elapsed === this.fade.duration) this.fade = undefined;
      }
    }
    if (!this.dirty) return false;
    const changed = this.pose.evaluateBlend(this.samples()) || this.initialize;
    this.initialize = false;
    this.dirty = false;
    this.onChange?.();
    return changed;
  }
}
