import { vec3 } from 'gl-matrix';
import { maxPunctualLights } from '../../scene/lights';
import type { Scene } from '../scene/types';
import { shadowMatrices } from './shadows/matrices';
import type { Draw } from '../scene/types';

export const maxShadowLights = 4;
export const maxShadowMaps = maxShadowLights * 6;
export const lightingFloats = 4 + maxPunctualLights * 20 + maxShadowMaps * 16;
export type ShadowResolution = 256 | 512 | 1024;
export interface ShadowSettings {
  enabled: boolean;
  resolution: ShadowResolution;
  depthBias: number;
  normalBias: number;
}
export type ShadowUpdate = Partial<Pick<ShadowSettings, 'enabled' | 'depthBias' | 'normalBias'>>;
export interface ShadowMemoryStats {
  /** Active map capacity, not the maximum supported number of maps. */
  maps: number;
  neutralBytes: number;
  depthSamplesBytes: number;
  depthAttachmentBytes: number;
  matrixBytes: number;
  /** Requested GPU resource bytes; excludes light records and driver overhead. */
  totalBytes: number;
}

/** Renderer-owned light records and shadow resources use a fixed binding layout.
 * One depth attachment is reused face-by-face; its values are copied GPU-to-GPU into
 * storage for PCF, avoiding a seventeenth sampled texture on baseline WebGPU devices. */
