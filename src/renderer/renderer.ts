import type { Pose } from '../scene/pose';
import { DeviceResources } from './core/device-resources';
import type { Asset } from '../gltf/types';
import type { TransformData, TransformField } from '../scene/transform';
import { OrbitCamera } from '../engine/camera/orbit-camera';
import { validateCameraView, type CameraView } from '../engine/camera/view';
import { Resources } from './core/resources';
import { AnimationController } from '../animation/controller';
import { compressionSupport } from './textures/compression';
import type { TextureCompression } from '../gltf/compression/textures';
import type { OutputSettings, SceneSampleCount } from './presentation/output';
import type { EnvironmentSettings } from './lighting/environment';
import type { EnvironmentImage } from './lighting/source';
import type { Scene, FrameStats, SceneStats } from './scene/types';
import { prepareWorld } from './scene/world-builder';
import type { World } from '../engine/world';
import type { ModelInstance } from '../engine/model';
import type { RenderInstanceHandle } from '../engine/rendering/instance-slots';
import { uploadPose } from './scene/pose-upload';
import { SceneVisibility } from './scene/visibility';
import type { OcclusionStats } from './scene/occlusion';
import { emptyCpuTimings, type CpuTimings } from './core/cpu-timings';
export type { CpuTimings } from './core/cpu-timings';
import { encodeDeformation } from './deformation/pass';
import { encodeScene } from './render/pass';
import type { TransparencyMode } from './render/transparency';
import type {
  ShadowResolution,
  ShadowSettings,
  ShadowUpdate,
  ShadowMemoryStats,
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
  private lost = false;
  private recovery?: Promise<void>;
  private source?: { asset: Asset; options: AssetOptions; pose: Pose };
  private retainedWorld?: World;
  private worldAnimation?: AnimationController;
  get deviceState(): 'ready' | 'lost' | 'recovering' | 'disposed' | 'failed' {
    return this.disposed
      ? 'disposed'
      : this.recovery
        ? 'recovering'
        : this.lost || this.gpu.isLost
          ? 'lost'
          : this.failed
            ? 'failed'
            : 'ready';
  }
  get diagnostics() {
    return {
      deviceState: this.deviceState,
      memory: this.gpu.memory?.snapshot(),
      gpuTimings: this.gpu.gpuTimer?.snapshot,
      gpuTimingSupported: this.gpu.device.features.has('timestamp-query'),
      cpuTimings: this.cpuTimings,
      scene: this.gpu.scene && { ...this.gpu.scene.stats },
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
    const stats = this.gpu.occlusion.stats;
    return this.occlusionEnabled ? stats : { ...stats, queries: 0 };
  }
  get textureCompression(): readonly TextureCompression[] {
    return compressionSupport(this.gpu.device.features);
  }
  /** Default CPU orbit state; input belongs to the viewer adapter. */
  readonly camera = new OrbitCamera();
  get world(): World | undefined {
    return this.retainedWorld;
  }
  get aspectRatio(): number {
    const { width, height } = this.gpu.viewport.size;
    return width / height;
  }
  private assetAnimation = new AnimationController();
  /** Single-asset compatibility; world gameplay normally uses entity.model.animation. */
  get animation(): AnimationController {
    return this.worldAnimation ?? this.assetAnimation;
  }
  private disposed = false;
  private failed = false;
  private visibility = new SceneVisibility();
  get shadowSettings(): Readonly<ShadowSettings> {
    return this.gpu.lighting.settings;
  }
  get shadowMemory(): Readonly<ShadowMemoryStats> {
    return this.gpu.lighting.memoryStats;
  }
  setShadows(settings: ShadowUpdate): void {
    this.gpu.lighting.setSettings(settings);
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
    this.gpu.occlusion.invalidate();
  }
  get scaleCulling(): number {
    return this.minPixels;
  }
  setScaleCulling(minPixels: number): void {
    if (!Number.isFinite(minPixels) || minPixels < 0)
      throw new Error('Scale culling must be a finite nonnegative pixel threshold.');
    this.minPixels = minPixels;
    this.gpu.occlusion.invalidate();
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
    this.gpu.occlusion.invalidate();
  }
  get sampleCount(): SceneSampleCount {
    return this.gpu.output.sampleCount;
  }
  get environmentSettings(): Readonly<EnvironmentSettings> {
    return this.gpu.environment.settings;
  }
  setEnvironment(settings: Partial<EnvironmentSettings>): void {
    this.gpu.environment.setSettings(settings);
  }
  async setEnvironmentMap(image: EnvironmentImage): Promise<void> {
    const retained = { width: image.width, height: image.height, pixels: image.pixels.slice() };
    await this.gpu.environment.setImage(retained);
    this.retainedEnvironment = retained;
  }
  get outputSettings(): Readonly<OutputSettings> {
    return this.gpu.output.settings;
  }
  setOutput(settings: Partial<OutputSettings>): void {
    this.gpu.output.setSettings(settings);
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
    const gpu = await DeviceResources.create(canvas, {
      memoryProfiling: options.memoryProfiling,
      resourceBudgetBytes: options.resourceBudgetBytes,
      gpuProfiling: options.gpuProfiling,
      sampleCount,
      transparency: transparencyMode,
      shadows,
      shadowResolution,
    });
    try {
      const renderer = new Renderer(canvas, onError, gpu);
      renderer.setFrustumCulling(frustumCulling);
      renderer.cpuProfiling = options.cpuProfiling ?? false;
      renderer.setOcclusionCulling(occlusionCulling);
      renderer.setScaleCulling(scaleCulling);
      renderer.options = { ...options };
      renderer.observeDevice(gpu);
      return renderer;
    } catch (error) {
      gpu.destroy();
      throw error;
    }
  }

  private constructor(
    private canvas: HTMLCanvasElement,
    private onError: (message: string) => void,
    private gpu: DeviceResources,
  ) {}
  get transparencyMode(): TransparencyMode {
    return this.gpu.options.transparency;
  }

  private observeDevice(gpu: DeviceResources): void {
    gpu.observe({
      error: (message) => {
        if (!this.disposed && this.gpu === gpu) this.fail(message);
      },
      lost: (message) => {
        if (this.disposed || this.gpu !== gpu) return;
        this.lost = this.failed = true;
        if (this.options.onDeviceLost) this.options.onDeviceLost(message);
        else this.onError(`${message} Call recover() to reconnect.`);
      },
    });
  }

  /** Prepare a replacement fully before swapping. A failed load leaves the current model usable. */
  async setAsset(asset: Asset, options: AssetOptions = {}): Promise<SceneStats> {
    const gpu = this.gpu;
    return this.replaceScene(
      (resources) => gpu.builder.prepare(asset, resources, options),
      (scene) => {
        this.retainedWorld = undefined;
        this.worldAnimation = undefined;
        this.source = {
          asset,
          pose: scene.pose,
          options: { movableNodes: options.movableNodes && [...options.movableNodes] },
        };
      },
    );
  }

  private transformPose(node: number) {
    if (this.disposed || this.failed || !this.gpu.isUsable || !this.gpu.scene)
      throw new Error('No editable scene is attached.');
    if (this.gpu.scene.world) throw new Error('Use entity.model.setNodeTransform() in a world.');
    if (!this.gpu.scene.movableNodes?.has(node))
      throw new Error(
        'Declare the node in setAsset(asset, { movableNodes }) before gameplay movement.',
      );
    return this.gpu.scene.pose;
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
    const gpu = this.gpu;
    return this.replaceScene(
      (resources) =>
        prepareWorld(gpu.device, gpu.bindings, gpu.builder, world, resources, gpu.scene),
      (scene) => {
        this.source = undefined;
        this.retainedWorld = world;
        this.worldAnimation = scene.world?.models[0]?.animation;
      },
    );
  }

  /** Immutable attachment-local handle; its address survives membership commits.
   * Removed instances return undefined, and a reused range receives a new identity. */
  getRenderInstanceHandle(model: ModelInstance): RenderInstanceHandle | undefined {
    return this.disposed || this.failed || !this.gpu.isUsable
      ? undefined
      : this.gpu.scene?.world?.parts.get(model)?.handle;
  }

  /** Explicit engine membership boundary. Requests are serialized with all device
   * preparation; rendering remains independent of gameplay/physics evaluation. */
  async syncWorld(world: World): Promise<SceneStats> {
    return this.setWorld(world);
  }

  private async replaceScene(
    prepare: (resources: Resources) => Promise<Scene>,
    retainSource: (scene: Scene) => void,
  ): Promise<SceneStats> {
    if (this.disposed || this.failed) throw new Error('Renderer is disposed or failed.');
    const gpu = this.gpu;
    return gpu.replaceScene(prepare, (candidate, incremental) => {
      retainSource(candidate);
      if (!incremental && candidate.stats.instances)
        this.camera.frame(candidate.min, candidate.max);
      if (!candidate.world || !candidate.world.models.length)
        this.assetAnimation.setPose(candidate.pose);
    });
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
      if (poseChanged) uploadPose(this.gpu.device, scene);
    }
    this.gpu.viewport.resize();
    if (scene?.transmission.length)
      this.gpu.transmission.resize(this.gpu.viewport.width, this.gpu.viewport.height);
    if (scene?.transparent.length)
      this.gpu.transparency?.resize(this.gpu.viewport.width, this.gpu.viewport.height);
    this.gpu.bindings.uploadCamera(view, this.gpu.viewport.width, this.gpu.viewport.height);
    if (scene) this.gpu.lighting.update(scene);
    if (this.gpu.bindings.refreshLighting()) this.gpu.transmission.refreshLighting();
    // Visibility consumes updated bounds. Query input uploads also finish before
    // encoding; visibility cannot suppress deformation or shadow preparation.
    this.lastFrame.draws = 0;
    this.lastFrame.instances = 0;
    this.lastFrame.culledInstances = 0;
    const uploaded = this.cpuProfiling ? performance.now() : 0;
    if (scene) {
      if (this.occlusionEnabled)
        this.gpu.occlusion.beginFrame(
          scene,
          this.gpu.bindings.frameData,
          this.gpu.viewport.width,
          this.gpu.viewport.height,
          poseChanged,
        );
      this.visibility.update(
        scene,
        this.gpu.bindings.frameData,
        this.cullingEnabled,
        this.lastFrame,
        {
          width: this.gpu.viewport.width,
          height: this.gpu.viewport.height,
          minPixels: this.minPixels,
          occlusion: this.occlusionEnabled ? this.gpu.occlusion : undefined,
        },
      );
      if (this.occlusionEnabled) this.gpu.occlusion.upload();
    }
    if (this.cpuProfiling) {
      this.timings.uploadsMs = uploaded - animated;
      this.timings.visibilityMs = performance.now() - uploaded;
    }
  }

  /** Encode compute, shadows, scene and presentation together, without pose uploads. */
  private encodeFrame(scene: Scene | undefined, view: CameraView): GPUCommandBuffer {
    const encoder = this.gpu.device.createCommandEncoder();
    const finishTiming = this.gpu.gpuTimer?.instrument(encoder);
    // Phase 2: compute consumes uploaded inputs. Paused/static poses reuse their output.
    if (scene) encodeDeformation(encoder, scene);
    // Shadow rendering consumes the same completed deformation output as the color pass.
    if (scene) this.gpu.lighting.encode(encoder, scene);
    // Phase 3: render consumes completed deformation output in the same submission.
    encodeScene(encoder, scene, {
      output: this.gpu.output,
      depth: this.gpu.viewport.depth!,
      frameGroup: this.gpu.bindings.frame,
      environmentGroup: this.gpu.environment.bindGroup,
      camera: view,
      transmission: this.gpu.transmission,
      transparency: this.gpu.transparency,
      occlusion: this.occlusionEnabled ? this.gpu.occlusion : undefined,
    });
    // Presentation follows scene rendering: tone mapping happens once, after all blending.
    this.gpu.output.encode(encoder, this.gpu.context.getCurrentTexture().createView());
    finishTiming?.();
    return encoder.finish();
  }

  /** Submit prepared poses and a CPU camera view. The retained timestamp argument
   * is validated for compatibility; it never advances animation or simulation.
   * No scheduling or GPU waits occur here. False tells the owner to stop rendering
   * after disposal or a fatal frame/device error, reported through onError once. */
  render(timestamp: number, view?: CameraView): boolean {
    if (this.disposed || this.failed || !this.gpu.isUsable) return false;
    if (!Number.isFinite(timestamp)) throw new Error('Frame timestamp must be finite.');
    const start = this.cpuProfiling ? performance.now() : 0;
    const camera = view ?? this.camera.view(this.aspectRatio);
    validateCameraView(camera, this.aspectRatio);
    if (
      this.gpu.scene?.world &&
      this.gpu.scene.world.structureRevision !== this.gpu.scene.world.source.structureRevision
    )
      throw new Error('World membership changed. Await renderer.setWorld(world) before rendering.');
    try {
      const scene = this.gpu.scene;
      if (this.cpuProfiling) Object.assign(this.timings, emptyCpuTimings());
      this.uploadFrame(scene, camera);
      const uploaded = this.cpuProfiling ? performance.now() : 0;
      const commands = this.encodeFrame(scene, camera);
      const encoded = this.cpuProfiling ? performance.now() : 0;
      this.gpu.device.queue.submit([commands]);
      this.gpu.gpuTimer?.afterSubmit();
      if (this.occlusionEnabled) this.gpu.occlusion.afterSubmit();
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
    if ((!this.lost && !this.gpu.isLost) || this.disposed)
      return Promise.reject(new Error('Recovery requires a live facade with a lost device.'));
    this.recovery = this.rebuildDevice().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }
  private async rebuildDevice(): Promise<void> {
    const world = this.world,
      source = this.source;
    const pose = !world ? source?.pose : undefined;
    const animation = this.assetAnimation;
    const output = this.outputSettings,
      environment = this.environmentSettings,
      shadows = this.shadowSettings,
      onChange = this.animation.onChange;
    const previous = this.gpu;
    previous.destroy();
    let candidate: DeviceResources | undefined;
    try {
      candidate = await DeviceResources.create(this.canvas, previous.options);
      candidate.output.setSettings(output);
      candidate.environment.setSettings(environment);
      candidate.lighting.setSettings(shadows);
      if (this.retainedEnvironment) await candidate.environment.setImage(this.retainedEnvironment);
      const gpu = candidate; // Capture the candidate's device throughout preparation.
      if (world)
        await gpu.replaceScene((resources) =>
          prepareWorld(gpu.device, gpu.bindings, gpu.builder, world, resources),
        );
      else if (source)
        await gpu.replaceScene((resources) =>
          gpu.builder.prepare(source.asset, resources, { ...source.options, pose }),
        );
      if (this.disposed) throw new Error('Recovery was disposed.');
      gpu.assertUsable();
      // Swap one coherent owner. Facade/camera identity and all CPU pose/playback
      // state survive; only device caches, bindings, outputs and handles change.
      this.observeDevice(gpu);
      this.gpu = gpu;
      if (!world && source) animation.setClock(animation.state.clock); // Exclude recovery wall time.
      this.animation.onChange = onChange;
      this.lost = this.failed = false;
    } catch (error) {
      candidate?.destroy();
      throw error;
    }
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.gpu.destroy();
    } finally {
      // Drop CPU retention even if a GPU cleanup hook reports an error.
      this.source = undefined;
      this.retainedWorld = undefined;
      this.worldAnimation = undefined;
      this.retainedEnvironment = undefined;
      this.assetAnimation = new AnimationController();
    }
  }
}
