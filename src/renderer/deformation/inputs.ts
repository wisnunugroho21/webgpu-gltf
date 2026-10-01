import type { Deformation } from '../../scene/deformation';
import type { DeformationInputs, SkinInfluences } from '../../scene/deformation-inputs';
import { Resources, uploadBuffer } from '../core/resources';

interface VertexInputs {
  readonly source: Float32Array;
  readonly base: GPUBuffer;
  readonly targets: GPUBuffer;
  readonly count: number;
}
export interface GpuDeformationInputs extends VertexInputs {
  readonly influences: GPUBuffer;
}

/** GPU allocations are registered exactly once with scene Resources, not with each
 * consuming node. Cache lifetime is one scene load; failed/replaced scenes release all
 * shared buffers along with standalone outputs and batch arenas, with no reference counting. */
export class GpuDeformationInputCache {
  private vertices = new Map<DeformationInputs, VertexInputs>();
  private influences = new Map<readonly SkinInfluences[], GPUBuffer>();
  constructor(
    private device: GPUDevice,
    private resources: Resources,
  ) {}

  get(data: Deformation): GpuDeformationInputs {
    let vertices = this.vertices.get(data.inputs);
    if (!vertices) {
      const { count, targetCount, streams } = data.inputs;
      if (Math.ceil(count / 64) > this.device.limits.maxComputeWorkgroupsPerDimension)
        throw new Error('Deformation exceeds this device’s compute dispatch limit.');
      const source = new Float32Array(count * 12);
      const targets = new Float32Array(Math.max(12, count * targetCount * 12));
      // Three vec4s (48 bytes) avoid WGSL vec3 alignment surprises. Tangent W stores
      // handedness; normal W and morph delta W are zero, while base position W is one.
      for (const stream of streams) {
        const offset = { POSITION: 0, NORMAL: 4, TANGENT: 8 }[stream.semantic];
        for (let v = 0; v < count; v++) {
          for (let c = 0; c < stream.width; c++)
            source[v * 12 + offset + c] = stream.base[v * stream.width + c];
          stream.targets.forEach((target, t) => {
            if (target)
              for (let c = 0; c < 3; c++)
                targets[(t * count + v) * 12 + offset + c] = target[v * 3 + c];
          });
        }
      }
      for (let v = 0; v < count; v++) source[v * 12 + 3] = 1;
      vertices = {
        source,
        count,
        base: uploadDeformationStorage(
          this.device,
          this.resources,
          source,
          'Immutable deformation vertices',
        ),
        targets: uploadDeformationStorage(this.device, this.resources, targets, 'Morph deltas'),
      };
      this.vertices.set(data.inputs, vertices);
    }
    let influences = this.influences.get(data.influences);
    if (!influences) {
      const bytes = new ArrayBuffer(Math.max(32, vertices.count * data.influences.length * 32));
      const joints = new Uint32Array(bytes),
        weights = new Float32Array(bytes);
      for (let v = 0; v < vertices.count; v++)
        data.influences.forEach((set, s) => {
          const offset = (v * data.influences.length + s) * 8;
          for (let c = 0; c < 4; c++) {
            joints[offset + c] = set.joints[v * 4 + c];
            weights[offset + 4 + c] = set.weights[v * 4 + c];
          }
        });
      // Morph-only consumers use a cached neutral buffer, even if a skinned consumer
      // of the same primitive has full influences. No node-specific skin data is packed.
      influences = uploadDeformationStorage(
        this.device,
        this.resources,
        new Uint8Array(bytes),
        'Skin influences',
      );
      this.influences.set(data.influences, influences);
    }
    return { ...vertices, influences };
  }
}

export function uploadDeformationStorage(
  device: GPUDevice,
  resources: Resources,
  array: ArrayBufferView,
  label: string,
  dynamic = false,
): GPUBuffer {
  if (
    array.byteLength > device.limits.maxStorageBufferBindingSize ||
    array.byteLength > device.limits.maxBufferSize
  )
    throw new Error(`${label} exceeds this device's storage-buffer limit.`);
  return uploadBuffer(
    device,
    resources,
    array,
    GPUBufferUsage.STORAGE | (dynamic ? GPUBufferUsage.COPY_DST : 0),
    label,
  );
}
