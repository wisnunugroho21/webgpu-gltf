import type { Asset } from '../gltf/types';
import type { TransformData, TransformField } from '../scene/transform';
import { OrbitCamera } from '../engine/camera/orbit-camera';
import { validateCameraView, type CameraView } from '../engine/camera/view';
import { SceneBindings } from './core/bindings';
import { Resources } from './core/resources';
import { prepareGpu } from './core/preparation';
import { Viewport } from './core/viewport';
import { AnimationController } from '../animation/controller';
import { MipmapGenerator } from './textures/mipmaps';
import { compressionRequirements, compressionSupport } from './textures/compression';
import type { TextureCompression } from '../gltf/compression/textures';
import { OutputPass, type OutputSettings, type SceneSampleCount } from './presentation/output';
import { EnvironmentLighting, type EnvironmentSettings } from './lighting/environment';
import type { EnvironmentImage } from './lighting/source';
import type { Scene, FrameStats, SceneStats } from './scene/types';
import { SceneBuilder } from './scene/builder';
import { prepareWorld } from './scene/world-builder';
import type { World } from '../engine/world';
import type { ModelInstance } from '../engine/model';
import type { RenderInstanceHandle } from '../engine/rendering/instance-slots';
import { uploadPose } from './scene/pose-upload';
import { SceneVisibility } from './scene/visibility';
import { OcclusionCulling } from './scene/occlusion';
import type { OcclusionStats } from './scene/occlusion';
import { emptyCpuTimings, type CpuTimings } from './core/cpu-timings';
import { GpuTimer, trackGpuMemory } from './core/diagnostics';
export type { CpuTimings } from './core/cpu-timings';
import { encodeDeformation } from './deformation/pass';
import { encodeScene } from './render/pass';
import { TransmissionBuffer } from './render/transmission';
import { TransparencyPass, type TransparencyMode } from './render/transparency';
import {
  PunctualLighting,
  type ShadowResolution,
  type ShadowSettings,
  type ShadowUpdate,
  type ShadowMemoryStats,
} from './lighting/punctual';
export type { FrameStats, SceneStats } from './scene/types';

