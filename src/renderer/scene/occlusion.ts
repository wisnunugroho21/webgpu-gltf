import type { Scene } from './types';
import type { ProjectedBounds } from './projected-bounds';
import type { SceneSampleCount } from '../presentation/output';

const shader = /* wgsl */ `
struct Proxy { rect: vec4f, depth: vec4f }
@group(0) @binding(0) var<storage, read> proxies: array<Proxy>;
@vertex fn main(@builtin(vertex_index) vertex: u32,
               @builtin(instance_index) instance: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 6>(vec2f(0,0), vec2f(1,0), vec2f(0,1),
                                vec2f(0,1), vec2f(1,0), vec2f(1,1));
  let proxy = proxies[instance];
  return vec4f(mix(proxy.rect.xy, proxy.rect.zw, corners[vertex]), proxy.depth.x, 1);
}
`;

/** Asynchronous, fail-open visibility against this frame's opaque depth. Queries test
 * conservative screen rectangles at the AABB's nearest depth, never write depth/color,
 * and remain independent of material layouts or GPU deformation inputs. */
export class OcclusionCulling {
  private scene?: Scene;
  private camera = new Float32Array(16);
  private width = 0;
  private height = 0;
  private generation = 0;
  private hidden = new Set<number>();
  private candidates: { id: number; projected: ProjectedBounds }[] = [];
  private capacity = 0;
  private querySet?: GPUQuerySet;
  private proxies?: GPUBuffer;
  private resolve?: GPUBuffer;
  private readback?: GPUBuffer;
  private group?: GPUBindGroup;
  private staging = new Float32Array(0);
  private ids: number[] = [];
  private cursor = 0;
  private prepared = false;
  private encoded = false;
  private pending = false;
  private disposed = false;

  private constructor(
    private device: GPUDevice,
    private pipeline: GPURenderPipeline,
  ) {}
  static async create(device: GPUDevice, sampleCount: SceneSampleCount): Promise<OcclusionCulling> {
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage', minBindingSize: 32 },
        },
      ],
    });
    const pipeline = await device.createRenderPipelineAsync({
      label: 'Conservative occlusion proxies',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module: device.createShaderModule({ code: shader }), entryPoint: 'main' },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
      multisample: { count: sampleCount },
    });
    return new OcclusionCulling(device, pipeline);
  }

  invalidate(): void {
    this.generation++;
    this.hidden.clear();
  }
  beginFrame(
    scene: Scene,
    matrix: ArrayLike<number>,
    width: number,
    height: number,
    poseChanged: boolean,
  ): void {
    if (
      this.scene !== scene ||
      this.width !== width ||
      this.height !== height ||
      poseChanged ||
      this.camera.some((value, i) => value !== matrix[i])
    ) {
      this.invalidate();
      this.scene = scene;
      this.width = width;
      this.height = height;
      for (let i = 0; i < 16; i++) this.camera[i] = matrix[i];
    }
    this.candidates.length = 0;
    this.prepared = false;
  }
  visible(id: number): boolean {
    return !this.hidden.has(id);
  }
  add(id: number, projected: ProjectedBounds): void {
    this.candidates.push({ id, projected });
  }

  /** Upload before command encoding. One in-flight readback bounds memory and never
   * stalls rendering. Over-budget candidates rotate through queries; unknown IDs draw. */
  upload(): void {
    if (this.pending || !this.candidates.length) return;
    const limit = Math.min(
      4096,
      Math.floor(this.device.limits.maxStorageBufferBindingSize / 32),
      Math.floor(this.device.limits.maxBufferSize / 32),
    );
    const count = Math.min(limit, this.candidates.length);
    if (!count) return;
    if (count > this.capacity) {
      this.release();
      this.capacity = Math.min(limit, 2 ** Math.ceil(Math.log2(count)));
      this.querySet = this.device.createQuerySet({ type: 'occlusion', count: this.capacity });
      const buffer = (size: number, usage: GPUBufferUsageFlags, label: string) =>
        this.device.createBuffer({ size, usage, label });
      this.proxies = buffer(
        this.capacity * 32,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        'Occlusion proxy rectangles',
      );
      this.resolve = buffer(
        this.capacity * 8,
        GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        'Occlusion query results',
      );
      this.readback = buffer(
        this.capacity * 8,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        'Occlusion asynchronous readback',
      );
      this.staging = new Float32Array(this.capacity * 8);
      this.group = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.proxies } }],
      });
    }
    this.ids.length = count;
    const clip = (value: number) => Math.max(-1, Math.min(1, value));
    for (let i = 0; i < count; i++) {
      const { id, projected: p } = this.candidates[(this.cursor + i) % this.candidates.length];
      this.ids[i] = id;
      // A physical-pixel margin covers rasterization rounding, including MSAA samples.
      // Clip the proxy to the viewport before converting to float32; enormous offscreen
      // projections must not overflow GPU coordinates or lose their visible coverage.
      this.staging.set(
        [
          clip(p.minX - 2 / this.width),
          clip(p.minY - 2 / this.height),
          clip(p.maxX + 2 / this.width),
          clip(p.maxY + 2 / this.height),
          p.depth,
          0,
          0,
          0,
        ],
        i * 8,
      );
    }
    this.cursor = (this.cursor + count) % this.candidates.length;
    this.device.queue.writeBuffer(this.proxies!, 0, this.staging.buffer, 0, count * 32);
    this.prepared = true;
  }
  get ready(): boolean {
    return this.prepared;
  }
  encode(encoder: GPUCommandEncoder, depth: GPUTexture): void {
    if (!this.prepared) return;
    const pass = encoder.beginRenderPass({
      label: 'Occlusion queries',
      colorAttachments: [],
      occlusionQuerySet: this.querySet,
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group!);
    for (let i = 0; i < this.ids.length; i++) {
      pass.beginOcclusionQuery(i);
      pass.draw(6, 1, 0, i);
      pass.endOcclusionQuery();
    }
    pass.end();
    encoder.resolveQuerySet(this.querySet!, 0, this.ids.length, this.resolve!, 0);
    encoder.copyBufferToBuffer(this.resolve!, 0, this.readback!, 0, this.ids.length * 8);
    this.encoded = true;
  }
  /** Start mapping only after submission. A result is usable only for the exact same
   * scene, pose, camera, viewport and culling settings; late obsolete results are ignored. */
  afterSubmit(): void {
    if (!this.encoded) return;
    this.encoded = false;
    this.pending = true;
    const generation = this.generation;
    const ids = this.ids.slice();
    const readback = this.readback!;
    void readback
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        if (!this.disposed && generation === this.generation) {
          const results = new BigUint64Array(readback.getMappedRange());
          ids.forEach((id, i) => {
            if (results[i] === 0n) this.hidden.add(id);
            else this.hidden.delete(id);
          });
        }
        readback.unmap();
      })
      .catch(() => {
        if (!this.disposed && generation === this.generation) this.invalidate();
      })
      .finally(() => {
        this.pending = false;
      });
  }
  private release(): void {
    this.querySet?.destroy();
    this.proxies?.destroy();
    this.resolve?.destroy();
    this.readback?.destroy();
  }
  destroy(): void {
    this.disposed = true;
    this.invalidate();
    this.release();
  }
}
