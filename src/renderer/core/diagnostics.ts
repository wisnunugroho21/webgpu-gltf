export interface MemorySnapshot {
  buffers: number;
  textures: number;
  liveBytes: number;
  peakBytes: number;
  requestedBytes: number;
  budgetBytes?: number;
  overBudget: boolean;
}
/** Requested payload estimates, including mip levels, compressed blocks and MSAA.
 * Driver padding, pipeline/query memory and swapchain allocations are excluded. */
export function textureBytes(descriptor: GPUTextureDescriptor): number {
  const plain: Partial<Record<GPUTextureFormat, number>> = {
    rgba8unorm: 4,
    'rgba8unorm-srgb': 4,
    bgra8unorm: 4,
    'bgra8unorm-srgb': 4,
    rgba16float: 8,
    rgba32float: 16,
    r16float: 2,
    rg16float: 4,
    depth32float: 4,
    depth24plus: 4,
  };
  let bw = 1,
    bh = 1,
    stride = plain[descriptor.format];
  if (/^(bc|etc2|eac)/.test(descriptor.format)) {
    bw = bh = 4;
    stride = /^(bc1-|bc4-|etc2-rgb8|eac-r11)/.test(descriptor.format) ? 8 : 16;
    if (descriptor.format.startsWith('etc2-rgb8a1')) stride = 8;
  } else if (descriptor.format.startsWith('astc-')) {
    const match = /^astc-(\d+)x(\d+)-/.exec(descriptor.format)!;
    bw = Number(match[1]);
    bh = Number(match[2]);
    stride = 16;
  }
  if (stride === undefined) throw new Error(`Unmeasured texture format: ${descriptor.format}`);
  const size = descriptor.size;
  const extent = Symbol.iterator in Object(size) ? Array.from(size as Iterable<number>) : undefined;
  const dimensions = size as GPUExtent3DDict;
  const width = extent?.[0] ?? dimensions.width,
    height = extent?.[1] ?? dimensions.height ?? 1,
    layers = extent?.[2] ?? dimensions.depthOrArrayLayers ?? 1;
  let bytes = 0;
  for (let mip = 0; mip < (descriptor.mipLevelCount ?? 1); mip++)
    bytes +=
      Math.ceil(Math.max(1, Math.floor(width / 2 ** mip)) / bw) *
      Math.ceil(Math.max(1, Math.floor(height / 2 ** mip)) / bh) *
      (descriptor.dimension === '3d' ? Math.max(1, Math.floor(layers / 2 ** mip)) : layers) *
      stride *
      (descriptor.sampleCount ?? 1);
  return bytes;
}

/** Opt-in instrumentation installed before renderer startup. A hard budget rejects
 * allocations before requesting them; scene preparation already rolls back candidates.
 * This is a capacity guard, not automatic eviction of live gameplay assets. */
export function trackGpuMemory(device: GPUDevice, budgetBytes?: number) {
  if (budgetBytes !== undefined && (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1))
    throw new Error('GPU budget must be a positive byte count.');
  let buffers = 0,
    textures = 0,
    liveBytes = 0,
    peakBytes = 0,
    requestedBytes = 0;
  const buffer = device.createBuffer.bind(device),
    texture = device.createTexture.bind(device);
  const reserve = (bytes: number) => {
    if (budgetBytes !== undefined && liveBytes + bytes > budgetBytes)
      throw new Error(
        `GPU resource budget exceeded: ${liveBytes + bytes} requested, ${budgetBytes} allowed.`,
      );
  };
  const watch = <T extends GPUBuffer | GPUTexture>(resource: T, bytes: number): T => {
    liveBytes += bytes;
    requestedBytes += bytes;
    peakBytes = Math.max(peakBytes, liveBytes);
    const destroy = resource.destroy.bind(resource);
    let alive = true;
    resource.destroy = () => {
      if (alive) {
        liveBytes -= bytes;
        alive = false;
      }
      destroy();
    };
    return resource;
  };
  device.createBuffer = (descriptor) => {
    reserve(descriptor.size);
    const resource = buffer(descriptor);
    buffers++;
    return watch(resource, resource.size);
  };
  device.createTexture = (descriptor) => {
    const bytes = textureBytes(descriptor);
    reserve(bytes);
    const resource = texture(descriptor);
    textures++;
    return watch(resource, bytes);
  };
  return {
    snapshot: (): MemorySnapshot => ({
      buffers,
      textures,
      liveBytes,
      peakBytes,
      requestedBytes,
      budgetBytes,
      overBudget: budgetBytes !== undefined && liveBytes > budgetBytes,
    }),
    restore: () => {
      device.createBuffer = buffer;
      device.createTexture = texture;
    },
  };
}