export interface AssetOptions {
  /** Reserve independently mutable draws for these glTF nodes and descendants.
   * Unrelated rigid nodes retain static instance grouping. */
  movableNodes?: readonly number[];
}
export interface RendererOptions {
  /** Requested resource diagnostics include startup. Swapchain/driver memory is excluded. */
  memoryProfiling?: boolean;
  resourceBudgetBytes?: number;
  /** Capability-negotiated pass timestamps; unsupported adapters keep this unavailable. */
  gpuProfiling?: boolean;
  /** Application stops submissions/simulation before awaiting recover(). */
  onDeviceLost?: (message: string) => void;
  /** Opt-in CPU phase wall times; disabled by default to avoid timer overhead. */
  cpuProfiling?: boolean;
  /** Fixed at creation. Weighted OIT avoids primitive sorting; sorted keeps classic OVER. */
  transparency?: TransparencyMode;
  /** Fixed at creation because attachments and all scene pipelines must agree. */
  sampleCount?: SceneSampleCount;
  /** Conservative per-instance bounds testing; enabled by default. */
  frustumCulling?: boolean;
  /** Optional asynchronous opaque-depth queries; disabled by default because queries have a cost. */
  occlusionCulling?: boolean;
  /** Minimum projected AABB size in physical pixels. Zero disables size culling (default). */
  scaleCulling?: number;
  shadows?: boolean;
  /** Fixed at creation. All shadow maps use this single-sample depth resolution. */
  shadowResolution?: ShadowResolution;
}
export class Renderer {
  private options: RendererOptions = {};
  private memory?: ReturnType<typeof trackGpuMemory>;
  private gpuTimer?: GpuTimer;
  private notificationTarget?: Renderer;
  private lost = false;
  private recovery?: Promise<void>;
  private deviceGeneration = 0;
  private source?: { asset: Asset; options: AssetOptions };
  get deviceState(): 'ready' | 'lost' | 'recovering' | 'disposed' | 'failed' {
    return this.disposed
      ? 'disposed'
      : this.recovery
        ? 'recovering'
        : this.lost
          ? 'lost'
          : this.failed
            ? 'failed'
            : 'ready';
  }
  get diagnostics() {
    return {
      deviceState: this.deviceState,
      memory: this.memory?.snapshot(),
      gpuTimings: this.gpuTimer?.snapshot,
      gpuTimingSupported: this.device.features.has('timestamp-query'),
      cpuTimings: this.cpuTimings,
      scene: this.scene && { ...this.scene.stats },
      frame: this.frameStats,
      shadows: this.shadowMemory,
      compression: [...this.textureCompression],
    };
  }
  private cpuProfiling = false;
  private timings = emptyCpuTimings();
  get cpuTimings(): Readonly<CpuTimings> | undefined {
    return this.cpuProfiling ? { ...this.timings } : undefined;
  }
  get occlusionStats(): Readonly<OcclusionStats> {
    const stats = this.occlusion.stats;
    return this.occlusionEnabled ? stats : { ...stats, queries: 0 };
  }
  get textureCompression(): readonly TextureCompression[] {
    return compressionSupport(this.device.features);
  }
  /** Default CPU orbit state; input belongs to the viewer adapter. */
  readonly camera: OrbitCamera;
  get world(): World | undefined {
    return this.scene?.world?.source;
  }
  get aspectRatio(): number {
    const { width, height } = this.viewport.size;
    return width / height;
  }
  private assetAnimation = new AnimationController();
  /** Single-asset compatibility; world gameplay normally uses entity.model.animation. */
  get animation(): AnimationController {
    return this.scene?.world?.models[0]?.animation ?? this.assetAnimation;
  }
  private scene?: Scene;
  private bindings: SceneBindings;
  private disposed = false;
  private failed = false;
  private visibility = new SceneVisibility();
  private builder: SceneBuilder;
  private viewport: Viewport;
  private transmission: TransmissionBuffer;
  private lighting: PunctualLighting;
  get shadowSettings(): Readonly<ShadowSettings> {
    return this.lighting.settings;
  }
  get shadowMemory(): Readonly<ShadowMemoryStats> {
    return this.lighting.memoryStats;
  }
  setShadows(settings: ShadowUpdate): void {
    this.lighting.setSettings(settings);
  }
  private cullingEnabled = true;
  private occlusionEnabled = false;
  private minPixels = 0;
  get occlusionCulling(): boolean {
    return this.occlusionEnabled;
  }
  setOcclusionCulling(enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new Error('Occlusion culling must be a boolean.');
    this.occlusionEnabled = enabled;
    this.occlusion.invalidate();
  }
  get scaleCulling(): number {
    return this.minPixels;
  }
  setScaleCulling(minPixels: number): void {
    if (!Number.isFinite(minPixels) || minPixels < 0)
      throw new Error('Scale culling must be a finite nonnegative pixel threshold.');
    this.minPixels = minPixels;
    this.occlusion.invalidate();
  }
  private lastFrame: FrameStats = { draws: 0, instances: 0, culledInstances: 0 };
  get frameStats(): Readonly<FrameStats> {
    return { ...this.lastFrame };
  }
  get frustumCulling(): boolean {
    return this.cullingEnabled;
  }
  setFrustumCulling(enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new Error('Frustum culling must be a boolean.');
    this.cullingEnabled = enabled;
    this.occlusion.invalidate();
  }
  get sampleCount(): SceneSampleCount {
    return this.output.sampleCount;
  }
  get environmentSettings(): Readonly<EnvironmentSettings> {
    return this.environment.settings;
  }
  setEnvironment(settings: Partial<EnvironmentSettings>): void {
    this.environment.setSettings(settings);
  }
  async setEnvironmentMap(image: EnvironmentImage): Promise<void> {
    const retained = { width: image.width, height: image.height, pixels: image.pixels.slice() };
    await this.environment.setImage(retained);
    this.retainedEnvironment = retained;
  }
  get outputSettings(): Readonly<OutputSettings> {
    return this.output.settings;
  }
  setOutput(settings: Partial<OutputSettings>): void {
    this.output.setSettings(settings);
  }
  // Keep the original public playback API as small delegates for existing consumers.
  get onAnimationChange(): (() => void) | undefined {
    return this.animation.onChange;
  }
  set onAnimationChange(callback: (() => void) | undefined) {
    this.animation.onChange = callback;
  }
  get animationState() {
    return this.animation.state;
  }
  selectAnimation(index: number): void {
    this.animation.select(index);
  }
  setPlaying(playing: boolean): void {
    this.animation.setPlaying(playing);
  }
  seek(time: number): void {
    this.animation.seek(time);
  }