export class PunctualLighting {
  readonly buffer: GPUBuffer;
  private neutral: GPUBuffer;
  private samples?: GPUBuffer;
  get shadowBuffer(): GPUBuffer {
    return this.samples ?? this.neutral;
  }
  readonly shadowLayout: GPUBindGroupLayout;
  private depth?: GPUTexture;
  private view?: GPUTextureView;
  private matrices?: GPUBuffer;
  private capacity = 0;
  get memoryStats(): Readonly<ShadowMemoryStats> {
    const neutralBytes = this.neutral.size;
    const depthSamplesBytes = this.samples?.size ?? 0;
    const depthAttachmentBytes = this.depth ? this.values.resolution ** 2 * 4 : 0;
    const matrixBytes = this.matrices?.size ?? 0;
    return {
      maps: this.capacity,
      neutralBytes,
      depthSamplesBytes,
      depthAttachmentBytes,
      matrixBytes,
      totalBytes: neutralBytes + depthSamplesBytes + depthAttachmentBytes + matrixBytes,
    };
  }
  private mapGroups: GPUBindGroup[] = [];
  private data = new Float32Array(lightingFloats);
  private views = 0;
  private scene?: Scene;
  private dependencies: number[] = [];
  private dirty = true;
  private shadowDirty = false;
  private values: ShadowSettings;
  get settings(): Readonly<ShadowSettings> {
    return { ...this.values };
  }
  constructor(
    private device: GPUDevice,
    resolution: ShadowResolution = 512,
    enabled = true,
  ) {
    this.values = { resolution, enabled, depthBias: 0.00005, normalBias: 0.002 };
    this.buffer = device.createBuffer({
      label: 'Punctual light records',
      size: this.data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Binding 4 is always present. No maps are read when each light's shadow index
    // is -1; one initialized f32 keeps the runtime-array binding valid in that case.
    this.neutral = device.createBuffer({
      label: 'Neutral shadow depth',
      size: 4,
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    new Float32Array(this.neutral.getMappedRange())[0] = 1;
    this.neutral.unmap();
    this.shadowLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', minBindingSize: 64 },
        },
      ],
    });
  }
  /** Called only during frame preparation. Exact sizing releases unused capacity on
   * scene replacement or disabling shadows; unchanged poses allocate nothing. */
  private resizeMaps(count: number): void {
    if (count === this.capacity) return;
    const resolution = this.values.resolution;
    const bytes = resolution ** 2 * 4 * count;
    if (
      bytes >
        Math.min(
          this.device.limits.maxStorageBufferBindingSize,
          this.device.limits.maxBufferSize,
        ) ||
      (count > 0 && resolution > this.device.limits.maxTextureDimension2D)
    )
      throw new Error('Active shadow maps exceed this device’s resource limits.');
    this.releaseMaps();
    if (!count) return;
    this.samples = this.device.createBuffer({
      label: 'Shadow depth samples',
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.depth = this.device.createTexture({
      label: 'Reusable shadow depth attachment',
      size: [resolution, resolution],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.view = this.depth.createView();
    this.matrices = this.device.createBuffer({
      label: 'Shadow view matrices',
      size: count * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.mapGroups = Array.from({ length: count }, (_, i) =>
      this.device.createBindGroup({
        layout: this.shadowLayout,
        entries: [{ binding: 0, resource: { buffer: this.matrices!, offset: i * 256, size: 64 } }],
      }),
    );
    this.capacity = count;
  }
  private releaseMaps(): void {
    this.samples?.destroy();
    this.depth?.destroy();
    this.matrices?.destroy();
    this.samples = undefined;
    this.depth = undefined;
    this.view = undefined;
    this.matrices = undefined;
    this.mapGroups = [];
    this.capacity = 0;
  }
  setSettings(update: ShadowUpdate): void {
    const next = {
      ...this.values,
      enabled: update.enabled === undefined ? this.values.enabled : update.enabled,
      depthBias: update.depthBias === undefined ? this.values.depthBias : update.depthBias,
      normalBias: update.normalBias === undefined ? this.values.normalBias : update.normalBias,
    };
    if (
      typeof next.enabled !== 'boolean' ||
      !Number.isFinite(next.depthBias) ||
      next.depthBias < 0 ||
      next.depthBias > 0.1 ||
      !Number.isFinite(next.normalBias) ||
      next.normalBias < 0
    )
      throw new Error('Invalid shadow settings.');
    this.values = next;
    this.dirty = true;
  }
  /** Pose upload phase only. Revision keys include actual caster dependencies, not
   * every animated node, and paused/static scenes reuse both records and depth data. */
  update(scene: Scene): void {
    if (this.scene !== scene) {
      this.scene = scene;
      this.dependencies = [];
      this.dirty = true;
    }
    const lightChanged = scene.lights.update();
    const revisions: number[] = [];
    for (const update of scene.updates) {
      // Receiver transforms can also enlarge the fitted scene envelope. Unselected
      // nodes do not appear in these draw records and therefore cannot invalidate maps.
      const deformation = update.deformation?.data;
      if (!deformation?.skinned)
        revisions.push((update.pose ?? scene.pose).nodes[update.node].worldRevision);
      if (deformation) {
        revisions.push(deformation.weightsRevision);
        for (const joint of deformation.activeJoints)
          revisions.push(deformation.jointRevision(joint));
      }
    }
    const changed =
      revisions.length !== this.dependencies.length ||
      revisions.some((revision, i) => revision !== this.dependencies[i]);
    if (!this.dirty && !lightChanged && !changed) return;
    this.dependencies = revisions;
    this.dirty = false;
    const bounds = {
      min: vec3.fromValues(Infinity, Infinity, Infinity),
      max: vec3.fromValues(-Infinity, -Infinity, -Infinity),
    };
    for (const draw of scene.draws)
      for (const box of draw.bounds) {
        vec3.min(bounds.min, bounds.min, box.min);
        vec3.max(bounds.max, bounds.max, box.max);
      }
    this.data.fill(0);
    this.data[0] = scene.lights.instances.length;
    this.data[1] = this.values.resolution;
    this.views = 0;
    let casting = 0;
    const hasCasters = scene.draws.some((draw) => !!draw.shadowPipeline);
    for (const [index, light] of scene.lights.instances.entries()) {
      const offset = 4 + index * 20;
      this.data.set(light.position, offset);
      this.data[offset + 3] = light.type === 'directional' ? 0 : light.type === 'point' ? 1 : 2;
      this.data.set(
        light.color.map((c) => c * light.intensity),
        offset + 4,
      );
      this.data[offset + 7] = light.range;
      this.data.set(light.direction, offset + 8);
      this.data[offset + 11] = 1 / Math.max(Math.cos(light.inner) - Math.cos(light.outer), 0.001);
      this.data[offset + 12] = -Math.cos(light.outer) * this.data[offset + 11];
      this.data[offset + 16] = -1;
      if (hasCasters && this.values.enabled && light.intensity > 0 && casting < maxShadowLights) {
        const maps = shadowMatrices(light, bounds);
        casting++;
        this.data[offset + 16] = this.views;
        this.data[offset + 17] = maps.length;
        this.data[offset + 18] = this.values.depthBias;
        this.data[offset + 19] = this.values.normalBias;
        for (const matrix of maps) {
          this.data.set(matrix, 4 + maxPunctualLights * 20 + this.views * 16);
          this.views++;
        }
      }
    }
    this.resizeMaps(this.views);
    for (let map = 0; map < this.views; map++)
      this.device.queue.writeBuffer(
        this.matrices!,
        map * 256,
        this.data.subarray(
          4 + maxPunctualLights * 20 + map * 16,
          4 + maxPunctualLights * 20 + (map + 1) * 16,
        ),
      );
    this.device.queue.writeBuffer(this.buffer, 0, this.data);
    this.shadowDirty = this.views > 0;
  }
  /** Render phase, after compute. Casters deliberately ignore camera visibleRuns. */
  encode(encoder: GPUCommandEncoder, scene: Scene): void {
    if (!this.shadowDirty) return;
    for (let map = 0; map < this.views; map++) {
      const pass = encoder.beginRenderPass({
        label: `Shadow map ${map}`,
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.view!,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      pass.setBindGroup(0, this.mapGroups[map]);
      pass.setBindGroup(1, scene.instances);
      for (const draw of scene.draws) if (draw.shadowPipeline) submitCaster(pass, draw);
      pass.end();
      const resolution = this.values.resolution;
      encoder.copyTextureToBuffer(
        { texture: this.depth!, aspect: 'depth-only' },
        {
          buffer: this.shadowBuffer,
          offset: map * resolution * resolution * 4,
          bytesPerRow: resolution * 4,
          rowsPerImage: resolution,
        },
        [resolution, resolution],
      );
    }
    this.shadowDirty = false;
  }
  destroy(): void {
    this.buffer.destroy();
    this.releaseMaps();
    this.neutral.destroy();
  }
}
function submitCaster(pass: GPURenderPassEncoder, draw: Draw): void {
  pass.setPipeline(draw.shadowPipeline!);
  pass.setBindGroup(2, draw.material.bindGroup);
  draw.vertices.forEach((vertex, i) => pass.setVertexBuffer(i, vertex.buffer, vertex.offset));
  if (draw.index) {
    pass.setIndexBuffer(draw.index, draw.indexFormat);
    pass.drawIndexed(draw.count, draw.instanceCount, 0, 0, draw.firstInstance);
  } else pass.draw(draw.count, draw.instanceCount, 0, draw.firstInstance);
}
