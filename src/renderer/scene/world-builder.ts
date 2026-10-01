import { vec3 } from 'gl-matrix';
import type { World } from '../../engine/world';
import { Pose } from '../../scene/pose';
import { PunctualLights, maxPunctualLights } from '../../scene/lights';
import { instanceFloatCount, type SceneBindings } from '../core/bindings';
import { uploadBuffer, type Resources } from '../core/resources';
import type { SceneBuilder } from './builder';
import type { Scene } from './types';

/** Rendering bridge only. glTF nodes remain model-local; entities and gameplay
 * data are never synthesized into, or serialized as, glTF nodes. Preparation owns
 * all candidate resources until one atomic scene commit succeeds. */
export async function prepareWorld(
  device: GPUDevice,
  bindings: SceneBindings,
  builder: SceneBuilder,
  world: World,
  resources: Resources,
): Promise<Scene> {
  const structureRevision = world.structureRevision;
  world.updateTransforms();
  const models = world.modelInstances;
  const parts: Scene[] = [];
  for (const model of models)
    parts.push(
      await builder.prepare(model.asset, resources, { pose: model.pose, mutableRoot: true }),
    );
  if (world.structureRevision !== structureRevision)
    throw new Error('World structure changed during preparation.');
  const emptyPose =
    parts[0]?.pose ??
    new Pose({ gltf: { asset: { version: '2.0' } }, buffers: [], images: [], warnings: [] });
  // Authored lights from every model participate; use one fallback light only when
  // no model supplies lights. Limits apply to the complete world, not each asset.
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
  const length = parts.reduce((sum, part) => sum + part.transformData.length, 0);
  if (length * 4 > device.limits.maxStorageBufferBindingSize)
    throw new Error('World transforms exceed this device’s storage-buffer binding limit.');
  const transformData = new Float32Array(length);
  const opaque: Scene['opaque'] = new Map();
  const min = vec3.fromValues(Infinity, Infinity, Infinity),
    max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
  let offset = 0;
  for (const part of parts) {
    transformData.set(part.transformData, offset);
    for (const draw of part.draws) draw.firstInstance += offset / instanceFloatCount;
    for (const update of part.updates) update.pose = part.pose;
    for (const [pipeline, group] of part.opaque) opaque.set(pipeline, group);
    vec3.min(min, min, part.min);
    vec3.max(max, max, part.max);
    offset += part.transformData.length;
  }
  if (!parts.length) {
    vec3.set(min, -1, -1, -1);
    vec3.set(max, 1, 1, 1);
  }
  const transformBuffer = uploadBuffer(
    device,
    resources,
    length ? transformData : new Float32Array(instanceFloatCount),
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    'World model instances',
  );
  return {
    pose: emptyPose,
    lights,
    resources,
    transformData,
    transformBuffer,
    instances: device.createBindGroup({
      layout: bindings.instances,
      entries: [{ binding: 0, resource: { buffer: transformBuffer } }],
    }),
    updates: parts.flatMap((part) => part.updates),
    pendingDeformations: [],
    opaque,
    transparent: parts.flatMap((part) => part.transparent),
    visibleTransparent: [],
    transmission: parts.flatMap((part) => part.transmission),
    visibleTransmission: [],
    draws: parts.flatMap((part) => part.draws),
    min,
    max,
    stats: {
      pipelines: parts.reduce((n, part) => n + part.stats.pipelines, 0),
      draws: parts.reduce((n, part) => n + part.stats.draws, 0),
      instances: parts.reduce((n, part) => n + part.stats.instances, 0),
    },
    world: { source: world, models, structureRevision, poseRevision: -1 },
  };
}
