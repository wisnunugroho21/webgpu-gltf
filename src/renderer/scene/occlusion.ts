import type { Scene } from './types';
import type { ProjectedBounds } from './projected-bounds';
import type { SceneSampleCount } from '../presentation/output';
import { OcclusionDependencies } from './occlusion-dependencies';

export interface OcclusionStats {
  queries: number;
  knownInstances: number;
  hiddenInstances: number;
  capacity: number;
  pending: boolean;
  /** Consecutive camera/occluder changes; two or more suspend new queries. */
  unstableFrames: number;
  discardedResults: number;
}

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
  private known = new Set<number>();
  private revisions = new Map<number, number>();
  private dependencies = new OcclusionDependencies();
  private unstableFrames = 0;
  private queries = 0;
  private discardedResults = 0;
  get stats(): Readonly<OcclusionStats> {
    return {
      queries: this.queries,
      knownInstances: this.known.size,
      hiddenInstances: this.hidden.size,
      capacity: this.capacity,
      pending: this.pending,
      unstableFrames: this.unstableFrames,
      discardedResults: this.discardedResults,
    };
  }
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
    this.known.clear();
  }
  beginFrame(
    scene: Scene,
    matrix: ArrayLike<number>,
    width: number,
    height: number,
    poseChanged: boolean,
  ): void {
    const replaced = this.scene !== scene;
    if (replaced) {
      this.dependencies.reset();
      this.revisions.clear();
    }
    const changes = replaced || poseChanged ? this.dependencies.update(scene) : undefined;
    const cameraChanged = this.camera.some((value, i) => value !== matrix[i]);
    const moved = cameraChanged || !!changes?.depthChanged;
    this.unstableFrames = replaced ? 0 : moved ? this.unstableFrames + 1 : 0;
    if (replaced || this.width !== width || this.height !== height || moved) {
      this.invalidate();
      this.scene = scene;
      this.width = width;
      this.height = height;
      for (let i = 0; i < 16; i++) this.camera[i] = matrix[i];
    }
    for (const id of changes?.receivers ?? []) {
      this.hidden.delete(id);
      this.known.delete(id);
      this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    }
    this.candidates.length = 0;
    this.prepared = false;
    this.queries = 0;
  }
  visible(id: number): boolean {
    return !this.hidden.has(id);
  }
  hasResult(id: number): boolean {
    return this.known.has(id);
  }
  get acceptingQueries(): boolean {
    return !this.pending && this.unstableFrames < 2;
  }
  add(id: number, projected: ProjectedBounds): void {
    // Opaque depth is unchanged within an epoch. Re-querying proven results would
    // spend GPU work without learning anything new. Changed receivers fail open.
    if (this.known.has(id)) return;
    this.candidates.push({ id, projected });
  }

  /** Upload before command encoding. One in-flight readback bounds memory and never
   * stalls rendering. Over-budget candidates rotate through queries; unknown IDs draw. */
  upload(): void {
    if (this.pending || !this.candidates.length || this.unstableFrames >= 2) return;
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
    this.queries = this.ids.length;
  }
  /** Start mapping only after submission. Depth epochs reject scene/camera/occluder
   * changes; receiver revisions separately reject moved BLEND/transmission geometry. */
  afterSubmit(): void {
    if (!this.encoded) return;
    this.encoded = false;
    this.pending = true;
    const generation = this.generation;
    const ids = this.ids.slice();
    const revisions = ids.map((id) => this.revisions.get(id) ?? 0);
    const readback = this.readback!;
    void readback
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        if (!this.disposed && generation === this.generation) {
          const results = new BigUint64Array(readback.getMappedRange());
          ids.forEach((id, i) => {
            if (revisions[i] !== (this.revisions.get(id) ?? 0)) {
              this.discardedResults++;
              return;
            }
            this.known.add(id);
            if (results[i] === 0n) this.hidden.add(id);
            else this.hidden.delete(id);
          });
        } else if (!this.disposed) this.discardedResults += ids.length;
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
