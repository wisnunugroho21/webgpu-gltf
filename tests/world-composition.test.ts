import { expect, test } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Pose } from '../src/scene/pose';
import { PunctualLights, type SceneLights } from '../src/scene/lights';
import { WorldDrawComposition } from '../src/renderer/scene/world-composition';
import type { Draw, SceneData } from '../src/renderer/scene/types';
import type { GpuMaterial } from '../src/renderer/materials/factory';

const front = {} as GPURenderPipeline,
  mirrored = {} as GPURenderPipeline;
const other = {} as GPURenderPipeline,
  outline = {} as GPURenderPipeline;
const outlineMirrored = {} as GPURenderPipeline;
const material = {} as GpuMaterial;
const transforms = () => new Float32Array(32);
function part(
  pipeline = front,
  mode: 'opaque' | 'transparent' | 'transmission' = 'opaque',
): SceneData {
  const pose = new Pose({
    gltf: { asset: { version: '2.0' } },
    buffers: [],
    images: [],
    warnings: [],
  });
  const bounds = { min: vec3.fromValues(-1, -1, -1), max: vec3.fromValues(1, 1, 1) };
  const draw: Draw = {
    pipeline,
    material,
    vertices: [],
    indexFormat: 'uint16',
    count: 3,
    firstInstance: 0,
    instanceCount: 1,
    center: vec3.create(),
    depth: 0,
    bounds: [bounds],
    visibleRuns: [],
  };
  return {
    pose,
    lights: new PunctualLights(pose),
    transformData: transforms(),
    draws: [draw],
    updates: [
      {
        draw,
        node: 0,
        normal: mat4.create(),
        localBounds: bounds,
        front: pipeline,
        mirrored,
        worldRevision: -1,
      },
    ],
    opaque: mode === 'opaque' ? new Map([[pipeline, new Map([[material, [draw]]])]]) : new Map(),
    transparent: mode === 'transparent' ? [draw] : [],
    transmission: mode === 'transmission' ? [draw] : [],
    visibleTransparent: [],
    visibleTransmission: [],
    pendingDeformations: [],
    min: bounds.min,
    max: bounds.max,
    stats: { pipelines: 1, draws: 1, instances: 1 },
  };
}
const data = (cache: WorldDrawComposition) => cache.sceneData(transforms());

test('copies affected buckets and reuses untouched lists without mutating the active candidate', () => {
  const a = part(),
    b = part(other),
    c = part();
  const cache = new WorldDrawComposition([a, b]);
  const active = data(cache);
  const next = data(new WorldDrawComposition([a, b, c], cache));
  expect(next.opaque.get(other)!.get(material)).toBe(active.opaque.get(other)!.get(material));
  expect(next.opaque.get(front)!.get(material)).not.toBe(active.opaque.get(front)!.get(material));
  expect(active.draws).toEqual([a.draws[0], b.draws[0]]);
  expect(active.opaque.get(front)!.get(material)).toEqual(a.draws);
  expect(next.opaque.get(front)!.get(material)).toEqual([a.draws[0], c.draws[0]]);
  const removed = data(new WorldDrawComposition([b], cache));
  expect(removed.opaque.has(front)).toBe(false);
  expect(removed.opaque.get(other)!.get(material)).toBe(active.opaque.get(other)!.get(material));
});

test('empty model additions share structural lists but reread live bounds and keep frame scratch private', () => {
  const a = part();
  const cache = new WorldDrawComposition([a]);
  const active = data(cache);
  expect(cache.next([a])).toBe(cache);
  const empty = part();
  empty.draws = [];
  empty.updates = [];
  empty.opaque.clear();
  empty.stats = { draws: 0, instances: 0, pipelines: 0 };
  a.draws[0].bounds[0].min[0] = -20;
  const candidate = data(new WorldDrawComposition([a, empty], cache));
  expect(candidate.draws).toBe(active.draws);
  expect(candidate.updates).toBe(active.updates);
  expect(candidate.min[0]).toBe(-20);
  expect(active.min[0]).toBe(-1);
  expect(candidate.visibleTransparent).not.toBe(active.visibleTransparent);
  expect(candidate.visibleTransmission).not.toBe(active.visibleTransmission);
  expect(candidate.pendingDeformations).not.toBe(active.pendingDeformations);
  expect(candidate.lights).toBe(active.lights);
});

