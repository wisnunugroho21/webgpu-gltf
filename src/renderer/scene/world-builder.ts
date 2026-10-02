import { vec3 } from 'gl-matrix';
import {
  captureWorldRenderSnapshot,
  planWorldMembership,
  validateWorldRenderSnapshot,
} from '../../engine/rendering/world-snapshot';
import { InstanceSlots } from '../../engine/rendering/instance-slots';
import type { World } from '../../engine/world';
import { Pose } from '../../scene/pose';
import { PunctualLights, maxPunctualLights } from '../../scene/lights';
import { instanceFloatCount, type SceneBindings } from '../core/bindings';
import { SharedResources, type Resources } from '../core/resources';
import type { SceneBuilder } from './builder';
import type { Scene, WorldRenderPart, WorldInstanceBinding } from './types';
import { bindSceneInstances } from './instance-binding';

/** Device-side composition consumes the engine bridge's membership snapshot.
 * Surviving model records and transform slots retain their identity. All additions,
 * slot reuse and binding growth are staged before the renderer's atomic commit. */
export async function prepareWorld(
  device: GPUDevice,
  bindings: SceneBindings,
  builder: SceneBuilder,
  world: World,
  resources: Resources,
  previous?: Scene,
): Promise<Scene> {
  const snapshot = captureWorldRenderSnapshot(world);
  const retained = previous?.world?.source === world ? previous : undefined;
  const state = retained?.world;
  if (state?.structureRevision === snapshot.structureRevision) return retained!;
  const slots = state?.slots.clone() ?? new InstanceSlots();
  const membership = planWorldMembership(snapshot, state?.models ?? []);
  const { models } = membership;
  for (const model of membership.removed) slots.release(state!.parts.get(model)!.handle);
  const records = new Map<(typeof models)[number], WorldRenderPart>();
  const added: WorldRenderPart[] = [];
  for (const model of models) {
    const existing = state?.parts.get(model);
    if (existing) {
      existing.lifetime.retain(resources);
      records.set(model, existing);
      continue;
    }
    const lifetime = new SharedResources();
    // Register ownership before any asynchronous preparation or allocation.
    lifetime.retain(resources);
    const data = await builder.prepareModel(model.asset, lifetime.resources, {
      pose: model.pose,
      mutableRoot: true,
      allowEmpty: true,
    });
    // Lights-only and empty selected scenes still have model identity. Reserve a
    // neutral slot without fabricating draws; the explicit binding stays valid.
    const handle = slots.allocate(Math.max(1, data.transformData.length / instanceFloatCount));
    for (const draw of data.draws) draw.firstInstance += handle.firstInstance;
    for (const update of data.updates) update.pose = data.pose;
    const part = { handle, data, lifetime };
    records.set(model, part);
    added.push(part);
  }
  validateWorldRenderSnapshot(snapshot);
  const parts = [...records.values()].map((part) => part.data);
  const emptyPose =
    parts[0]?.pose ??
    new Pose({ gltf: { asset: { version: '2.0' } }, buffers: [], images: [], warnings: [] });
  const sources = parts.some((part) => part.lights.authored)
    ? parts.filter((part) => part.lights.authored).map((part) => part.lights)
    : [parts[0]?.lights ?? new PunctualLights(emptyPose)];
  const lights = {
    instances: sources.flatMap((source) => source.instances),
    authored: sources.some((source) => source.authored),
    update: () => {
      let changed = false;
      for (const source of sources) changed = source.update() || changed;
      return changed;
    },
  };
  if (lights.instances.length > maxPunctualLights)
    throw new Error(`At most ${maxPunctualLights} world lights are supported.`);
  const limit = Math.floor(device.limits.maxStorageBufferBindingSize / (instanceFloatCount * 4));
  const required = Math.max(1, slots.requiredCapacity);
  if (required > limit)
    throw new Error('World transforms exceed this device’s storage-buffer binding limit.');
  const grow =
    !state || required > state.binding.capacity || (!models.length && state.binding.capacity > 1);
  const capacity = grow
    ? Math.min(limit, Math.max(required, models.length ? (state?.binding.capacity ?? 0) * 2 : 1))
    : state.binding.capacity;
  const transformData = new Float32Array(capacity * instanceFloatCount);
  if (retained) transformData.set(retained.transformData.subarray(0, transformData.length));
  for (const part of added)
    transformData.set(part.data.transformData, part.handle.firstInstance * instanceFloatCount);
  const opaque: Scene['opaque'] = new Map();
  for (const part of parts)
    for (const [pipeline, materials] of part.opaque) {
      let group = opaque.get(pipeline);
      if (!group) opaque.set(pipeline, (group = new Map()));
      for (const [material, draws] of materials) {
        let list = group.get(material);
        if (!list) group.set(material, (list = []));
        for (const draw of draws) list.push(draw);
      }
    }
  const draws = parts.flatMap((part) => part.draws);
  const min = vec3.fromValues(Infinity, Infinity, Infinity),
    max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
  for (const draw of draws)
    for (const bounds of draw.bounds) {
      vec3.min(min, min, bounds.min);
      vec3.max(max, max, bounds.max);
    }
  if (!draws.length) {
    vec3.set(min, -1, -1, -1);
    vec3.set(max, 1, 1, 1);
  }
  const previousRevisions = new Map(
    state?.models.map((model, index) => [model, state.uploadedPoseRevisions?.[index] ?? -1]),
  );
  const data = {
    pose: emptyPose,
    lights,
    transformData,
    updates: parts.flatMap((part) => part.updates),
    pendingDeformations: [],
    opaque,
    transparent: parts.flatMap((part) => part.transparent),
    visibleTransparent: [],
    transmission: parts.flatMap((part) => part.transmission),
    visibleTransmission: [],
    draws,
    min,
    max,
    stats: {
      pipelines: new Set(
        parts.flatMap((part) => [
          ...part.opaque.keys(),
          ...part.transparent.map((draw) => draw.pipeline),
          ...part.transmission.map((draw) => draw.pipeline),
          ...part.draws.flatMap((draw) => (draw.outlinePipeline ? [draw.outlinePipeline] : [])),
          ...part.updates.flatMap((update) =>
            [update.outlineFront, update.outlineMirrored].filter(
              (pipeline): pipeline is GPURenderPipeline => !!pipeline,
            ),
          ),
        ]),
      ).size,
      draws: parts.reduce((n, part) => n + part.stats.draws, 0),
      instances: parts.reduce((n, part) => n + part.stats.instances, 0),
    },
  };
  let binding: WorldInstanceBinding;
  if (grow) {
    const lifetime = new SharedResources();
    lifetime.retain(resources);
    const bound = bindSceneInstances(
      device,
      bindings,
      lifetime.resources,
      data,
      'World model instances',
    );
    binding = { capacity, buffer: bound.transformBuffer, group: bound.instances, lifetime };
  } else {
    binding = state.binding;
    binding.lifetime.retain(resources);
  }
  return {
    ...data,
    resources,
    transformBuffer: binding.buffer,
    instances: binding.group,
    world: {
      source: snapshot.source,
      models,
      structureRevision: snapshot.structureRevision,
      parts: records,
      slots,
      binding,
      uploadedPoseRevisions: models.map((model) => previousRevisions.get(model) ?? -1),
      // Reused slots may still belong to the active scene during preparation.
      // Write them only after CPU/GPU validation and revision checks succeed.
      ...(grow || !added.length
        ? {}
        : {
            activate: () => {
              for (const part of added) {
                const offset = part.handle.firstInstance * instanceFloatCount * 4;
                device.queue.writeBuffer(
                  binding.buffer,
                  offset,
                  transformData.buffer,
                  offset,
                  part.data.transformData.byteLength,
                );
              }
            },
          }),
    },
  };
}
