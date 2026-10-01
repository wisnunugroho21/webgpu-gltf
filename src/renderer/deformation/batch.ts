import type { Deformation } from '../../scene/deformation';
import type { SkinInfluences } from '../../scene/deformation-inputs';
import { Resources, uploadBuffer } from '../core/resources';
import type { DeformationCompute } from './compute';
import type { GpuDeformationInputCache, GpuDeformationInputs } from './inputs';

export interface DeformationBatchSlot {
  readonly batch: DeformationBatch;
  readonly index: number;
  readonly paletteOffset: number;
  readonly weightsOffset: number;
  readonly outputOffset: number;
}

/** Compatible nodes occupy disjoint arena slices. No pose/output gather/scatter copies
 * are needed: pose uploads write their own slices and draws bind their own vertex offsets. */
export class DeformationBatch {
  readonly palette: GPUBuffer;
  readonly weights: GPUBuffer;
  readonly output: GPUBuffer;
  private jobs: GPUBuffer;
  private active: Uint32Array<ArrayBuffer>;
  private count = 0;
  private encoded = false;
  private group: GPUBindGroup;
  constructor(
    private device: GPUDevice,
    resources: Resources,
    private compute: DeformationCompute,
    inputs: GpuDeformationInputs,
    data: Deformation,
    capacity: number,
    readonly paletteStride: number,
    readonly weightsStride: number,
    readonly outputStride: number,
  ) {
    const arena = (size: number, label: string, usage: GPUBufferUsageFlags) =>
      resources.own(device.createBuffer({ size, label, usage }));
    this.palette = arena(
      capacity * paletteStride,
      'Batched joint palettes',
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    this.weights = arena(
      capacity * weightsStride,
      'Batched morph weights',
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    this.output = arena(
      capacity * outputStride,
      'Batched deformed vertex output',
      GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC,
    );
    this.active = new Uint32Array(capacity);
    this.jobs = arena(
      capacity * 4,
      'Active deformation jobs',
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    const params = uploadBuffer(
      device,
      resources,
      new Uint32Array([
        inputs.count,
        data.weights.length,
        data.influences.length,
        Number(data.skinned),
        paletteStride / 64,
        weightsStride / 4,
        outputStride / 48,
        0,
      ]),
      GPUBufferUsage.UNIFORM,
      'Batched deformation counts',
    );
    this.group = device.createBindGroup({
      layout: compute.batchLayout,
      entries: [
        params,
        inputs.base,
        inputs.targets,
        inputs.influences,
        this.palette,
        this.weights,
        this.output,
        this.jobs,
      ].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    this.vertices = inputs.count;
  }
  private vertices: number;
  reset(): void {
    this.count = 0;
    this.encoded = false;
  }
  add(index: number): void {
    this.active[this.count++] = index;
  }
  upload(): void {
    // Upload phase only. Encoding never writes a queue buffer or rebuilds bind groups.
    this.device.queue.writeBuffer(this.jobs, 0, this.active.buffer, 0, this.count * 4);
  }
  encode(pass: GPUComputePassEncoder): void {
    if (this.encoded) return;
    if (!this.count) throw new Error('Prepare active deformation jobs before encoding a batch.');
    pass.setPipeline(this.compute.batchPipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(Math.ceil(this.vertices / 64), this.count);
    this.encoded = true;
  }
}

/** Plan compatible arenas at scene preparation, splitting before any device limit.
 * Singletons retain the standalone path, avoiding arena padding for isolated meshes. */
export function planDeformationBatches(
  device: GPUDevice,
  resources: Resources,
  compute: DeformationCompute,
  cache: GpuDeformationInputCache,
  definitions: readonly Deformation[],
): Map<Deformation, DeformationBatchSlot> {
  const slots = new Map<Deformation, DeformationBatchSlot>();
  const groups = new Map<readonly SkinInfluences[], Deformation[]>();
  // The caller supplies one primitive at a time. Influence identity distinguishes
  // morph-only from skinned nodes; different skins may share influences but not palettes.
  for (const data of definitions) {
    let group = groups.get(data.influences);
    if (!group) groups.set(data.influences, (group = []));
    group.push(data);
  }
  const alignment = device.limits.minStorageBufferOffsetAlignment;
  const align = (size: number, stride: number) => Math.ceil(size / stride) * stride;
  // Output offsets must satisfy storage binding alignment AND the 48-byte vertex stride.
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const outputAlignment = (alignment / gcd(alignment, 48)) * 48;
  const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const paletteStride = align(
      group.reduce((size, data) => Math.max(size, data.palette.length * 64), 64),
      alignment,
    );
    const weightsStride = align(Math.max(4, group[0].weights.length * 4), alignment);
    const outputStride = align(group[0].inputs.count * 48, outputAlignment);
    const capacity = Math.min(
      device.limits.maxComputeWorkgroupsPerDimension,
      Math.floor(limit / Math.max(paletteStride, weightsStride, outputStride, 4)),
    );
    if (capacity < 2) continue;
    for (let first = 0; first < group.length; first += capacity) {
      const members = group.slice(first, first + capacity);
      if (members.length < 2) continue;
      const batch = new DeformationBatch(
        device,
        resources,
        compute,
        cache.get(members[0]),
        members[0],
        members.length,
        paletteStride,
        weightsStride,
        outputStride,
      );
      members.forEach((data, index) =>
        slots.set(data, {
          batch,
          index,
          paletteOffset: index * paletteStride,
          weightsOffset: index * weightsStride,
          outputOffset: index * outputStride,
        }),
      );
    }
  }
  return slots;
}

export function prepareDeformationBatches(
  pending: readonly { batch?: DeformationBatchSlot }[],
): void {
  const batches = new Set<DeformationBatch>();
  for (const deformation of pending) {
    const slot = deformation.batch;
    if (!slot) continue;
    if (!batches.has(slot.batch)) {
      slot.batch.reset();
      batches.add(slot.batch);
    }
    slot.batch.add(slot.index);
  }
  for (const batch of batches) batch.upload();
}
