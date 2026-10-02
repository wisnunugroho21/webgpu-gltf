import { vec3 } from 'gl-matrix';
import { Pose } from '../../scene/pose';
import { PunctualLights, maxPunctualLights, type SceneLights } from '../../scene/lights';
import type { GpuMaterial } from '../materials/factory';
import type { Draw, PoseDraw, SceneData, Scene, WorldComposition } from './types';

interface List<T> {
  readonly sources: readonly T[][];
  readonly values: T[];
}

function sameSources<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((source, index) => source === b[index]);
}

/** Source arrays are prepared once per model. Draw objects remain live: winding,
 * bounds and visibility can change without changing structural membership. */
function combine<T>(sources: T[][], previous?: List<T>): List<T> {
  if (previous && sameSources(sources, previous.sources)) return previous;
  const values = new Array<T>(sources.reduce((count, source) => count + source.length, 0));
  let index = 0;
  for (const source of sources) for (const value of source) values[index++] = value;
  return { sources, values };
}

type Groups = Map<GPURenderPipeline, Map<GpuMaterial, List<Draw>>>;

/** CPU-only candidate composition. No model acquisition, slot allocation, leases,
 * uploads or GPU ownership belong here. Candidates never mutate the active cache.
 * Only affected lists are copied; shared lists are read-only to render consumers. */
export class WorldDrawComposition implements WorldComposition {
  private readonly groups: Groups = new Map();
  private readonly opaque: Scene['opaque'] = new Map();
  private readonly draws: List<Draw>;
  private readonly updates: List<PoseDraw>;
  private readonly transparent: List<Draw>;
  private readonly transmission: List<Draw>;
  private readonly summaries = new Map<SceneData, ReadonlySet<GPURenderPipeline>>();
  private readonly pipelines = new Set<GPURenderPipeline>();
  private readonly lights: SceneLights;
  private readonly lightSources: readonly SceneLights[];
  private readonly pose: Pose;
  private readonly drawCount: number;
  private readonly instanceCount: number;

  constructor(
    private readonly parts: readonly SceneData[],
    previous?: WorldDrawComposition,
  ) {
    this.pose =
      parts[0]?.pose ??
      new Pose({ gltf: { asset: { version: '2.0' } }, buffers: [], images: [], warnings: [] });
    const lists = <K extends 'draws' | 'updates' | 'transparent' | 'transmission'>(key: K) =>
      parts.map((part) => part[key]).filter((list) => list.length);
    this.draws = combine(lists('draws'), previous?.draws);
    this.updates = combine(lists('updates'), previous?.updates);
    this.transparent = combine(lists('transparent'), previous?.transparent);
    this.transmission = combine(lists('transmission'), previous?.transmission);

    const sources = new Map<GPURenderPipeline, Map<GpuMaterial, Draw[][]>>();
    for (const part of parts) {
      for (const [pipeline, materials] of part.opaque) {
        let group = sources.get(pipeline);
        if (!group) sources.set(pipeline, (group = new Map()));
        for (const [material, draws] of materials) {
          let list = group.get(material);
          if (!list) group.set(material, (list = []));
          list.push(draws);
        }
      }
      // Cache prepared alternatives, never the draw's current winding selection.
      // Opaque draws may appear under both pipelines; outlines keep both variants.
      let summary = previous?.summaries.get(part);
      if (!summary) {
        const prepared = new Set(part.opaque.keys());
        for (const draw of part.draws) if (draw.outlinePipeline) prepared.add(draw.outlinePipeline);
        for (const update of part.updates) {
          if (update.outlineFront) prepared.add(update.outlineFront);
          if (update.outlineMirrored) prepared.add(update.outlineMirrored);
        }
        summary = prepared;
      }
      this.summaries.set(part, summary);
      for (const pipeline of summary) this.pipelines.add(pipeline);
    }
    for (const [pipeline, materials] of sources) {
      const group = new Map<GpuMaterial, List<Draw>>();
      const output = new Map<GpuMaterial, Draw[]>();
      for (const [material, lists] of materials) {
        const list = combine(lists, previous?.groups.get(pipeline)?.get(material));
        group.set(material, list);
        output.set(material, list.values);
      }
      this.groups.set(pipeline, group);
      this.opaque.set(pipeline, output);
    }
    this.drawCount = parts.reduce((count, part) => count + part.stats.draws, 0);
    this.instanceCount = parts.reduce((count, part) => count + part.stats.instances, 0);
    this.lightSources = parts.some((part) => part.lights.authored)
      ? parts.filter((part) => part.lights.authored).map((part) => part.lights)
      : [parts[0]?.lights ?? new PunctualLights(this.pose)];
    if (previous && sameSources(this.lightSources, previous.lightSources)) {
      this.lights = previous.lights;
    } else {
      const sources = this.lightSources;
      this.lights = {
        instances: sources.flatMap((source) => source.instances),
        authored: sources.some((source) => source.authored),
        update: () => {
          let changed = false;
          for (const source of sources) changed = source.update() || changed;
          return changed;
        },
      };
    }
    if (this.lights.instances.length > maxPunctualLights)
      throw new Error(`At most ${maxPunctualLights} world lights are supported.`);
  }

  next(parts: readonly SceneData[]): WorldDrawComposition {
    return sameSources(parts, this.parts) ? this : new WorldDrawComposition(parts, this);
  }

  /** Bounds and forward pipeline selections are mutable pose state. Read them at
   * every membership boundary instead of retaining stale aggregate bounds/stats.
   * Frame-local visibility/sorting/deformation lists always belong to the candidate. */
  sceneData(transformData: Float32Array): SceneData {
    const min = vec3.fromValues(Infinity, Infinity, Infinity);
    const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
    for (const draw of this.draws.values)
      for (const bounds of draw.bounds) {
        vec3.min(min, min, bounds.min);
        vec3.max(max, max, bounds.max);
      }
    if (!this.draws.values.length) {
      vec3.set(min, -1, -1, -1);
      vec3.set(max, 1, 1, 1);
    }
    const pipelines = new Set(this.pipelines);
    for (const draw of this.transparent.values) pipelines.add(draw.pipeline);
    for (const draw of this.transmission.values) pipelines.add(draw.pipeline);
    return {
      pose: this.pose,
      lights: this.lights,
      transformData,
      draws: this.draws.values,
      updates: this.updates.values,
      opaque: this.opaque,
      transparent: this.transparent.values,
      transmission: this.transmission.values,
      pendingDeformations: [],
      visibleTransparent: [],
      visibleTransmission: [],
      min,
      max,
      stats: { pipelines: pipelines.size, draws: this.drawCount, instances: this.instanceCount },
    };
  }
}
