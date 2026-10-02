import { sampleTrack, type Clip } from './tracks';

export interface AnimationEvent {
  readonly clip: number;
  readonly name: string;
  readonly time: number;
  readonly weight: number;
  readonly elapsedSeconds: number;
}
/** Half-open (start,end] intervals prevent duplicate delivery. Time-zero events
 * fire at loop boundaries, not attach/seek. Arbitrary catch-up can cross many loops. */
export function crossedEvents(
  clip: Clip,
  index: number,
  start: number,
  delta: number,
  weight: number | ((offset: number) => number),
): AnimationEvent[] {
  if (!(clip.duration > 0) || !(delta > 0)) return [];
  if (typeof weight === 'number' && !(weight > 0)) return [];
  const tolerance =
    Number.EPSILON * Math.max(clip.duration, Math.abs(start), Math.abs(start + delta)) * 8;
  const crossings = (clip.events ?? []).reduce(
    (total, event) =>
      total +
      Math.max(
        0,
        Math.floor((start + delta - event.time) / clip.duration) -
          Math.floor((start - event.time) / clip.duration),
      ),
    0,
  );
  if (!Number.isSafeInteger(crossings) || crossings > 4096)
    throw new Error('Animation event interval exceeds 4096 crossings; advance smaller steps.');
  const events: (AnimationEvent & { at: number })[] = [];
  for (const event of clip.events ?? []) {
    let cycle = Math.floor((start - event.time) / clip.duration) + 1;
    for (
      let at = event.time + cycle * clip.duration;
      at <= start + delta + tolerance;
      at = event.time + ++cycle * clip.duration
    )
      if (at > start + tolerance) {
        const w = typeof weight === 'number' ? weight : weight(at - start);
        if (w > 0)
          events.push({ clip: index, ...event, weight: w, elapsedSeconds: at - start, at });
      }
  }
  return events.sort((a, b) => a.at - b.at).map(({ at: _at, ...event }) => event);
}

/** Translation only, in model-local coordinates. End-start cycle displacement
 * preserves travel across wrap; additive/masked-out roots do not move an entity. */
export function translationDelta(clip: Clip, node: number, start: number, delta: number): number[] {
  const track = clip.tracks.find((track) => track.node === node && track.path === 'translation');
  if (!track || !clip.duration || !delta) return [0, 0, 0];
  const from = [0, 0, 0],
    to = [0, 0, 0],
    first = [0, 0, 0],
    last = [0, 0, 0];
  sampleTrack(track, start % clip.duration, from);
  sampleTrack(track, (start + delta) % clip.duration, to);
  sampleTrack(track, 0, first);
  sampleTrack(track, clip.duration, last);
  const loops = Math.floor((start + delta) / clip.duration) - Math.floor(start / clip.duration);
  return to.map((value, c) => value - from[c] + loops * (last[c] - first[c]));
}