  static async create(
    canvas: HTMLCanvasElement,
    onError: (message: string) => void,
    options: RendererOptions = {},
  ): Promise<Renderer> {
    const sampleCount = options.sampleCount ?? 4;
    if (
      [options.memoryProfiling, options.gpuProfiling].some(
        (value) => value !== undefined && typeof value !== 'boolean',
      ) ||
      (options.resourceBudgetBytes !== undefined &&
        (!Number.isSafeInteger(options.resourceBudgetBytes) || options.resourceBudgetBytes < 1))
    )
      throw new Error('Invalid GPU diagnostic options.');
    if (options.cpuProfiling !== undefined && typeof options.cpuProfiling !== 'boolean')
      throw new Error('CPU profiling must be a boolean.');
    const transparencyMode = options.transparency ?? 'weighted';
    if (transparencyMode !== 'weighted' && transparencyMode !== 'sorted')
      throw new Error('Transparency must be weighted or sorted.');
    const frustumCulling = options.frustumCulling ?? true;
    const occlusionCulling = options.occlusionCulling ?? false;
    const scaleCulling = options.scaleCulling ?? 0;
    if (typeof occlusionCulling !== 'boolean' || !Number.isFinite(scaleCulling) || scaleCulling < 0)
      throw new Error('Invalid occlusion or scale culling options.');
    const shadows = options.shadows ?? true;
    const shadowResolution = options.shadowResolution ?? 512;
    if (typeof shadows !== 'boolean' || ![256, 512, 1024].includes(shadowResolution))
      throw new Error('Invalid shadow options.');
    if (typeof frustumCulling !== 'boolean') throw new Error('Frustum culling must be a boolean.');
    if (sampleCount !== 1 && sampleCount !== 4)
      throw new Error('Scene sample count must be 1 (off) or 4 (MSAA).');
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
    const memory =
      options.memoryProfiling || options.resourceBudgetBytes !== undefined
        ? trackGpuMemory(device, options.resourceBudgetBytes)
        : undefined;
    const context = canvas.getContext('webgpu');
    if (!context) {
      device.destroy();
      throw new Error('Could not create a WebGPU canvas context.');
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    let output: OutputPass | undefined;
    let transparency: TransparencyPass | undefined;
    let environment: EnvironmentLighting | undefined;
    let occlusion: OcclusionCulling | undefined;
    let renderer: Renderer;
    try {
      output = await OutputPass.create(device, format, sampleCount);
      if (transparencyMode === 'weighted')
        transparency = await TransparencyPass.create(device, sampleCount);
      environment = await EnvironmentLighting.create(device);
      occlusion = await OcclusionCulling.create(device, sampleCount);
      renderer = new Renderer(
        canvas,
        device,
        context,
        format,
        onError,
        output,
        environment,
        occlusion,
        shadowResolution,
        shadows,
        transparencyMode,
        transparency,
      );
      renderer.setFrustumCulling(frustumCulling);
      renderer.cpuProfiling = options.cpuProfiling ?? false;
      renderer.setOcclusionCulling(occlusionCulling);
      renderer.setScaleCulling(scaleCulling);
      renderer.options = { ...options };
      renderer.memory = memory;
      if (options.gpuProfiling && device.features.has('timestamp-query'))
        renderer.gpuTimer = new GpuTimer(device);
    } catch (error) {
      output?.destroy();
      transparency?.destroy();
      environment?.destroy();
      occlusion?.destroy();
      context.unconfigure();
      // Device destruction also releases allocations from an interrupted constructor.
      device.destroy();
      throw error;
    }
    device.addEventListener('uncapturederror', (event) => {
      const target = renderer.notificationTarget ?? renderer;
      if (target.device === device) target.fail(`GPU error: ${event.error.message}`);
    });
    void device.lost.then((info) => {
      const target = renderer.notificationTarget ?? renderer;
      if (!target.disposed && target.device === device) {
        target.lost = target.failed = true;
        const message = `WebGPU device lost: ${info.message || info.reason}.`;
        // Notify after create() callers can store the facade. The lost flag already
        // stops submissions; disposal before notification suppresses callbacks.
        queueMicrotask(() => {
          if (target.disposed || target.device !== device) return;
          if (target.options.onDeviceLost) target.options.onDeviceLost(message);
          else target.onError(`${message} Call recover() to reconnect.`);
        });
      }
    });
    return renderer;
  }

  private constructor(
    private canvas: HTMLCanvasElement,
    private device: GPUDevice,
    private context: GPUCanvasContext,
    format: GPUTextureFormat,
    private onError: (message: string) => void,
    private output: OutputPass,
    private environment: EnvironmentLighting,
    private occlusion: OcclusionCulling,
    shadowResolution: ShadowResolution,
    shadows: boolean,
    readonly transparencyMode: TransparencyMode,
    private transparency?: TransparencyPass,
  ) {
    context.configure({ device, format, alphaMode: 'opaque' });
    const mipmaps = new MipmapGenerator(device);
    this.viewport = new Viewport(canvas, device, output);
    this.lighting = new PunctualLighting(device, shadowResolution, shadows);
    this.bindings = new SceneBindings(device, environment.layout, this.lighting);
    this.transmission = new TransmissionBuffer(device, this.bindings);
    this.builder = new SceneBuilder(
      device,
      this.bindings,
      mipmaps,
      this.sampleCount,
      transparencyMode,
    );
    this.camera = new OrbitCamera();
  }

  /** Prepare a replacement fully before swapping. A failed load leaves the current model usable. */
  async setAsset(asset: Asset, options: AssetOptions = {}): Promise<SceneStats> {
    const stats = await this.replaceScene((resources) =>
      this.builder.prepare(asset, resources, options),
    );
    this.source = {
      asset,
      options: { movableNodes: options.movableNodes && [...options.movableNodes] },
    };
    return stats;
  }

  private transformPose(node: number) {
    if (this.disposed || this.failed || !this.scene)
      throw new Error('No editable scene is attached.');
    if (this.scene.world) throw new Error('Use entity.model.setNodeTransform() in a world.');
    if (!this.scene.movableNodes?.has(node))
      throw new Error(
        'Declare the node in setAsset(asset, { movableNodes }) before gameplay movement.',
      );
    return this.scene.pose;
  }
  getNodeTransform(node: number): TransformData {
    return this.transformPose(node).getNodeTransform(node);
  }
  setNodeTransform(node: number, patch: Partial<TransformData>): boolean {
    return this.transformPose(node).setNodeTransform(node, patch);
  }
  clearNodeTransform(node: number): boolean {
    return this.transformPose(node).clearNodeTransform(node);
  }
  getNodeOverride(node: number): Partial<TransformData> {
    return this.transformPose(node).getNodeOverride(node);
  }
  setNodeOverride(node: number, patch: Partial<TransformData>): boolean {
    return this.transformPose(node).setNodeTransform(node, patch);
  }
  clearNodeOverride(node: number, fields?: readonly TransformField[]): boolean {
    return this.transformPose(node).clearNodeTransform(node, fields);
  }

  /** Attach an engine world without merging its entities into glTF node definitions.
   * Same-world calls synchronize membership without recreating surviving instances. */
  async setWorld(world: World): Promise<SceneStats> {
    const stats = await this.replaceScene((resources) =>
      prepareWorld(this.device, this.bindings, this.builder, world, resources, this.scene),
    );
    this.source = undefined;
    return stats;
  }

  /** Immutable attachment-local handle; its address survives membership commits.
   * Removed instances return undefined, and a reused range receives a new identity. */
  getRenderInstanceHandle(model: ModelInstance): RenderInstanceHandle | undefined {
    return this.disposed || this.failed ? undefined : this.scene?.world?.parts.get(model)?.handle;
  }

  /** Explicit engine membership boundary. Requests are serialized with all device
   * preparation; rendering remains independent of gameplay/physics evaluation. */
  async syncWorld(world: World): Promise<SceneStats> {
    return this.setWorld(world);
  }

  private async replaceScene(
    prepare: (resources: Resources) => Promise<Scene>,
  ): Promise<SceneStats> {
    const resources = new Resources();
    const generation = this.deviceGeneration;
    let committed = false;
    try {
      return await prepareGpu(
        this.device,
        async () => {
          if (this.disposed || this.failed || generation !== this.deviceGeneration)
            throw new Error('Renderer is disposed or failed.');
          return prepare(resources);
        },
        (candidate) => {
          if (this.disposed || this.failed || generation !== this.deviceGeneration)
            throw new Error('Renderer is disposed or failed.');
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
          const incremental = previous?.world && previous.world.source === candidate.world?.source;
          candidate.world?.activate?.();
          if (candidate.world) delete candidate.world.activate;
          this.scene = candidate;
          committed = true;
          if (!incremental && candidate.stats.instances)
            this.camera.frame(candidate.min, candidate.max);
          this.occlusion.invalidate();
          previous?.resources.destroy();
          // Notify only after the valid scene is committed and old resources released.
          // A caller's notification callback cannot destroy the newly attached scene.
          if (!candidate.world || !candidate.world.models.length)
            this.assetAnimation.setPose(candidate.pose);
          return candidate.stats;
        },
      );
    } catch (error) {
      if (!committed) resources.destroy();
      throw error;
    }
  }

  /** Pose-upload phase consumes evaluated CPU revisions; no simulation or encoder. */
  private uploadFrame(scene: Scene | undefined, view: CameraView): void {
    let poseChanged = false;
    if (scene) {
      scene.pendingDeformations.length = 0;
      if (scene.world) {
        // Compare each pose, not a World's aggregate update revision. Explicit
        // overrides and skipped frames stay dirty until this consumer uploads.
        const revisions = scene.world.models.map((model) => model.pose.revision);
        poseChanged = revisions.some(
          (revision, index) => revision !== scene.world!.uploadedPoseRevisions?.[index],
        );
        scene.world.uploadedPoseRevisions = revisions;
      } else {
        poseChanged = scene.poseRevision !== scene.pose.revision;
        scene.poseRevision = scene.pose.revision;
      }
    }
    const animated = this.cpuProfiling ? performance.now() : 0;
    if (scene) {
      if (poseChanged) uploadPose(this.device, scene);
    }
    this.viewport.resize();
    if (scene?.transmission.length)
      this.transmission.resize(this.viewport.width, this.viewport.height);
    if (scene?.transparent.length)
      this.transparency?.resize(this.viewport.width, this.viewport.height);
    this.bindings.uploadCamera(view, this.viewport.width, this.viewport.height);
    if (scene) this.lighting.update(scene);
    if (this.bindings.refreshLighting()) this.transmission.refreshLighting();
    // Visibility consumes updated bounds. Query input uploads also finish before
    // encoding; visibility cannot suppress deformation or shadow preparation.
    this.lastFrame.draws = 0;
    this.lastFrame.instances = 0;
    this.lastFrame.culledInstances = 0;
    const uploaded = this.cpuProfiling ? performance.now() : 0;
    if (scene) {
      if (this.occlusionEnabled)
        this.occlusion.beginFrame(
          scene,
          this.bindings.frameData,
          this.viewport.width,
          this.viewport.height,
          poseChanged,
        );
      this.visibility.update(scene, this.bindings.frameData, this.cullingEnabled, this.lastFrame, {
        width: this.viewport.width,
        height: this.viewport.height,
        minPixels: this.minPixels,
        occlusion: this.occlusionEnabled ? this.occlusion : undefined,
      });
      if (this.occlusionEnabled) this.occlusion.upload();
    }
    if (this.cpuProfiling) {
      this.timings.uploadsMs = uploaded - animated;
      this.timings.visibilityMs = performance.now() - uploaded;
    }
  }

  /** Encode compute, shadows, scene and presentation together, without pose uploads. */
  private encodeFrame(scene: Scene | undefined, view: CameraView): GPUCommandBuffer {
    const encoder = this.device.createCommandEncoder();
    const finishTiming = this.gpuTimer?.instrument(encoder);
    // Phase 2: compute consumes uploaded inputs. Paused/static poses reuse their output.
    if (scene) encodeDeformation(encoder, scene);
    // Shadow rendering consumes the same completed deformation output as the color pass.
    if (scene) this.lighting.encode(encoder, scene);
    // Phase 3: render consumes completed deformation output in the same submission.
    encodeScene(encoder, scene, {
      output: this.output,
      depth: this.viewport.depth!,
      frameGroup: this.bindings.frame,
      environmentGroup: this.environment.bindGroup,
      camera: view,
      transmission: this.transmission,
      transparency: this.transparency,
      occlusion: this.occlusionEnabled ? this.occlusion : undefined,
    });
    // Presentation follows scene rendering: tone mapping happens once, after all blending.
    this.output.encode(encoder, this.context.getCurrentTexture().createView());
    finishTiming?.();
    return encoder.finish();
  }

  /** Submit prepared poses and a CPU camera view. The retained timestamp argument
   * is validated for compatibility; it never advances animation or simulation.
   * No scheduling or GPU waits occur here. False tells the owner to stop rendering
   * after disposal or a fatal frame/device error, reported through onError once. */
  render(timestamp: number, view?: CameraView): boolean {
    if (this.disposed || this.failed) return false;
    if (!Number.isFinite(timestamp)) throw new Error('Frame timestamp must be finite.');
    const start = this.cpuProfiling ? performance.now() : 0;
    const camera = view ?? this.camera.view(this.aspectRatio);
    validateCameraView(camera, this.aspectRatio);
    if (
      this.scene?.world &&
      this.scene.world.structureRevision !== this.scene.world.source.structureRevision
    )
      throw new Error('World membership changed. Await renderer.setWorld(world) before rendering.');
    try {
      const scene = this.scene;
      if (this.cpuProfiling) Object.assign(this.timings, emptyCpuTimings());
      this.uploadFrame(scene, camera);
      const uploaded = this.cpuProfiling ? performance.now() : 0;
      const commands = this.encodeFrame(scene, camera);
      const encoded = this.cpuProfiling ? performance.now() : 0;
      this.device.queue.submit([commands]);
      this.gpuTimer?.afterSubmit();
      if (this.occlusionEnabled) this.occlusion.afterSubmit();
      if (this.cpuProfiling) {
        const submitted = performance.now();
        this.timings.encodingMs = encoded - uploaded;
        this.timings.submissionMs = submitted - encoded;
        this.timings.totalMs = submitted - start;
      }
      return true;
    } catch (error) {
      // Resize, visibility preparation and command encoding can fail too. Stop the
      // renderer and surface errors through the same callback as pose failures.
      this.fail(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private fail(message: string): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.onError(message);
  }
  private retainedEnvironment?: EnvironmentImage;
  /** Deliberate, serialized device reconstruction. The owner pauses its loop first.
   * Keep CPU world/poses; all device caches, handles, visibility readbacks and outputs
   * are newly prepared. A failed attempt remains lost and can be retried explicitly. */
  recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (!this.lost || this.disposed)
      return Promise.reject(new Error('Recovery requires a live facade with a lost device.'));
    this.recovery = this.rebuildDevice().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }
  private async rebuildDevice(): Promise<void> {
    const world = this.world,
      source = this.source;
    const pose = !world ? this.scene?.pose : undefined;
    const animation = this.assetAnimation;
    const output = this.outputSettings,
      environment = this.environmentSettings,
      shadows = this.shadowSettings,
      onChange = this.animation.onChange;
    const settings: RendererOptions = {
      ...this.options,
      frustumCulling: this.frustumCulling,
      occlusionCulling: this.occlusionCulling,
      scaleCulling: this.scaleCulling,
    };
    this.deviceGeneration++;
    this.releaseDevice();
    let replacement: Renderer | undefined;
    try {
      replacement = await Renderer.create(this.canvas, this.onError, settings);
      replacement.setOutput(output);
      replacement.setEnvironment(environment);
      replacement.setShadows(shadows);
      if (this.retainedEnvironment) await replacement.setEnvironmentMap(this.retainedEnvironment);
      if (world) await replacement.setWorld(world);
      else if (source) {
        // Reuse the already evaluated CPU pose, just like world model instances.
        // Recovery uploads current state without evaluating animation in the renderer.
        await replacement.replaceScene((resources) =>
          replacement!.builder.prepare(source.asset, resources, { ...source.options, pose }),
        );
        replacement.assetAnimation = animation;
        animation.setClock(animation.state.clock); // Exclude recovery wall time.
      }
      if (this.disposed || replacement.failed || replacement.lost)
        throw new Error('Recovery was disposed or replacement GPU device failed.');
      // Keep this facade/camera identity so viewer controls remain attached. Move
      // only device-owned implementation state; late callbacks route to this owner.
      this.device = replacement.device;
      this.context = replacement.context;
      this.output = replacement.output;
      this.environment = replacement.environment;
      this.occlusion = replacement.occlusion;
      this.bindings = replacement.bindings;
      this.viewport = replacement.viewport;
      this.transmission = replacement.transmission;
      this.lighting = replacement.lighting;
      this.transparency = replacement.transparency;
      this.builder = replacement.builder;
      this.scene = replacement.scene;
      this.memory = replacement.memory;
      this.gpuTimer = replacement.gpuTimer;
      this.assetAnimation = replacement.assetAnimation;
      this.animation.onChange = onChange;
      replacement.notificationTarget = this;
      this.lost = this.failed = false;
    } catch (error) {
      replacement?.destroy();
      throw error;
    }
  }
  private releaseDevice(): void {
    this.scene?.resources.destroy();
    this.viewport.destroy();
    this.transmission.destroy();
    this.transparency?.destroy();
    this.output.destroy();
    this.environment.destroy();
    this.lighting.destroy();
    this.occlusion.destroy();
    this.bindings.destroy();
    this.gpuTimer?.destroy();
    this.memory?.restore();
    this.context.unconfigure();
    this.device.destroy();
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseDevice();
  }
}
