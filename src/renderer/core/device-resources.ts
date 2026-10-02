import { SceneBindings } from './bindings';
import { Resources } from './resources';
import { prepareGpu } from './preparation';
import { Viewport } from './viewport';
import { GpuTimer, trackGpuMemory } from './diagnostics';
import { MipmapGenerator } from '../textures/mipmaps';
import { compressionRequirements } from '../textures/compression';
import { OutputPass, type SceneSampleCount } from '../presentation/output';
import { EnvironmentLighting } from '../lighting/environment';
import { OcclusionCulling } from '../scene/occlusion';
import { SceneBuilder } from '../scene/builder';
import type { Scene, SceneStats } from '../scene/types';
import { TransmissionBuffer } from '../render/transmission';
import { TransparencyPass, type TransparencyMode } from '../render/transparency';
import { PunctualLighting, type ShadowResolution } from '../lighting/punctual';

/** Validated device configuration. CPU scheduling, camera and playback stay outside. */
export interface DeviceResourceOptions {
  sampleCount: SceneSampleCount;
  transparency: TransparencyMode;
  shadows: boolean;
  shadowResolution: ShadowResolution;
  memoryProfiling?: boolean;
  resourceBudgetBytes?: number;
  gpuProfiling?: boolean;
}
interface Notifications {
  error(message: string): void;
  lost(message: string): void;
}

/** One device generation, including its scene leases and diagnostic wrappers.
 * Creation rolls back through the same idempotent teardown used for recovery.
 * A replacement is prepared privately, then the facade swaps this owner once. */
export class DeviceResources {
  context!: GPUCanvasContext;
  output!: OutputPass;
  environment!: EnvironmentLighting;
  occlusion!: OcclusionCulling;
  bindings!: SceneBindings;
  viewport!: Viewport;
  transmission!: TransmissionBuffer;
  lighting!: PunctualLighting;
  builder!: SceneBuilder;
  transparency?: TransparencyPass;
  private attachedScene?: Scene;
  get scene(): Scene | undefined {
    return this.attachedScene;
  }
  memory?: ReturnType<typeof trackGpuMemory>;
  gpuTimer?: GpuTimer;
  private disposed = false;
  private error?: string;
  private loss?: string;
  private notifications?: Notifications;

  private constructor(
    readonly device: GPUDevice,
    readonly options: Readonly<DeviceResourceOptions>,
  ) {
    // Watch initialization too: a lost/invalid candidate must never be published.
    device.addEventListener('uncapturederror', this.onError);
    void device.lost.then((info) => {
      if (this.disposed) return;
      this.loss = `WebGPU device lost: ${info.message || info.reason}.`;
      // Allow create() callers to retain the facade before delivering loss.
      queueMicrotask(() => {
        if (!this.disposed) this.notifications?.lost(this.loss!);
      });
    });
  }
  private onError = (event: GPUUncapturedErrorEvent): void => {
    if (this.disposed) return;
    this.error = `GPU error: ${event.error.message}`;
    this.notifications?.error(this.error);
  };

