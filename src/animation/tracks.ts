import { decodeAccessor } from '../gltf/accessors';
import type { Asset, Animation } from '../gltf/types';

export interface Track {
  node: number;
  path: Animation['channels'][number]['target']['path'];
  times: number[];
  values: number[];
  width: number;
  interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}
export interface Clip {
  name: string;
  duration: number;
  tracks: Track[];
  events?: readonly { readonly time: number; readonly name: string }[];
}

/** Sample into a caller-owned array. Key ranges clamp, LINEAR rotations use shortest-path
 * quaternion slerp, and cubic tangents are scaled by the interval's duration (seconds). */
export function sampleTrack(track: Track, time: number, out: number[]): void {
  const { times, values, width, interpolation } = track;
  let low = 0,
    high = times.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (times[middle] <= time) low = middle;
    else high = middle - 1;
  }
  const a = low,
    b = Math.min(a + 1, times.length - 1);
  const dt = times[b] - times[a];
  const u = dt ? Math.max(0, Math.min(1, (time - times[a]) / dt)) : 0;
  const cubic = interpolation === 'CUBICSPLINE';
  const start = (a * (cubic ? 3 : 1) + (cubic ? 1 : 0)) * width;
  const end = (b * (cubic ? 3 : 1) + (cubic ? 1 : 0)) * width;
  for (let c = 0; c < width; c++) {
    const x = values[start + c],
      y = values[end + c];
    if (interpolation === 'STEP' || a === b || time <= times[0]) out[c] = x;
    else if (cubic) {
      const u2 = u * u,
        u3 = u2 * u;
      out[c] =
        (2 * u3 - 3 * u2 + 1) * x +
        (u3 - 2 * u2 + u) * dt * values[start + width + c] +
        (-2 * u3 + 3 * u2) * y +
        (u3 - u2) * dt * values[end - width + c];
    } else out[c] = x + (y - x) * u;
  }
  if (track.path === 'rotation') {
    if (interpolation === 'LINEAR' && a !== b && time > times[0]) {
      // Read packed keys directly so sampling never creates temporary quaternion arrays.
      let dot = 0;
      for (let c = 0; c < 4; c++) dot += values[start + c] * values[end + c];
      const sign = dot < 0 ? -1 : 1;
      dot = Math.min(1, Math.abs(dot));
      const angle = Math.acos(dot),
        sine = Math.sin(angle);
      const x = sine > 1e-6 ? Math.sin((1 - u) * angle) / sine : 1 - u;
      const y = (sine > 1e-6 ? Math.sin(u * angle) / sine : u) * sign;
      for (let c = 0; c < 4; c++) out[c] = x * values[start + c] + y * values[end + c];
    }
    const length = Math.hypot(...out);
    if (length < 1e-8) throw new Error('Animation produced a zero-length rotation.');
    for (let c = 0; c < 4; c++) out[c] /= length;
  }
}

export function prepareClips(asset: Asset): Clip[] {
  return (asset.gltf.animations ?? []).map((animation, index) => {
    const used = new Set<string>();
    const tracks = animation.channels.map((channel) => {
      const node = channel.target.node;
      if (node === undefined || !asset.gltf.nodes?.[node])
        throw new Error('Animation target node is missing.');
      const path = channel.target.path;
      if (!['translation', 'rotation', 'scale', 'weights'].includes(path))
        throw new Error(`Unsupported animation path ${path}.`);
      if (path !== 'weights' && asset.gltf.nodes[node].matrix)
        throw new Error('TRS animation cannot target a matrix node.');
      const key = `${node}/${path}`;
      if (used.has(key)) throw new Error('Animation has duplicate target channels.');
      used.add(key);
      const sampler = animation.samplers[channel.sampler];
      const input = asset.gltf.accessors?.[sampler?.input],
        output = asset.gltf.accessors?.[sampler?.output];
      if (!input || !output || input.type !== 'SCALAR' || input.componentType !== 5126)
        throw new Error('Invalid animation sampler accessors.');
      const times = decodeAccessor(asset, input),
        values = decodeAccessor(asset, output);
      if (times[0] < 0 || times.some((t, i) => i > 0 && t <= times[i - 1]))
        throw new Error('Animation key times must be nonnegative and strictly increase.');
      const interpolation = sampler.interpolation ?? 'LINEAR';
      if (!['LINEAR', 'STEP', 'CUBICSPLINE'].includes(interpolation))
        throw new Error('Unsupported animation interpolation.');
      const mesh = asset.gltf.meshes?.[asset.gltf.nodes[node].mesh!];
      const width =
        path === 'weights'
          ? (mesh?.primitives[0].targets?.length ?? 0)
          : path === 'rotation'
            ? 4
            : 3;
      if (
        !width ||
        !(
          output.componentType === 5126 ||
          ((path === 'rotation' || path === 'weights') &&
            output.normalized &&
            [5120, 5121, 5122, 5123].includes(output.componentType))
        ) ||
        output.type !== (path === 'weights' ? 'SCALAR' : path === 'rotation' ? 'VEC4' : 'VEC3') ||
        values.length !== times.length * width * (interpolation === 'CUBICSPLINE' ? 3 : 1)
      )
        throw new Error('Animation output does not match its target or key count.');
      if (interpolation === 'CUBICSPLINE' && times.length < 2)
        throw new Error('Cubic animation requires two keys.');
      return { node, path, times, values, width, interpolation } as Track;
    });
    const duration = Math.max(0, ...tracks.map((track) => track.times.at(-1)!));
    const events = (animation.extras?.engine?.events ?? [])
      .map((event) => {
        if (
          !Number.isFinite(event.time) ||
          event.time < 0 ||
          event.time > duration ||
          typeof event.name !== 'string' ||
          !event.name
        )
          throw new Error('Animation event must have a name and a time within its clip.');
        return Object.freeze({ ...event });
      })
      .sort((a, b) => a.time - b.time);
    return {
      name: animation.name ?? `Animation ${index + 1}`,
      duration,
      events: Object.freeze(events),
      tracks,
    };
  });
}
