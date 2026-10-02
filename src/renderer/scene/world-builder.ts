import {
  captureWorldRenderSnapshot,
  planWorldMembership,
  validateWorldRenderSnapshot,
} from '../../engine/rendering/world-snapshot';
import { InstanceSlots } from '../../engine/rendering/instance-slots';
import type { World } from '../../engine/world';
import { instanceFloatCount, type SceneBindings } from '../core/bindings';
import { SharedResources, type Resources } from '../core/resources';
import type { SceneBuilder } from './builder';
import type { Scene, WorldRenderPart, WorldInstanceBinding } from './types';
import { bindSceneInstances } from './instance-binding';
import { WorldDrawComposition } from './world-composition';

/** Internal preparation diagnostics; no GPU waits or application API changes. */
export interface WorldPreparationProfile {
  membershipMs: number;
  acquisitionMs: number;
  compositionMs: number;
  /** The following three fields are nested within compositionMs. */
  drawIndexMs: number;
  boundsAndStatsMs: number;
  revisionRemapMs: number;
  transformsMs: number;
  bindingMs: number;
}

/** Device-side membership preparation consumes the engine bridge's snapshot.
 * Surviving model records and transform slots retain their identity. All additions,
 * slot reuse and binding growth are staged before the renderer's atomic commit. */
export async function prepareWorld(
  device: GPUDevice,
  bindings: SceneBindings,
  builder: SceneBuilder,
  world: World,
  resources: Resources,
  previous?: Scene,
  profile?: (sample: WorldPreparationProfile) => void,
): Promise<Scene> {
  const now = profile ? () => performance.now() : () => 0;
  const start = now();
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
  const membershipEnd = now();
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
  const acquisitionEnd = now();
  const parts = [...records.values()].map((part) => part.data);
  const composition = state?.composition.next(parts) ?? new WorldDrawComposition(parts);
  const indexEnd = now();
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
  const transformsEnd = now();
  const data = composition.sceneData(transformData);
  const boundsEnd = now();
  const previousRevisions = new Map(
    state?.models.map((model, index) => [model, state.uploadedPoseRevisions?.[index] ?? -1]),
  );
  const compositionEnd = now();
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
  profile?.({
    membershipMs: membershipEnd - start,
    acquisitionMs: acquisitionEnd - membershipEnd,
    compositionMs: indexEnd - acquisitionEnd + compositionEnd - transformsEnd,
    drawIndexMs: indexEnd - acquisitionEnd,
    boundsAndStatsMs: boundsEnd - transformsEnd,
    revisionRemapMs: compositionEnd - boundsEnd,
    transformsMs: transformsEnd - indexEnd,
    bindingMs: now() - compositionEnd,
  });
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
      composition,
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