test('preserves order and draw identity across replacement, reordering, forward passes and reflected winding', () => {
  const a = part(),
    b = part(front, 'transparent'),
    c = part(other, 'transmission');
  a.opaque.set(mirrored, new Map([[material, a.draws]]));
  a.draws[0].outlinePipeline = outline;
  a.updates[0].outlineFront = outline;
  a.updates[0].outlineMirrored = outlineMirrored;
  const cache = new WorldDrawComposition([a, b, c]);
  const active = data(cache);
  a.draws[0].pipeline = mirrored;
  a.draws[0].outlinePipeline = outlineMirrored;
  b.draws[0].pipeline = mirrored;
  const reordered = data(new WorldDrawComposition([c, b, a], cache));
  expect(reordered.draws).toEqual([c.draws[0], b.draws[0], a.draws[0]]);
  expect(reordered.transparent).toBe(active.transparent);
  expect(reordered.transmission).toBe(active.transmission);
  expect(reordered.opaque.get(front)!.get(material)).toEqual(
    reordered.opaque.get(mirrored)!.get(material),
  );
  expect(reordered.draws[2].pipeline).toBe(mirrored);
  expect(reordered.stats).toEqual({ draws: 3, instances: 3, pipelines: 5 });
  const replacement = part();
  const replaced = data(new WorldDrawComposition([replacement, b, c], cache));
  expect(replaced.draws[0]).toBe(replacement.draws[0]);
  expect(active.draws[0]).toBe(a.draws[0]);
  const fresh = data(new WorldDrawComposition([replacement, b, c]));
  expect({ ...replaced, lights: replaced.lights.instances }).toEqual({
    ...fresh,
    lights: fresh.lights.instances,
  });
});

function authored(source: SceneLights, count = 1): SceneLights {
  return {
    instances: Array.from({ length: count }, () => ({ ...source.instances[0] })),
    authored: true,
    update: () => true,
  };
}

test('selects authored lights, retains live sources, restores fallback and rejects excessive lights transactionally', () => {
  const a = part(),
    b = part();
  b.lights = authored(b.lights);
  const cache = new WorldDrawComposition([a]);
  const active = data(cache);
  const withLight = new WorldDrawComposition([a, b], cache);
  const lit = data(withLight);
  expect(lit.lights.authored).toBe(true);
  expect(lit.lights.instances).toEqual(b.lights.instances);
  expect(lit.lights.update()).toBe(true);
  b.lights.instances[0].intensity = 8;
  expect(lit.lights.instances[0].intensity).toBe(8);
  expect(data(new WorldDrawComposition([a], withLight)).lights.instances).toEqual(
    a.lights.instances,
  );
  const excessive = part();
  excessive.lights = authored(excessive.lights, 33);
  expect(() => new WorldDrawComposition([a, excessive], cache)).toThrow('At most 32 world lights');
  expect(data(cache)).toEqual(active);
});

test('empty world has finite neutral bounds, fallback lighting and fresh scratch', () => {
  const active = new WorldDrawComposition([part()]);
  const empty = data(new WorldDrawComposition([], active));
  expect(empty.draws).toEqual([]);
  expect([...empty.min]).toEqual([-1, -1, -1]);
  expect([...empty.max]).toEqual([1, 1, 1]);
  expect(empty.stats).toEqual({ pipelines: 0, draws: 0, instances: 0 });
  expect(empty.lights.authored).toBe(false);
});
