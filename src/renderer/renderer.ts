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
export type { FrameStats, SceneStats } from './scene/types';

export interface RendererOptions {
  /** Fixed at creation because attachments and all scene pipelines must agree. */
  sampleCount?: SceneSampleCount;
  /** Conservative per-instance bounds testing; enabled by default. */
  frustumCulling?: boolean;
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
    const frustumCulling = options.frustumCulling ?? true;
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
    let environment: EnvironmentLighting;
    try {
      output = await OutputPass.create(device, format, sampleCount);
      environment = await EnvironmentLighting.create(device);
    } catch (error) {
      output?.destroy();
      device.destroy();
      throw error;
    }
    const renderer = new Renderer(canvas, device, context, format, onError, output, environment);
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
  ) {
    context.configure({ device, format, alphaMode: 'opaque' });
    const mipmaps = new MipmapGenerator(device);
    this.camera = new OrbitCamera(canvas);
    this.viewport = new Viewport(canvas, device, output);
    this.bindings = new SceneBindings(device, environment.layout);
    this.builder = new SceneBuilder(device, this.bindings, mipmaps, this.sampleCount);
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
    this.bindings.uploadCamera(this.camera, this.viewport.width / this.viewport.height);
    const encoder = this.device.createCommandEncoder();
    // Phase 2: compute consumes uploaded inputs. Paused/static poses reuse their output.
    if (scene) encodeDeformation(encoder, scene);
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
    this.output.destroy();
    this.environment.destroy();
    this.bindings.destroy();
    this.camera.destroy();
    this.context.unconfigure();
    this.device.destroy();
  }
}
