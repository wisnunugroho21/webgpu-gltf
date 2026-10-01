import type { Asset } from '../gltf/types';
import { OrbitCamera } from './camera/orbit-camera';
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
import { uploadPose } from './scene/pose-upload';
import { SceneVisibility } from './scene/visibility';
import { OcclusionCulling } from './scene/occlusion';
import type { OcclusionStats } from './scene/occlusion';
import { emptyCpuTimings, type CpuTimings } from './core/cpu-timings';
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

export interface RendererOptions {
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
  readonly camera: OrbitCamera;
  private readonly assetAnimation = new AnimationController();
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
  setEnvironmentMap(image: EnvironmentImage): Promise<void> {
    return this.environment.setImage(image);
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
      requiredFeatures: compressionRequirements(adapter.features),
    });
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
      renderer.fail(`GPU error: ${event.error.message}`);
    });
    void device.lost.then((info) => {
      if (!renderer.disposed) {
        renderer.fail(`WebGPU device lost: ${info.message || info.reason}. Reload to reconnect.`);
      }
    });
    return renderer;
  }

  private constructor(
    canvas: HTMLCanvasElement,
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
    // Attach input listeners only once all fallible GPU initialization has succeeded.
    this.camera = new OrbitCamera(canvas);
  }

  /** Prepare a replacement fully before swapping. A failed load leaves the current model usable. */
  async setAsset(asset: Asset): Promise<SceneStats> {
    return this.replaceScene((resources) => this.builder.prepare(asset, resources));
  }

  /** Attach an engine world without merging its entities into glTF node definitions.
   * Spawn/destroy changes require another atomic preparation; transforms update per frame. */
  async setWorld(world: World): Promise<SceneStats> {
    return this.replaceScene((resources) =>
      prepareWorld(this.device, this.bindings, this.builder, world, resources),
    );
  }

  private async replaceScene(
    prepare: (resources: Resources) => Promise<Scene>,
  ): Promise<SceneStats> {
    const resources = new Resources();
    let committed = false;
    try {
      return await prepareGpu(
        this.device,
        async () => {
          if (this.disposed || this.failed) throw new Error('Renderer is disposed or failed.');
          return prepare(resources);
        },
        (candidate) => {
          if (this.disposed || this.failed) throw new Error('Renderer is disposed or failed.');
          if (
            candidate.world &&
            candidate.world.source.structureRevision !== candidate.world.structureRevision
          )
            throw new Error('World structure changed during preparation.');
          const previous = this.scene;
          candidate.pose.profiling = this.cpuProfiling;
          for (const model of candidate.world?.models ?? [])
            model.pose.profiling = this.cpuProfiling;
          this.scene = candidate;
          committed = true;
          if (candidate.stats.instances) this.camera.frame(candidate.min, candidate.max);
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

  /** Phase 1 owns CPU state and queue uploads; no command encoder is created here. */
  private uploadFrame(scene: Scene | undefined, timestamp: number): void {
    const start = this.cpuProfiling ? performance.now() : 0;
    let poseChanged = false;
    // Phase 1: sample animation and upload its inputs before encoding any GPU work.
    if (scene) {
      // This list belongs to this frame; paused/held poses must not replay old dispatches.
      scene.pendingDeformations.length = 0;
      if (scene.world) {
        scene.world.source.update(timestamp);
        poseChanged = scene.world.poseRevision !== scene.world.source.poseRevision;
        scene.world.poseRevision = scene.world.source.poseRevision;
      } else poseChanged = this.animation.update(timestamp);
      if (this.cpuProfiling) {
        this.timings.animationMs = performance.now() - start;
        for (const pose of scene.world
          ? scene.world.models.map((model) => model.pose)
          : [scene.pose])
          for (const key of ['mixingMs', 'worldMs', 'sampledNodes', 'visitedNodes'] as const)
            this.timings[key] += pose.timings[key];
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
    this.bindings.uploadCamera(this.camera, this.viewport.width / this.viewport.height);
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
  private encodeFrame(scene: Scene | undefined): GPUCommandBuffer {
    const encoder = this.device.createCommandEncoder();
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
      camera: this.camera,
      transmission: this.transmission,
      transparency: this.transparency,
      occlusion: this.occlusionEnabled ? this.occlusion : undefined,
    });
    // Presentation follows scene rendering: tone mapping happens once, after all blending.
    this.output.encode(encoder, this.context.getCurrentTexture().createView());
    return encoder.finish();
  }

  /** Submit exactly one frame using the caller's clock in milliseconds (for example
   * a RAF timestamp or engine simulation time). Gameplay/physics run before this call.
   * No scheduling or GPU waits occur here. False tells the owner to stop rendering
   * after disposal or a fatal frame/device error, reported through onError once. */
  render(timestamp: number): boolean {
    if (this.disposed || this.failed) return false;
    if (!Number.isFinite(timestamp)) throw new Error('Frame timestamp must be finite.');
    if (
      this.scene?.world &&
      this.scene.world.structureRevision !== this.scene.world.source.structureRevision
    )
      throw new Error('World membership changed. Await renderer.setWorld(world) before rendering.');
    try {
      const scene = this.scene;
      const start = this.cpuProfiling ? performance.now() : 0;
      if (this.cpuProfiling) {
        Object.assign(this.timings, emptyCpuTimings());
        if (scene)
          for (const pose of scene.world
            ? scene.world.models.map((model) => model.pose)
            : [scene.pose])
            Object.assign(pose.timings, {
              mixingMs: 0,
              worldMs: 0,
              sampledNodes: 0,
              visitedNodes: 0,
            });
      }
      this.uploadFrame(scene, timestamp);
      const uploaded = this.cpuProfiling ? performance.now() : 0;
      const commands = this.encodeFrame(scene);
      const encoded = this.cpuProfiling ? performance.now() : 0;
      this.device.queue.submit([commands]);
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
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene?.resources.destroy();
    this.viewport.destroy();
    this.transmission.destroy();
    this.transparency?.destroy();
    this.output.destroy();
    this.environment.destroy();
    this.lighting.destroy();
    this.occlusion.destroy();
    this.bindings.destroy();
    this.camera.destroy();
    this.context.unconfigure();
    this.device.destroy();
  }
}