  static async create(
    canvas: HTMLCanvasElement,
    options: DeviceResourceOptions,
  ): Promise<DeviceResources> {
    if (!navigator.gpu)
      throw new Error('WebGPU is unavailable. Use a WebGPU-capable browser on localhost or HTTPS.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available on this device.');
    const device = await adapter.requestDevice({
      requiredFeatures: [
        ...compressionRequirements(adapter.features),
        ...(options.gpuProfiling && adapter.features.has('timestamp-query')
          ? ['timestamp-query' as GPUFeatureName]
          : []),
      ],
    });
    const owner = new DeviceResources(device, Object.freeze({ ...options }));
    try {
      await owner.initialize(canvas);
      owner.assertUsable();
      return owner;
    } catch (error) {
      try {
        owner.destroy();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'GPU initialization and cleanup failed.');
      }
      throw error;
    }
  }

  private async initialize(canvas: HTMLCanvasElement): Promise<void> {
    const { device, options } = this;
    // Install accounting before the first allocation, including startup resources.
    if (options.memoryProfiling || options.resourceBudgetBytes !== undefined)
      this.memory = trackGpuMemory(device, options.resourceBudgetBytes);
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Could not create a WebGPU canvas context.');
    this.context = context;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    this.output = await OutputPass.create(device, format, options.sampleCount);
    if (options.transparency === 'weighted')
      this.transparency = await TransparencyPass.create(device, options.sampleCount);
    this.environment = await EnvironmentLighting.create(device);
    this.occlusion = await OcclusionCulling.create(device, options.sampleCount);
    const mipmaps = new MipmapGenerator(device);
    this.viewport = new Viewport(canvas, device, this.output);
    this.lighting = new PunctualLighting(device, options.shadowResolution, options.shadows);
    this.bindings = new SceneBindings(device, this.environment.layout, this.lighting);
    this.transmission = new TransmissionBuffer(device, this.bindings);
    this.builder = new SceneBuilder(
      device,
      this.bindings,
      mipmaps,
      options.sampleCount,
      options.transparency,
    );
    if (options.gpuProfiling && device.features.has('timestamp-query'))
      this.gpuTimer = new GpuTimer(device);
  }

  /** Facade identity is captured explicitly; disposed/older owners cannot notify it. */
  observe(notifications: Notifications): void {
    this.assertUsable();
    this.notifications = notifications;
  }
  get isLost(): boolean {
    return this.loss !== undefined;
  }
  get isUsable(): boolean {
    return !this.disposed && !this.loss && !this.error;
  }
  assertUsable(): void {
    if (this.disposed || this.loss || this.error)
      throw new Error(this.loss ?? this.error ?? 'GPU resources are disposed.');
  }

  /** Device-local scene transaction. Capture this owner throughout asynchronous
   * preparation so recovery can never mix an old device with new bindings. */
  async replaceScene(
    prepare: (resources: Resources) => Promise<Scene>,
    onCommit?: (scene: Scene, incremental: boolean) => void,
  ): Promise<SceneStats> {
    const resources = new Resources();
    let committed = false;
    try {
      return await prepareGpu(
        this.device,
        async () => {
          this.assertUsable();
          return prepare(resources);
        },
        (candidate) => {
          this.assertUsable();
          if (
            candidate.world &&
            candidate.world.source.structureRevision !== candidate.world.structureRevision
          )
            throw new Error('World structure changed during preparation.');
          const previous = this.scene;
          if (previous === candidate) {
            committed = true;
            resources.destroy();
            return candidate.stats;
          }
          const incremental =
            !!previous?.world && previous.world.source === candidate.world?.source;
          candidate.world?.activate?.();
          if (candidate.world) delete candidate.world.activate;
          this.attachedScene = candidate;
          committed = true;
          this.occlusion.invalidate();
          previous?.resources.destroy();
          // Caller notifications run after ownership commits. A throwing callback
          // must not release the newly attached scene as if preparation had failed.
          onCommit?.(candidate, incremental);
          return candidate.stats;
        },
      );
    } catch (error) {
      if (!committed) resources.destroy();
      throw error;
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.notifications = undefined;
    this.device.removeEventListener('uncapturederror', this.onError);
    const scene = this.scene;
    this.attachedScene = undefined; // Release CPU model/world references with the leases.
    const failures: unknown[] = [];
    // Continue teardown even if one subsystem fails. Optional access also covers
    // partially completed startup; device destruction releases constructor fragments.
    for (const release of [
      () => scene?.resources.destroy(),
      () => this.viewport?.destroy(),
      () => this.transmission?.destroy(),
      () => this.transparency?.destroy(),
      () => this.output?.destroy(),
      () => this.environment?.destroy(),
      () => this.lighting?.destroy(),
      () => this.occlusion?.destroy(),
      () => this.bindings?.destroy(),
      () => this.gpuTimer?.destroy(),
      () => this.memory?.restore(),
      () => this.context?.unconfigure(),
      () => this.device.destroy(),
    ]) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'GPU resource cleanup failed.');
  }
}
