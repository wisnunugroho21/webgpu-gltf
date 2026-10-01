import type { Pose } from '../scene/pose';

export interface AnimationState {
  readonly clips: readonly string[];
  readonly clip: number;
  readonly time: number;
  readonly playing: boolean;
  readonly duration: number;
}

/** Owns playback policy and pose evaluation, independently of WebGPU and the DOM.
 * The renderer supplies frame timestamps and uploads a pose only when update returns true. */
export class AnimationController {
  private pose?: Pose;
  private clips: string[] = [];
  private clip = -1;
  private time = 0;
  private playing = true;
  private lastTimestamp?: number;
  private dirty = false;
  private initialize = false;
  onChange?: () => void;

  get state(): AnimationState {
    return {
      clips: this.clips,
      clip: this.clip,
      time: this.time,
      playing: this.playing,
      duration: this.pose?.clips[this.clip]?.duration ?? 0,
    };
  }

  /** Attach only after a replacement scene loads successfully, so failed loads preserve
   * the current pose and playback. The first clip plays automatically when available. */
  setPose(pose: Pose): void {
    this.pose = pose;
    // A newly prepared scene still needs its first GPU deformation dispatch even if
    // the first sampled values equal the authored pose.
    this.initialize = true;
    this.clips = pose.clips.map((clip) => clip.name);
    this.playing = true;
    this.select(pose.clips.length ? 0 : -1);
  }

  select(index: number): void {
    if (index !== -1 && (!Number.isInteger(index) || !this.pose?.clips[index]))
      throw new Error('Unknown animation clip.');
    this.clip = index;
    this.time = 0;
    this.invalidate();
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    // The first frame after pause/resume establishes a fresh time origin. Paused wall
    // time must never advance the clip, even if no frames were submitted during the pause.
    this.lastTimestamp = undefined;
    this.onChange?.();
  }

  seek(seconds: number): void {
    if (!Number.isFinite(seconds)) throw new Error('Animation time must be finite.');
    this.time = Math.max(0, Math.min(this.state.duration, seconds));
    this.invalidate();
  }

  private invalidate(): void {
    this.dirty = true;
    this.lastTimestamp = undefined;
    this.onChange?.();
  }

  /** Milliseconds from requestAnimationFrame become seconds for glTF tracks. Time and UI
   * notifications continue through held poses, but returning false skips GPU pose work.
   * First attachment returns true once to initialize deformation outputs. */
  update(timestamp: number): boolean {
    if (!this.pose) return false;
    const delta =
      this.lastTimestamp === undefined ? 0 : Math.max(0, (timestamp - this.lastTimestamp) / 1000);
    this.lastTimestamp = timestamp;
    const duration = this.state.duration;
    if (this.playing && this.clip >= 0 && duration > 0) {
      this.time = (this.time + delta) % duration;
      this.dirty = true;
    }
    if (!this.dirty) return false;
    const changed = this.pose.evaluate(this.clip, this.time) || this.initialize;
    this.initialize = false;
    this.dirty = false;
    this.onChange?.();
    return changed;
  }
}
