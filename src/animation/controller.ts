import type { Pose } from '../scene/pose';
import type { AnimationLayer, BlendSample, LocalPose } from './blending';
import { crossedEvents, translationDelta, type AnimationEvent } from './motion';
export type { AnimationEvent } from './motion';
export type { AnimationLayer } from './blending';

type Layer = Omit<AnimationLayer, 'time'> & { time: number };
export interface AnimationTransition {
  readonly duration: number;
  readonly elapsed: number;
  readonly progress: number;
}
export interface RootMotionSettings {
  readonly node: number;
  readonly mode: 'in-place' | 'extract';
}
export interface AnimationState {
  readonly clips: readonly string[];
  readonly clip: number;
  readonly time: number;
  readonly playing: boolean;
  readonly duration: number;
  readonly layers: readonly AnimationLayer[];
  readonly overlays: readonly AnimationLayer[];
  readonly clock: 'presentation' | 'external';
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
  private overlays: Layer[] = [];
  private clock: 'presentation' | 'external' = 'presentation';
  private events: AnimationEvent[] = [];
  private rootMotion?: RootMotionSettings;
  private displacement = [0, 0, 0];
  private elapsed = 0;
  onChange?: () => void;

  get state(): AnimationState {
    const primary = this.layers[0];
    return {
      clips: [...this.clips],
      clip: primary?.clip ?? -1,
      time: primary?.time ?? 0,
      playing: this.playing,
      duration: this.pose?.clips[primary?.clip ?? -1]?.duration ?? 0,
      layers: this.layers.map((layer) => ({
        ...layer,
        mask: layer.mask ? [...layer.mask] : undefined,
      })),
      overlays: this.overlays.map((layer) => ({
        ...layer,
        mask: layer.mask ? [...layer.mask] : undefined,
      })),
      clock: this.clock,
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
    this.elapsed = 0;
    this.overlays = [];
    this.events = [];
    this.rootMotion = undefined;
    this.displacement.fill(0);
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
    this.events = [];
    this.displacement.fill(0);
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
        mask: layer.mask ? [...layer.mask] : undefined,
        time: Math.max(0, Math.min(this.pose?.clips[layer.clip]?.duration ?? 0, layer.time)),
      };
    });
    if (!Number.isFinite(total)) throw new Error('Animation weight total must be finite.');
    this.pose?.validateBlend(next);
    this.layers = next;
    this.fade = undefined;
    this.events = [];
    this.displacement.fill(0);
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
    // A masked base can have different normalization totals at each node. Capture
    // that base when transitioning rather than globally rescaling its weights.
    const snapshot =
      this.fade || this.layers.some((layer) => layer.mask || layer.additive)
        ? this.pose?.captureBlend(this.samples())
        : undefined;
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

  /** Gameplay advances this clock at fixed steps; presentation only evaluates
   * pending policy changes. This avoids event/root-motion delivery at render rate. */
  setClock(clock: 'presentation' | 'external'): void {
    if (!['presentation', 'external'].includes(clock)) throw new Error('Unknown animation clock.');
    this.clock = clock;
    this.lastTimestamp = undefined;
  }
  setOverlays(layers: readonly AnimationLayer[]): void {
    const next = layers.map((layer) => ({
      ...layer,
      mask: layer.mask ? [...layer.mask] : undefined,
      time: Math.max(0, Math.min(this.pose?.clips[layer.clip]?.duration ?? 0, layer.time)),
    }));
    for (const layer of next) this.validateClip(layer.clip);
    this.pose?.validateBlend(next);
    this.overlays = next;
    this.dirty = true;
  }
  setRootMotion(settings?: RootMotionSettings): void {
    if (settings && !['in-place', 'extract'].includes(settings.mode))
      throw new Error('Unknown root-motion mode.');
    this.pose?.setInPlaceRoot(settings?.node);
    this.rootMotion = settings ? { ...settings } : undefined;
    this.displacement.fill(0);
    this.dirty = true;
  }
  consumeRootMotion(): readonly number[] {
    const result = [...this.displacement];
    this.displacement.fill(0);
    return result;
  }
  drainEvents(): readonly AnimationEvent[] {
    const result = this.events.sort(
      (a, b) => a.elapsedSeconds - b.elapsedSeconds || a.clip - b.clip,
    );
    this.events = [];
    return result;
  }
  advance(deltaSeconds: number): boolean {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0)
      throw new Error('Animation delta must be finite and nonnegative.');
    return this.tick(deltaSeconds);
  }

  /** Scrubbing ends a transition at its destination; manual layers seek only their
   * primary clock and retain the others. Restart follows the same policy. */
  seek(seconds: number): void {
    if (!Number.isFinite(seconds)) throw new Error('Animation time must be finite.');
    if (this.layers[0]) this.layers[0].time = Math.max(0, Math.min(this.state.duration, seconds));
    this.fade = undefined;
    this.events = [];
    this.displacement.fill(0);
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
    if (!Number.isFinite(timestamp)) throw new Error('Animation timestamp must be finite.');
    if (!this.pose) return false;
    const delta =
      this.lastTimestamp === undefined ? 0 : Math.max(0, (timestamp - this.lastTimestamp) / 1000);
    this.lastTimestamp = timestamp;
    return this.tick(this.clock === 'external' ? 0 : delta);
  }
  private tick(delta: number): boolean {
    if (!this.pose) return false;
    if (this.playing) {
      const fade = this.fade;
      const progress = fade ? fade.elapsed / fade.duration : 1;
      const fadeDelta = fade ? Math.min(delta, fade.duration - fade.elapsed) : 0;
      const mean = fade ? (progress + (fade.elapsed + fadeDelta) / fade.duration) / 2 : 1;
      const destinationWeight =
        delta > 0 ? (mean * fadeDelta + delta - fadeDelta) / delta : progress;
      const advance = (
        layers: Layer[],
        seconds: number,
        factor = 1,
        eventFactor: (offset: number) => number = () => factor,
      ) =>
        layers.forEach((layer) => {
          const duration = this.pose!.clips[layer.clip]?.duration ?? 0;
          if (duration > 0) {
            const speed = layer.speed ?? 1;
            const travel = seconds * speed;
            const clip = this.pose!.clips[layer.clip];
            if (layer.weight > 0)
              this.events.push(
                ...crossedEvents(
                  clip,
                  layer.clip,
                  layer.time,
                  travel,
                  (offset) => layer.weight * eventFactor(offset / speed),
                ).map((event) => ({
                  ...event,
                  elapsedSeconds: this.elapsed + event.elapsedSeconds / speed,
                })),
              );
            if (
              this.rootMotion?.mode === 'extract' &&
              !layer.additive &&
              (!layer.mask || layer.mask.includes(this.rootMotion.node))
            ) {
              const value = translationDelta(clip, this.rootMotion.node, layer.time, travel);
              const total = Math.max(
                1,
                layers.reduce(
                  (sum, sample) =>
                    sum +
                    (sample.additive ||
                    (sample.mask && !sample.mask.includes(this.rootMotion!.node))
                      ? 0
                      : sample.weight),
                  0,
                ),
              );
              value.forEach(
                (v, c) => (this.displacement[c] += ((v * layer.weight) / total) * factor),
              );
            }
            layer.time = (layer.time + travel) % duration;
            this.dirty ||= travel > 0;
          }
        });
      advance(
        this.layers,
        delta,
        destinationWeight,
        fade ? (offset) => Math.min(1, (fade.elapsed + offset) / fade.duration) : () => 1,
      );
      advance(this.overlays, delta);
      if (this.fade) {
        if (!this.fade.snapshot)
          advance(this.fade.source, fadeDelta, 1 - mean, (offset) =>
            Math.max(0, 1 - (fade!.elapsed + offset) / fade!.duration),
          );
        this.fade.elapsed = Math.min(this.fade.duration, this.fade.elapsed + delta);
        this.dirty ||= delta > 0;
        if (this.fade.elapsed === this.fade.duration) this.fade = undefined;
      }
      this.elapsed += delta;
    }
    if (!this.dirty) return false;
    const changed =
      this.pose.evaluateBlend([...this.samples(), ...this.overlays]) || this.initialize;
    this.initialize = false;
    this.dirty = false;
    this.onChange?.();
    return changed;
  }
}
