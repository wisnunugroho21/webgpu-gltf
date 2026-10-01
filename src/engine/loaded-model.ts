import type { Asset } from '../gltf/types';
import { prepareClips, type Clip } from '../animation/tracks';

/** CPU resource identity, with no playback clock, pose or GPU output. GPU resources
 * are prepared separately for this asset on each renderer/device. */
export class LoadedModel {
  private prepared?: readonly Clip[];
  constructor(readonly asset: Asset) {}

  /** Decode/validate once, lazily on first use. Freeze shared keys so one instance
   * cannot accidentally change the animation seen by every other instance. */
  get clips(): readonly Clip[] {
    if (!this.prepared) {
      const clips = prepareClips(this.asset);
      for (const clip of clips) {
        for (const track of clip.tracks) {
          Object.freeze(track.times);
          Object.freeze(track.values);
          Object.freeze(track);
        }
        Object.freeze(clip.tracks);
        Object.freeze(clip);
      }
      this.prepared = Object.freeze(clips);
    }
    return this.prepared;
  }
}
