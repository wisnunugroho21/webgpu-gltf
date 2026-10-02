import { mat4, quat, type ReadonlyMat4 } from 'gl-matrix';
import type { Asset } from '../gltf/types';
import { prepareClips, type Clip } from '../animation/tracks';
import { PoseMixer, clonePose, type BlendSample } from '../animation/blending';
import { transformData, type TransformData, type TransformField } from './transform';

/** Immutable glTF defaults plus reusable mutable pose arrays. Switching clips resets all
 * properties, including those a previous clip animated but the new clip does not. */
export class Pose {
  readonly clips: readonly Clip[];
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
  private root = mat4.create();
  private sampled: Pose['defaults'];
  private worldChanged: Uint8Array;
  private initialized = false;
  private mixer: PoseMixer;
  private single = [{ clip: -1, time: 0, weight: 1 }];
  /** Load-time union of TRS targets and descendants; weights do not move instances. */
  readonly animatedWorld: Uint8Array;
  private rank: number[];
  private previousTargets = new Set<number>();
  private previousWorldTargets = new Set<number>();
  private changedWorlds: number[] = [];
  private selectionKey = '';
  private selected: number[] = [];
  private candidates: number[] = [];
  private overrides = new Map<number, Partial<TransformData>>();
  private currentSamples: readonly BlendSample[] = [];
  private inPlaceRoot?: number;
  private version = 0;
  /** Persistent dirty token, including gameplay edits made before frame evaluation. */
  get revision(): number {
    return this.version;
  }
  profiling = false;
  readonly timings = { mixingMs: 0, worldMs: 0, sampledNodes: 0, visitedNodes: 0 };
  constructor(
    readonly asset: Asset,
    clips?: readonly Clip[],
  ) {
    // Instances can share prepared animation keys; all sampled locals, mixer scratch
    // arrays and revision counters below are still allocated for this pose alone.
    this.clips = clips ?? prepareClips(asset);
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
    // Imported model hierarchies can be deep even when the entity hierarchy is
    // shallow. Use an explicit stack and preserve authored parent-first order.
    const pending = nodes
      .map((_, i) => i)
      .filter((i) => this.parents[i] === -1)
      .reverse();
    while (pending.length) {
      const index = pending.pop()!;
      if (visited.has(index)) throw new Error('Cycle in node hierarchy.');
      visited.add(index);
      this.order.push(index);
      const children = nodes[index].children ?? [];
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
    }
    if (visited.size !== nodes.length) throw new Error('Cycle in node hierarchy.');
    this.rank = nodes.map(() => 0);
    this.order.forEach((node, rank) => (this.rank[node] = rank));
    this.animatedWorld = new Uint8Array(nodes.length);
    const transformTargets = new Set(
      this.clips.flatMap((clip) =>
        clip.tracks.filter((t) => t.path !== 'weights').map((t) => t.node),
      ),
    );
    for (const index of this.order) {
      const parent = this.parents[index];
      this.animatedWorld[index] = Number(
        (parent >= 0 && !!this.animatedWorld[parent]) || transformTargets.has(index),
      );
    }
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

  /** Snapshot only on transition interruption, never in the frame loop. Gameplay
   * overrides stay outside animation snapshots so clearing them resumes playback. */
  capture() {
    return clonePose(this.sampled);
  }
  /** Interruptions capture base animation alone; overlays are added exactly once. */
  captureBlend(samples: readonly BlendSample[]) {
    const result = clonePose(this.defaults);
    this.mixer.evaluate(samples, result);
    return result;
  }
  setInPlaceRoot(node?: number): void {
    if (
      node !== undefined &&
      (!this.nodes[node] || this.parents[node] !== -1 || this.asset.gltf.nodes![node].matrix)
    )
      throw new Error('Root motion requires a root TRS node.');
    this.inPlaceRoot = node;
    this.selectionKey = '\u0000';
    this.evaluateBlend(this.currentSamples);
  }
  private transformNode(index: number) {
    if (!Number.isInteger(index) || !this.nodes[index]) throw new Error('Unknown model node.');
    if (this.asset.gltf.nodes![index].matrix)
      throw new Error(
        'Node TRS overrides require a TRS node; move its entity to place matrix nodes.',
      );
    return this.nodes[index];
  }
  /** Return a copy of effective local TRS, never mutable pose storage. */
  getNodeTransform(index: number): TransformData {
    const node = this.transformNode(index);
    return {
      translation: [...node.translation],
      rotation: [...node.rotation],
      scale: [...node.scale],
    };
  }
  /** Inspect deliberate ownership exceptions; returned fields are detached copies. */
  getNodeOverride(index: number): Partial<TransformData> {
    // Matrix nodes cannot receive TRS overrides, but read-only inspection must
    // still work when snapshots enumerate every node in a valid model.
    if (!Number.isInteger(index) || !this.nodes[index]) throw new Error('Unknown model node.');
    const result: Partial<TransformData> = {};
    const override = this.overrides.get(index);
    for (const field of ['translation', 'rotation', 'scale'] as const)
      if (override?.[field]) result[field] = [...override[field]];
    return result;
  }
  /** Persistent absolute local overrides, applied after animation per supplied field.
   * Empty patches are no-ops; unmentioned fields continue following animation. */
  setNodeTransform(index: number, patch: Partial<TransformData>): boolean {
    this.transformNode(index);
    const validated = transformData(patch);
    const next = { ...this.overrides.get(index) };
    let supplied = false;
    for (const path of ['translation', 'rotation', 'scale'] as const)
      if (patch[path] !== undefined) {
        next[path] = validated[path];
        supplied = true;
      }
    if (!supplied) return false;
    this.overrides.set(index, next);
    this.selectionKey = '\u0000';
    return this.evaluateBlend(this.currentSamples);
  }
  /** Return selected fields to animation/authored values; omission clears all.
   * Validate the complete request before releasing any field ownership. */
  clearNodeTransform(index: number, fields?: readonly TransformField[]): boolean {
    this.transformNode(index);
    if (
      fields !== undefined &&
      (!Array.isArray(fields) ||
        fields.some((field) => !['translation', 'rotation', 'scale'].includes(field)))
    )
      throw new Error('Unknown node override field.');
    const previous = this.overrides.get(index);
    if (!previous) return false;
    if (fields === undefined) this.overrides.delete(index);
    else {
      const next = { ...previous };
      let removed = false;
      for (const field of fields as readonly TransformField[]) {
        removed ||= next[field] !== undefined;
        delete next[field];
      }
      if (!removed) return false;
      if (Object.keys(next).length) this.overrides.set(index, next);
      else this.overrides.delete(index);
    }
    this.selectionKey = '\u0000';
    return this.evaluateBlend(this.currentSamples);
  }
  get rootMirrored(): boolean {
    return mat4.determinant(this.root) < 0;
  }

  /** Gameplay placement is external to authored node locals and clip snapshots.
   * Recompute effective worlds (including joints/lights) without resetting animation. */
  setRootTransform(matrix: ReadonlyMat4): boolean {
    if (matrix.length !== 16 || [...matrix].some((v) => !Number.isFinite(v)))
      throw new Error('Model root must be a finite matrix.');
    let same = true;
    for (let c = 0; c < 16; c++) same &&= matrix[c] === this.root[c];
    if (same) return false;
    const start = this.profiling ? performance.now() : 0;
    mat4.copy(this.root, matrix);
    let changed = false;
    for (const index of this.order) {
      const node = this.nodes[index],
        definition = this.asset.gltf.nodes![index];
      if (definition.matrix) mat4.copy(this.local, definition.matrix as mat4);
      else
        mat4.fromRotationTranslationScale(
          this.local,
          node.rotation as quat,
          node.translation as [number, number, number],
          node.scale as [number, number, number],
        );
      const parent = this.parents[index];
      mat4.multiply(this.world, parent < 0 ? this.root : this.nodes[parent].world, this.local);
      let worldChanged = false;
      for (let c = 0; c < 16; c++) worldChanged ||= this.world[c] !== node.world[c];
      if (worldChanged) {
        mat4.copy(node.world, this.world);
        node.worldRevision++;
        changed = true;
      }
    }
    if (this.profiling) this.timings.worldMs += performance.now() - start;
    if (changed) this.version++;
    return changed;
  }

  validateBlend(samples: readonly BlendSample[]): void {
    this.mixer.validate(samples);
  }
  evaluateBlend(samples: readonly BlendSample[]): boolean {
    const start = this.profiling ? performance.now() : 0;
    this.mixer.validate(samples);
    this.currentSamples = samples;
    // Cache the sparse work list while layer membership stays constant. Include
    // outgoing targets once more to restore defaults on switches/zero-weight layers.
    // Interrupted fades contain arbitrary snapshots and conservatively visit all nodes.
    const key = samples
      .filter((s) => s.weight > 0)
      .map((s) =>
        'pose' in s ? 'snapshot' : `${s.clip}/${s.mask?.join(':') ?? '*'}/${s.additive ?? false}`,
      )
      .join(',');
    if (!this.initialized || key !== this.selectionKey) {
      const active = new Set<number>();
      const worldTargets = new Set<number>();
      if (this.inPlaceRoot !== undefined) {
        active.add(this.inPlaceRoot);
        worldTargets.add(this.inPlaceRoot);
      }
      for (const index of this.overrides.keys()) {
        active.add(index);
        worldTargets.add(index);
      }
      for (const sample of samples) {
        if (!(sample.weight > 0)) continue;
        if ('pose' in sample) for (const index of this.order) active.add(index);
        else
          for (const track of this.clips[sample.clip]?.tracks ?? []) {
            if (sample.mask && !sample.mask.includes(track.node)) continue;
            active.add(track.node);
            if (track.path !== 'weights') worldTargets.add(track.node);
          }
      }
      this.selected = [...new Set([...active, ...this.previousTargets])];
      const affected = new Set(this.selected);
      const expanded = new Set<number>();
      const pending = [...new Set([...worldTargets, ...this.previousWorldTargets])];
      while (pending.length) {
        const index = pending.pop()!;
        if (expanded.has(index)) continue;
        expanded.add(index);
        affected.add(index);
        for (const child of this.asset.gltf.nodes![index].children ?? []) pending.push(child);
      }
      this.candidates = this.initialized
        ? [...affected].sort((a, b) => this.rank[a] - this.rank[b])
        : this.order;
      const retiring = [...this.previousTargets].some((index) => !active.has(index));
      this.previousTargets = active;
      this.previousWorldTargets = worldTargets;
      this.selectionKey = key;
      // On the next evaluation, discard outgoing targets after their defaults restore.
      if (retiring) this.selectionKey = '\u0000';
    }
    this.mixer.evaluate(samples, this.sampled, this.selected);
    const mixed = this.profiling ? performance.now() : 0;
    for (const index of this.changedWorlds) this.worldChanged[index] = 0;
    this.changedWorlds.length = 0;
    let changed = false;
    for (const index of this.candidates) {
      const node = this.nodes[index],
        definition = this.asset.gltf.nodes![index],
        sampled = this.sampled[index];
      let localChanged = !this.initialized;
      for (const path of ['translation', 'rotation', 'scale', 'weights'] as const) {
        const values =
          path === 'weights'
            ? sampled[path]
            : (this.overrides.get(index)?.[path] ??
              (path === 'translation' && index === this.inPlaceRoot
                ? this.defaults[index].translation
                : sampled[path]));
        if (values.some((value, c) => value !== node[path][c])) {
          for (let c = 0; c < values.length; c++) node[path][c] = values[c];
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
      else mat4.multiply(this.world, this.root, this.local);
      // Compare float32 matrices too: a local change can cancel out in world space,
      // including under collapsed parents or equivalent quaternion signs.
      let worldChanged = !this.initialized;
      for (let c = 0; c < 16; c++) worldChanged ||= this.world[c] !== node.world[c];
      if (worldChanged) {
        mat4.copy(node.world, this.world);
        node.worldRevision++;
        this.worldChanged[index] = 1;
        this.changedWorlds.push(index);
        changed = true;
      }
    }
    this.initialized = true;
    if (changed) this.version++;
    // Initialization must not leave a full-scene work list cached for authored mode.
    if (this.candidates === this.order) this.selectionKey = '\u0000';
    if (this.profiling) {
      this.timings.mixingMs = mixed - start;
      this.timings.worldMs = performance.now() - mixed;
      this.timings.sampledNodes = this.selected.length;
      this.timings.visitedNodes = this.candidates.length;
    }
    return changed;
  }
}
