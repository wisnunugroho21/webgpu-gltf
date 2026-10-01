import type { Asset } from '../gltf/types';
import { OrbitCamera } from './camera/orbit-camera';
import { SceneBindings } from './core/bindings';
import { Resources } from './core/resources';
import { Viewport } from './core/viewport';
import { AnimationController } from '../animation/controller';
import { MipmapGenerator } from './textures/mipmaps';
import { OutputPass, type OutputSettings, type SceneSampleCount } from './presentation/output';
import { EnvironmentLighting, type EnvironmentSettings } from './lighting/environment';
import type { EnvironmentImage } from './lighting/source';
import type { Scene, FrameStats, SceneStats } from './scene/types';
import { SceneBuilder } from './scene/builder';
import { uploadPose } from './scene/pose-upload';
import { SceneVisibility } from './scene/visibility';
import { encodeDeformation } from './deformation/pass';
import { encodeScene } from './render/pass';
import { TransmissionBuffer } from './render/transmission';
import { TransparencyPass, type TransparencyMode } from './render/transparency';
import {
  PunctualLighting,
  type ShadowResolution,
  type ShadowSettings,
  type ShadowUpdate,
} from './lighting/punctual';
export type { FrameStats, SceneStats } from './scene/types';

export interface RendererOptions {
  /** Fixed at creation. Weighted OIT avoids primitive sorting; sorted keeps classic OVER. */
  transparency?: TransparencyMode;
  /** Fixed at creation because attachments and all scene pipelines must agree. */
  sampleCount?: SceneSampleCount;
  /** Conservative per-instance bounds testing; enabled by default. */
  frustumCulling?: boolean;
  shadows?: boolean;
  /** Fixed at creation. All shadow maps use this single-sample depth resolution. */
  shadowResolution?: ShadowResolution;
}
export class Renderer {
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
  setShadows(settings: ShadowUpdate): void {
    this.lighting.setSettings(settings);
  }
  private cullingEnabled = true;
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
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    if (!context) {
      device.destroy();
      throw new Error('Could not create a WebGPU canvas context.');
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    let output: OutputPass | undefined;
    let transparency: TransparencyPass | undefined;
    let environment: EnvironmentLighting;
    try {
      output = await OutputPass.create(device, format, sampleCount);
      if (transparencyMode === 'weighted')
        transparency = await TransparencyPass.create(device, sampleCount);
      environment = await EnvironmentLighting.create(device);
    } catch (error) {
      output?.destroy();
      transparency?.destroy();
      device.destroy();
      throw error;
    }
    const renderer = new Renderer(
      canvas,
      device,
      context,
      format,
      onError,
      output,
      environment,
      shadowResolution,
      shadows,
      transparencyMode,
      transparency,
    );
    renderer.setFrustumCulling(frustumCulling);
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
    shadowResolution: ShadowResolution,
    shadows: boolean,
    readonly transparencyMode: TransparencyMode,
    private transparency?: TransparencyPass,
  ) {
    context.configure({ device, format, alphaMode: 'opaque' });
    const mipmaps = new MipmapGenerator(device);
    this.camera = new OrbitCamera(canvas);
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
    this.frameRequest = requestAnimationFrame(this.render);
  }

  /** Prepare a replacement fully before swapping. A failed load leaves the current model usable. */
  async setAsset(asset: Asset): Promise<SceneStats> {
    const resources = new Resources();
    this.device.pushErrorScope('validation');
    let candidate: Scene | undefined;
    let failure: unknown;
    try {
      candidate = await this.builder.prepare(asset, resources);
    } catch (error) {
      failure = error;
    }
    const gpuError = await this.device.popErrorScope();
    if (failure || gpuError || this.disposed) {
      resources.destroy();
      throw failure ?? new Error(gpuError?.message ?? 'Renderer was disposed.');
    }
    const previous = this.scene;
    this.scene = candidate!;
    this.animation.setPose(candidate!.pose);
    this.camera.frame(candidate!.min, candidate!.max);
    previous?.resources.destroy();
    return candidate!.stats;
  }

  private render = (timestamp: number): void => {
    if (this.disposed) return;
    const scene = this.scene;
    // Phase 1: sample animation and upload its inputs before encoding any GPU work.
    if (scene) {
      // This list belongs to this frame; paused/held poses must not replay old dispatches.
      scene.pendingDeformations.length = 0;
      try {
        if (this.animation.update(timestamp)) uploadPose(this.device, scene);
      } catch (error) {
        this.stop();
        this.onError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    this.viewport.resize();
    if (scene?.transmission.length)
      this.transmission.resize(this.viewport.width, this.viewport.height);
    if (scene?.transparent.length)
      this.transparency?.resize(this.viewport.width, this.viewport.height);
    this.bindings.uploadCamera(this.camera, this.viewport.width / this.viewport.height);
    if (scene) this.lighting.update(scene);
    const encoder = this.device.createCommandEncoder();
    // Phase 2: compute consumes uploaded inputs. Paused/static poses reuse their output.
    if (scene) encodeDeformation(encoder, scene);
    // Shadow rendering consumes the same completed deformation output as the color pass.
    if (scene) this.lighting.encode(encoder, scene);
    // Phase 3: render consumes completed deformation output in the same submission.
    this.lastFrame.draws = 0;
    this.lastFrame.instances = 0;
    this.lastFrame.culledInstances = 0;
    if (scene)
      this.visibility.update(scene, this.bindings.frameData, this.cullingEnabled, this.lastFrame);
    encodeScene(encoder, scene, {
      output: this.output,
      depth: this.viewport.depth!,
      frameGroup: this.bindings.frame,
      environmentGroup: this.environment.bindGroup,
      camera: this.camera,
      transmission: this.transmission,
      transparency: this.transparency,
    });
    // Presentation follows scene rendering: tone mapping happens once, after all blending.
    this.output.encode(encoder, this.context.getCurrentTexture().createView());
    this.device.queue.submit([encoder.finish()]);
    this.frameRequest = requestAnimationFrame(this.render);
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
    this.bindings.destroy();
    this.camera.destroy();
    this.context.unconfigure();
    this.device.destroy();
  }
}
