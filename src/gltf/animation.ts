import { mat4, quat } from 'gl-matrix';
import { decodeAccessor } from './accessors';
import type { Asset, Animation } from './types';

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
    return {
      name: animation.name ?? `Animation ${index + 1}`,
      duration: Math.max(0, ...tracks.map((track) => track.times.at(-1)!)),
      tracks,
    };
  });
}

/** Immutable glTF defaults plus reusable mutable pose arrays. Switching clips resets all
 * properties, including those a previous clip animated but the new clip does not. */
export class Pose {
  readonly clips: Clip[];
  readonly nodes: {
    translation: number[];
    rotation: number[];
    scale: number[];
    weights: number[];
    world: mat4;
    worldRevision: number;
    weightsRevision: number;
  }[];
  private parents: number[];
  private order: number[] = [];
  private defaults: {
    translation: number[];
    rotation: number[];
    scale: number[];
    weights: number[];
  }[];
  private local = mat4.create();
  private world = mat4.create();
  private sampled: Pose['defaults'];
  private worldChanged: Uint8Array;
  private initialized = false;
  constructor(readonly asset: Asset) {
    this.clips = prepareClips(asset);
    const nodes = asset.gltf.nodes ?? [];
    this.defaults = nodes.map((node) => {
      const mesh = asset.gltf.meshes?.[node.mesh!];
      const count = mesh?.primitives[0].targets?.length ?? 0;
      if (mesh?.primitives.some((p) => (p.targets?.length ?? 0) !== count))
        throw new Error('Mesh primitives must have the same morph target count.');
      const weights = [...(node.weights ?? mesh?.weights ?? new Array(count).fill(0))];
      if (weights.length !== count || weights.some((w) => !Number.isFinite(w)))
        throw new Error('Morph weight count does not match targets.');
      return {
        translation: [...(node.translation ?? [0, 0, 0])],
        rotation: [...(node.rotation ?? [0, 0, 0, 1])],
        scale: [...(node.scale ?? [1, 1, 1])],
        weights,
      };
    });
    this.nodes = this.defaults.map((node) => ({
      translation: [...node.translation],
      rotation: [...node.rotation],
      scale: [...node.scale],
      weights: [...node.weights],
      world: mat4.create(),
      worldRevision: 0,
      weightsRevision: 0,
    }));
    this.sampled = this.defaults.map((node) => ({
      translation: [...node.translation],
      rotation: [...node.rotation],
      scale: [...node.scale],
      weights: [...node.weights],
    }));
    this.worldChanged = new Uint8Array(nodes.length);
    this.parents = nodes.map(() => -1);
    nodes.forEach((node, parent) =>
      node.children?.forEach((child) => {
        if (!nodes[child] || this.parents[child] !== -1) throw new Error('Invalid node hierarchy.');
        this.parents[child] = parent;
      }),
    );
    const visited = new Set<number>();
    const visit = (index: number) => {
      if (visited.has(index)) throw new Error('Cycle in node hierarchy.');
      visited.add(index);
      this.order.push(index);
      for (const child of nodes[index].children ?? []) visit(child);
    };
    nodes.forEach((_, i) => {
      if (this.parents[i] === -1) visit(i);
    });
    if (visited.size !== nodes.length) throw new Error('Cycle in node hierarchy.');
    this.evaluate(-1, 0);
  }
  /** Compare the final sampled pose, not the temporary reset to authored defaults.
   * Revisions change only for effective world matrices or morph weights. Parent changes
   * propagate through the hierarchy; held STEP/constant values leave revisions intact. */
  evaluate(clipIndex: number, time: number): boolean {
    this.sampled.forEach((node, i) => {
      const original = this.defaults[i];
      for (const path of ['translation', 'rotation', 'scale', 'weights'] as const)
        for (let c = 0; c < original[path].length; c++) node[path][c] = original[path][c];
    });
    for (const track of this.clips[clipIndex]?.tracks ?? [])
      sampleTrack(track, time, this.sampled[track.node][track.path]);
    this.worldChanged.fill(0);
    let changed = false;
    for (const index of this.order) {
      const node = this.nodes[index],
        definition = this.asset.gltf.nodes![index],
        sampled = this.sampled[index];
      let localChanged = !this.initialized;
      for (const path of ['translation', 'rotation', 'scale', 'weights'] as const) {
        if (sampled[path].some((value, c) => value !== node[path][c])) {
          for (let c = 0; c < sampled[path].length; c++) node[path][c] = sampled[path][c];
          if (path === 'weights') {
            node.weightsRevision++;
            changed = true;
          } else localChanged = true;
        }
      }
      const parent = this.parents[index];
      if (!localChanged && (parent < 0 || !this.worldChanged[parent])) continue;
      if (definition.matrix) mat4.copy(this.local, definition.matrix as mat4);
      else
        mat4.fromRotationTranslationScale(
          this.local,
          node.rotation as quat,
          node.translation as [number, number, number],
          node.scale as [number, number, number],
        );
      if (parent >= 0) mat4.multiply(this.world, this.nodes[parent].world, this.local);
      else mat4.copy(this.world, this.local);
      // Compare float32 matrices too: a local change can cancel out in world space,
      // including under collapsed parents or equivalent quaternion signs.
      let worldChanged = !this.initialized;
      for (let c = 0; c < 16; c++) worldChanged ||= this.world[c] !== node.world[c];
      if (worldChanged) {
        mat4.copy(node.world, this.world);
        node.worldRevision++;
        this.worldChanged[index] = 1;
        changed = true;
      }
    }
    this.initialized = true;
    return changed;
  }
}
