import { mat4, quat } from 'gl-matrix';
import type { Asset } from '../gltf/types';
import { prepareClips, type Clip } from '../animation/tracks';
import { PoseMixer, clonePose, type BlendSample } from '../animation/blending';

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
  private mixer: PoseMixer;
  private single = [{ clip: -1, time: 0, weight: 1 }];
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
    this.mixer = new PoseMixer(this.defaults, this.clips);
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
    this.single[0].clip = clipIndex;
    this.single[0].time = time;
    return this.evaluateBlend(this.single);
  }

  /** Snapshot only on transition interruption, never in the frame loop. */
  capture() {
    return clonePose(this.nodes);
  }

  evaluateBlend(samples: readonly BlendSample[]): boolean {
    this.mixer.evaluate(samples, this.sampled);
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
