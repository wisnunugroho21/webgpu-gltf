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
import { uploadPose } from './scene/pose-upload';
import { SceneVisibility } from './scene/visibility';
import { OcclusionCulling } from './scene/occlusion';
import type { OcclusionStats } from './scene/occlusion';
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
  get occlusionStats(): Readonly<OcclusionStats> {
    const stats = this.occlusion.stats;
    return this.occlusionEnabled ? stats : { ...stats, queries: 0 };
  }
  get textureCompression(): readonly TextureCompression[] {
    return compressionSupport(this.device.features);
  }
  readonly camera: OrbitCamera;
  readonly animation = new AnimationController();
  private scene?: Scene;
  private bindings: SceneBindings;
  private frameRequest = 0;
  private disposed = false;
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
      renderer.stop();
      onError(`GPU error: ${event.error.message}`);
    });
    void device.lost.then((info) => {
      if (!renderer.disposed) {
        renderer.stop();
        onError(`WebGPU device lost: ${info.message || info.reason}. Reload to reconnect.`);
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
    this.frameRequest = requestAnimationFrame(this.render);
  }

  /** Prepare a replacement fully before swapping. A failed load leaves the current model usable. */
  async setAsset(asset: Asset): Promise<SceneStats> {
    const resources = new Resources();
    let committed = false;
    try {
      return await prepareGpu(
        this.device,
        async () => {
          if (this.disposed) throw new Error('Renderer was disposed.');
          return this.builder.prepare(asset, resources);
        },
        (candidate) => {
          if (this.disposed) throw new Error('Renderer was disposed.');
          const previous = this.scene;
          this.scene = candidate;
          committed = true;
          this.camera.frame(candidate.min, candidate.max);
          this.occlusion.invalidate();
          previous?.resources.destroy();
          // Notify only after the valid scene is committed and old resources released.
          // A caller's notification callback cannot destroy the newly attached scene.
          this.animation.setPose(candidate.pose);
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
    let poseChanged = false;
    // Phase 1: sample animation and upload its inputs before encoding any GPU work.
    if (scene) {
      // This list belongs to this frame; paused/held poses must not replay old dispatches.
      scene.pendingDeformations.length = 0;
      poseChanged = this.animation.update(timestamp);
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

  private render = (timestamp: number): void => {
    if (this.disposed) return;
    try {
      const scene = this.scene;
      this.uploadFrame(scene, timestamp);
      this.device.queue.submit([this.encodeFrame(scene)]);
      if (this.occlusionEnabled) this.occlusion.afterSubmit();
      this.frameRequest = requestAnimationFrame(this.render);
    } catch (error) {
      // Resize, visibility preparation and command encoding can fail too. Stop the
      // loop and surface those errors through the same callback as pose failures.
      this.stop();
      this.onError(error instanceof Error ? error.message : String(error));
    }
  };

  private stop(): void {
    cancelAnimationFrame(this.frameRequest);
  }
  destroy(): void {
    this.disposed = true;
    this.stop();
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