export interface GpuTimingSnapshot {
  frame: number;
  passes: { label: string; milliseconds: number }[];
  passTotalMs: number;
}
/** Optional pass timestamps. One bounded readback drops profiling samples while busy;
 * it never blocks rendering and never labels CPU wall time as GPU execution time. */
export class GpuTimer {
  private queries: GPUQuerySet;
  private resolve: GPUBuffer;
  private read: GPUBuffer;
  private busy = false;
  private disposed = false;
  private frame = 0;
  private latest?: GpuTimingSnapshot;
  constructor(device: GPUDevice) {
    this.queries = device.createQuerySet({ type: 'timestamp', count: 128 });
    this.resolve = device.createBuffer({
      size: 1024,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.read = device.createBuffer({
      size: 1024,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }
  get snapshot(): GpuTimingSnapshot | undefined {
    return (
      this.latest && { ...this.latest, passes: this.latest.passes.map((pass) => ({ ...pass })) }
    );
  }
  instrument(encoder: GPUCommandEncoder): (() => void) | undefined {
    if (this.busy || this.disposed) return;
    const labels: string[] = [];
    const stamp = (label = 'Unnamed pass'): GPURenderPassTimestampWrites | undefined => {
      if (labels.length >= 64) return;
      const index = labels.length * 2;
      labels.push(label);
      return {
        querySet: this.queries,
        beginningOfPassWriteIndex: index,
        endOfPassWriteIndex: index + 1,
      };
    };
    const render = encoder.beginRenderPass.bind(encoder),
      compute = encoder.beginComputePass.bind(encoder);
    encoder.beginRenderPass = (descriptor) =>
      render({ ...descriptor, timestampWrites: stamp(descriptor.label) });
    encoder.beginComputePass = (descriptor = {}) =>
      compute({ ...descriptor, timestampWrites: stamp(descriptor.label) });
    return () => {
      if (!labels.length) return;
      const count = labels.length * 2;
      encoder.resolveQuerySet(this.queries, 0, count, this.resolve, 0);
      encoder.copyBufferToBuffer(this.resolve, 0, this.read, 0, count * 8);
      this.busy = true;
      const frame = ++this.frame;
      // Mapping is requested after submission by afterSubmit, never during encoding.
      this.pending = () => {
        void this.read
          .mapAsync(GPUMapMode.READ, 0, count * 8)
          .then(() => {
            if (this.disposed) return;
            const times = new BigUint64Array(this.read.getMappedRange(0, count * 8));
            const passes = labels.map((label, i) => ({
              label,
              milliseconds: Number(times[i * 2 + 1] - times[i * 2]) / 1e6,
            }));
            this.latest = {
              frame,
              passes,
              passTotalMs: passes.reduce((sum, pass) => sum + pass.milliseconds, 0),
            };
            this.read.unmap();
          })
          .catch(() => {
            /* Device loss/disposal cancels readback; recovery owns reporting. */
          })
          .finally(() => {
            this.busy = false;
          });
      };
    };
  }
  private pending?: () => void;
  afterSubmit(): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.();
  }
  destroy(): void {
    this.disposed = true;
    this.pending = undefined;
    this.queries.destroy();
    this.resolve.destroy();
    this.read.destroy();
  }
}
