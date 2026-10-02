import { instanceFloatCount, type SceneBindings } from '../core/bindings';
import { uploadBuffer, type Resources } from '../core/resources';
import type { Scene, SceneData } from './types';

/** Final binding step for a standalone model or composed world. Keeping this out
 * of model preparation avoids uploading transform buffers discarded by worlds. */
export function bindSceneInstances(
  device: GPUDevice,
  bindings: SceneBindings,
  resources: Resources,
  data: SceneData,
  label: string,
): Scene {
  if (data.transformData.byteLength > device.limits.maxStorageBufferBindingSize)
    throw new Error('Scene transforms exceed this device’s storage-buffer binding limit.');
  const transformBuffer = uploadBuffer(
    device,
    resources,
    data.transformData.length ? data.transformData : new Float32Array(instanceFloatCount),
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label,
  );
  return {
    ...data,
    resources,
    transformBuffer,
    instances: device.createBindGroup({
      layout: bindings.instances,
      entries: [{ binding: 0, resource: { buffer: transformBuffer } }],
    }),
  };
}
